import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

/**
 * Governed import for the Babalawo 90-second production proof.
 *
 * Default mode is read-only:
 *   bun run scripts/import-babalawo-production-proof.ts
 *
 * Database write mode:
 *   BABALAWO_MEDIA_ACTOR_EMAIL=admin@example.com \
 *     bun run scripts/import-babalawo-production-proof.ts --write
 *
 * Optional proof publication, still NOT runtime-enabled:
 *   BABALAWO_MEDIA_ACTOR_EMAIL=admin@example.com \
 *     bun run scripts/import-babalawo-production-proof.ts --publish-proof
 *
 * The source file remains outside /public. The imported copy goes
 * through the private governed media storage provider under a
 * server-generated key. This script deliberately does not attach the
 * proof to any user's Prayer Room upload row and does not enable it for
 * runtime selection: the visible KlingAI watermark makes it a
 * PRODUCTION_PROOF / MASTER_BASELINE, not final public production.
 */

const DEFAULT_SOURCE =
  'BABALAWO_90S/final/BABALAWO_PRAYER_ROOM_90S_MASTER_V2.mp4'
const HOUSE_CODE = 'ILE_AWON_BABALAWO'
const MEDIA_ASSET_CODE = 'ILE_AWON_BABALAWO_PRAYER_ROOM_PROOF'
const THEME_CODE = 'PRODUCTION_PROOF'
const EXPECTED_SHA256 =
  'c132ca0a7f4c3b547fc17175586f241d50146e7e161ae0fb4d974337c071c2c3'
const EXPECTED_DURATION_MS = 76_267
const EXPECTED_WIDTH = 1280
const EXPECTED_HEIGHT = 720
const DURATION_TOLERANCE_MS = 250
const PROBE_TIMEOUT_MS = 30_000
const RIGHTS_NOTE =
  'PRODUCTION_PROOF / MASTER_BASELINE; visible KlingAI watermark retained; controlled proof only, not final public media. Add the watermark-free master as a new version under this same asset code.'

interface CliOptions {
  inspectDb: boolean
  publishProof: boolean
  sourcePath: string
  write: boolean
}

interface VideoProbe {
  durationMs: number
  formatName: string
  hasAudio: boolean
  hasVideo: boolean
  width: number
  height: number
}

interface SourceFacts {
  absolutePath: string
  byteSize: number
  sha256: string
  probe: VideoProbe
  bytes: Uint8Array
}

const WORKING_STATUSES = new Set(['DRAFT', 'UNDER_REVIEW', 'APPROVED'])

function parseOptions(argv: Array<string>): CliOptions | null {
  if (argv.includes('--help') || argv.includes('-h')) return null
  const sourceIndex = argv.indexOf('--source')
  const sourcePath =
    sourceIndex === -1 ? DEFAULT_SOURCE : (argv[sourceIndex + 1] ?? '')
  if (sourcePath.trim() === '' || sourcePath.startsWith('--')) {
    throw new Error('--source requires a file path')
  }
  const publishProof = argv.includes('--publish-proof')
  return {
    inspectDb:
      argv.includes('--inspect-db') || publishProof || argv.includes('--write'),
    publishProof,
    sourcePath,
    write: publishProof || argv.includes('--write'),
  }
}

function printUsage(): void {
  console.log(`Babalawo production-proof import

Usage:
  bun run scripts/import-babalawo-production-proof.ts [--inspect-db]
  bun run scripts/import-babalawo-production-proof.ts --write
  bun run scripts/import-babalawo-production-proof.ts --publish-proof
  bun run scripts/import-babalawo-production-proof.ts --source <path> --write

Required for write modes:
  BABALAWO_MEDIA_ACTOR_EMAIL must name an existing ACTIVE user.

Modes:
  default         Verify the MP4 and show the planned governed binding.
  --inspect-db   Also inspect the configured database for the binding.
  --write        Import as a governed DRAFT in private media storage.
  --publish-proof
                  Submit, approve and publish the proof version for staff
                  review surfaces only. Rights stay pending and runtime stays
                  disabled because this watermarked proof is not final public
                  production.`)
}

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (
    /Failed query:|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|Access denied|ER_NO_SUCH_TABLE/i.test(
      message,
    )
  ) {
    return 'database operation failed; verify database connection, migrations, and seed data'
  }
  return message
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function loadSourceFacts(sourcePath: string): Promise<SourceFacts> {
  const absolutePath = resolve(sourcePath)
  const [bytes, stats] = await Promise.all([
    readFile(absolutePath),
    stat(absolutePath),
  ])
  assert(stats.isFile(), 'source path is not a file')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  assert(
    sha256 === EXPECTED_SHA256,
    `source SHA-256 mismatch: expected ${EXPECTED_SHA256}, found ${sha256}`,
  )
  const probe = await probeVideo(absolutePath)
  assert(probe.hasAudio, 'source MP4 has no audio stream')
  assert(probe.hasVideo, 'source MP4 has no video stream')
  assert(
    probe.width === EXPECTED_WIDTH && probe.height === EXPECTED_HEIGHT,
    `source dimensions mismatch: expected ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}, found ${probe.width}x${probe.height}`,
  )
  assert(
    Math.abs(probe.durationMs - EXPECTED_DURATION_MS) <= DURATION_TOLERANCE_MS,
    `source duration mismatch: expected about ${EXPECTED_DURATION_MS} ms, found ${probe.durationMs} ms`,
  )
  return {
    absolutePath,
    byteSize: stats.size,
    sha256,
    probe,
    bytes,
  }
}

async function probeVideo(filePath: string): Promise<VideoProbe> {
  const stdout = await runFfprobe(filePath)
  let parsed: {
    format?: { duration?: string; format_name?: string }
    streams?: Array<{
      codec_type?: string
      width?: number
      height?: number
    }>
  }
  try {
    parsed = JSON.parse(stdout) as typeof parsed
  } catch {
    throw new Error('ffprobe returned unparseable JSON')
  }
  const streams = parsed.streams ?? []
  const video = streams.find((stream) => stream.codec_type === 'video')
  const seconds = Number(parsed.format?.duration)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('ffprobe did not report a usable duration')
  }
  return {
    durationMs: Math.round(seconds * 1000),
    formatName: parsed.format?.format_name ?? '',
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
    hasVideo: video != null,
    width: Number(video?.width ?? 0),
    height: Number(video?.height ?? 0),
  }
}

function runFfprobe(filePath: string): Promise<string> {
  const ffprobe =
    process.env.FFPROBE_PATH?.trim() === '' || process.env.FFPROBE_PATH == null
      ? 'ffprobe'
      : process.env.FFPROBE_PATH
  return new Promise<string>((resolveOutput, rejectOutput) => {
    const child = spawn(
      ffprobe,
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(() => rejectOutput(new Error('ffprobe timed out')))
    }, PROBE_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', () => undefined)
    child.on('error', (error) => {
      finish(() => rejectOutput(error))
    })
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) resolveOutput(stdout)
        else rejectOutput(new Error('ffprobe failed'))
      })
    })
  })
}

function printSourceFacts(facts: SourceFacts): void {
  console.log('Babalawo production-proof source verified.')
  console.log(`  path: ${facts.absolutePath}`)
  console.log(`  bytes: ${facts.byteSize}`)
  console.log(`  sha256: ${facts.sha256}`)
  console.log(
    `  media: ${facts.probe.width}x${facts.probe.height}, ${facts.probe.durationMs} ms, audio=${facts.probe.hasAudio}, video=${facts.probe.hasVideo}`,
  )
  console.log(`  classification: PRODUCTION_PROOF / MASTER_BASELINE`)
  console.log('  watermark: visible KlingAI watermark retained')
  console.log(`  governed asset code: ${MEDIA_ASSET_CODE}`)
}

async function runDatabase(
  options: CliOptions,
  facts: SourceFacts,
): Promise<void> {
  const [{ closeDb, getDb }, schema, orm, rbac, media, mediaStorage] =
    await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('drizzle-orm'),
      import('@/auth/rbac'),
      import('@/services/media-assets'),
      import('@/providers/media/storage'),
    ])
  const db = getDb()
  try {
    const house = (
      await db
        .select()
        .from(schema.sacredHouses)
        .where(orm.eq(schema.sacredHouses.code, HOUSE_CODE))
        .limit(1)
    ).at(0)
    assert(house, `Sacred House ${HOUSE_CODE} is not present in this database`)

    let asset = (
      await db
        .select()
        .from(schema.mediaAssets)
        .where(orm.eq(schema.mediaAssets.code, MEDIA_ASSET_CODE))
        .limit(1)
    ).at(0)

    if (!options.write) {
      await printExistingBinding(db, schema, orm, asset?.id ?? null)
      return
    }

    const actor = await resolveActor(db, schema, orm)
    const requiredPermissions = options.publishProof
      ? [
          'media.manage',
          'media.approve',
          'media.publish',
          'media.rights_manage',
        ]
      : ['media.manage']
    const permissions = new Set(await rbac.getUserPermissionCodes(actor.id))
    const missing = requiredPermissions.filter((code) => !permissions.has(code))
    assert(
      missing.length === 0,
      `actor is missing required permission(s): ${missing.join(', ')}`,
    )

    const ctx = {
      ipAddress: null,
      userAgent: `babalawo-production-proof-import/${new Date().toISOString()}`,
    }

    if (asset) {
      assert(
        asset.assetKind === 'VIDEO' &&
          asset.scopeType === 'SACRED_HOUSE' &&
          asset.sacredHouseId === house.id &&
          asset.serviceId == null &&
          asset.contentType === 'PRAYER' &&
          asset.themeCode === THEME_CODE,
        `${MEDIA_ASSET_CODE} exists but does not match the required governed shape`,
      )
    } else {
      const created = await media.createMediaAsset(actor.id, ctx, {
        code: MEDIA_ASSET_CODE,
        assetKind: 'VIDEO',
        scopeType: 'SACRED_HOUSE',
        sacredHouseId: house.id,
        serviceId: null,
        contentType: 'PRAYER',
        themeCode: THEME_CODE,
      })
      asset = (
        await db
          .select()
          .from(schema.mediaAssets)
          .where(orm.eq(schema.mediaAssets.id, created.id))
          .limit(1)
      ).at(0)
      assert(asset, 'created media asset could not be reloaded')
      console.log(
        `Created governed media asset ${MEDIA_ASSET_CODE} (#${asset.id}).`,
      )
    }

    const versions = await db
      .select()
      .from(schema.mediaAssetVersions)
      .where(orm.eq(schema.mediaAssetVersions.assetId, asset.id))
    let version = versions.find((row) => row.fileSha256 === facts.sha256)

    if (!version) {
      const working = versions.find((row) => WORKING_STATUSES.has(row.status))
      if (working) {
        throw new Error(
          `asset already has a non-published working version (#${working.id}, ${working.status}); finish or archive it before importing a replacement`,
        )
      }
      const created = await media.createMediaVersion(
        actor.id,
        ctx,
        asset.id,
        facts.bytes,
        'video/mp4',
        {
          sourceType: 'KLING_GENERATED',
          language: 'yo',
          durationSeconds: Math.round(facts.probe.durationMs / 1000),
          width: facts.probe.width,
          height: facts.probe.height,
          containsIdentifiablePerson: true,
          consentStatus: 'PENDING',
          consentReference: null,
          externalAiPolicy: 'NO_EXTERNAL_AI',
          voiceCloneAuthorized: false,
        },
      )
      version = await media.loadMediaVersion(created.id)
      console.log(
        `Imported private media version #${version.id} as v${version.versionNumber}.`,
      )
    } else {
      console.log(
        `Matching private media version already exists: #${version.id} v${version.versionNumber}.`,
      )
    }

    await verifyStoredVersion(mediaStorage.getMediaStorage(), version)

    if (options.publishProof) {
      await publishControlledProof(actor.id, ctx, version.id, media)
      version = await media.loadMediaVersion(version.id)
      if (version.runtimeEnabled) {
        await media.setMediaRuntimeEnabled(actor.id, ctx, version.id, false)
        version = await media.loadMediaVersion(version.id)
      }
    }

    console.log('Governed binding ready.')
    console.log(`  asset id: ${asset.id}`)
    console.log(`  version id: ${version.id}`)
    console.log(`  version status: ${version.status}`)
    console.log(`  rights status: ${version.rightsStatus}`)
    console.log(`  consent status: ${version.consentStatus}`)
    console.log(`  runtime enabled: ${version.runtimeEnabled}`)
    console.log(`  private media storage key: ${version.storageKey}`)
  } finally {
    await closeDb()
  }
}

async function printExistingBinding(
  db: ReturnType<(typeof import('@/db'))['getDb']>,
  schema: typeof import('@/db/schema'),
  orm: typeof import('drizzle-orm'),
  assetId: number | null,
): Promise<void> {
  if (assetId == null) {
    console.log('Database binding: no governed proof asset exists yet.')
    return
  }
  const versions = await db
    .select()
    .from(schema.mediaAssetVersions)
    .where(orm.eq(schema.mediaAssetVersions.assetId, assetId))
  const matching = versions.find((row) => row.fileSha256 === EXPECTED_SHA256)
  console.log(`Database binding: asset #${assetId} exists.`)
  if (!matching) {
    console.log('  expected proof hash is not imported under this asset.')
    return
  }
  console.log(`  matching version: #${matching.id} v${matching.versionNumber}`)
  console.log(`  status: ${matching.status}`)
  console.log(`  rights status: ${matching.rightsStatus}`)
  console.log(`  consent status: ${matching.consentStatus}`)
  console.log(`  runtime enabled: ${matching.runtimeEnabled}`)
  console.log(`  private media storage key: ${matching.storageKey}`)
}

async function resolveActor(
  db: ReturnType<(typeof import('@/db'))['getDb']>,
  schema: typeof import('@/db/schema'),
  orm: typeof import('drizzle-orm'),
): Promise<{ id: number; email: string }> {
  const email = process.env.BABALAWO_MEDIA_ACTOR_EMAIL?.trim().toLowerCase()
  assert(email, 'BABALAWO_MEDIA_ACTOR_EMAIL is required for write modes')
  const actor = (
    await db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        accountStatus: schema.users.accountStatus,
      })
      .from(schema.users)
      .where(orm.eq(schema.users.email, email))
      .limit(1)
  ).at(0)
  assert(actor, 'BABALAWO_MEDIA_ACTOR_EMAIL does not match an existing user')
  assert(actor.accountStatus === 'ACTIVE', 'media import actor is not ACTIVE')
  return { id: actor.id, email: actor.email }
}

async function verifyStoredVersion(
  storage: Awaited<
    ReturnType<(typeof import('@/providers/media/storage'))['getMediaStorage']>
  >,
  version: Awaited<
    ReturnType<(typeof import('@/services/media-assets'))['loadMediaVersion']>
  >,
): Promise<void> {
  const stored = await storage.get(version.storageKey)
  assert(stored != null && stored.length > 0, 'stored private media is missing')
  const storedSha256 = createHash('sha256').update(stored).digest('hex')
  assert(
    storedSha256 === version.fileSha256,
    'stored private media no longer matches its database hash',
  )
}

async function publishControlledProof(
  actorId: number,
  ctx: { ipAddress: string | null; userAgent: string | null },
  versionId: number,
  media: typeof import('@/services/media-assets'),
): Promise<void> {
  let version = await media.loadMediaVersion(versionId)
  if (version.status === 'DRAFT') {
    await media.submitMediaVersion(actorId, ctx, versionId)
    version = await media.loadMediaVersion(versionId)
  }
  if (version.status === 'UNDER_REVIEW') {
    await media.approveMediaVersion(actorId, ctx, versionId)
    version = await media.loadMediaVersion(versionId)
  }
  if (version.status === 'APPROVED') {
    await media.publishMediaVersion(actorId, ctx, versionId)
    version = await media.loadMediaVersion(versionId)
  }
  assert(
    version.status === 'PUBLISHED',
    `proof version cannot be published from current status ${version.status}`,
  )

  if (version.rightsStatus === 'UNREVIEWED') {
    await media.setMediaRightsStatus(
      actorId,
      ctx,
      versionId,
      'PENDING_REVIEW',
      RIGHTS_NOTE,
    )
  } else if (
    version.rightsStatus !== 'PENDING_REVIEW' &&
    version.rightsStatus !== 'CLEARED'
  ) {
    throw new Error(
      `proof version rights are ${version.rightsStatus}; refusing to publish a restricted or withdrawn proof`,
    )
  }
}

try {
  const options = parseOptions(process.argv.slice(2))
  if (!options) {
    printUsage()
  } else {
    const facts = await loadSourceFacts(options.sourcePath)
    printSourceFacts(facts)
    if (options.inspectDb) {
      await runDatabase(options, facts)
    } else {
      console.log('Database binding: skipped (read-only source check).')
    }
  }
} catch (error) {
  console.error(`[babalawo-proof] FAILED: ${describeFailure(error)}`)
  process.exitCode = 1
}
