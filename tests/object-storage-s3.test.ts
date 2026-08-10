import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'

import {
  createS3CompatibleObjectStorage,
  resolveS3CompatibleConfig,
} from '@/providers/object-storage/s3'
import {
  MAX_SIGNED_URL_TTL_SECONDS,
  OBJECT_ALREADY_EXISTS_CODE,
  ObjectStorageError,
} from '@/providers/object-storage/types'
import type { S3ClientLike } from '@/providers/object-storage/s3'
import type { ObjectStorageProvider } from '@/providers/object-storage/types'

/**
 * ============================================================================
 * S3-COMPATIBLE PRIVATE OBJECT STORAGE — Phase One, Step 20.
 *
 * ZERO NETWORK. Every case below runs against a deterministic in-memory
 * double of the SDK client, which is the whole reason the adapter takes
 * one. The rules it enforces — conditional create, conflict never
 * overwrites, an ETag is never a hash, a bounded signed TTL, no ACL, no
 * public URL, no credential in an error — are only worth anything if
 * they are exercised, and they cannot be exercised against a real
 * bucket in this project's verification.
 *
 * The double is intentionally strict: it asserts on the parameters the
 * adapter sends, so "we forgot IfNoneMatch" fails here rather than in
 * production at 3am when two workers race the same canonical key.
 * ============================================================================
 */

const CONFIG: Record<string, string> = {
  OBJECT_STORAGE_ENDPOINT: 'https://s3.example',
  OBJECT_STORAGE_REGION: 'eu-west-1',
  OBJECT_STORAGE_BUCKET: 'yhwv-private',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'AKIA_PLACEHOLDER',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'secret-placeholder-never-real',
}

const KEY = 'renders/ab/' + 'a'.repeat(64) + '.mp4'
const BYTES = new TextEncoder().encode('deterministic-not-real-media')
const SHA256 = createHash('sha256').update(BYTES).digest('hex')
const MIME = 'video/mp4'

interface StoredObject {
  bytes: Uint8Array
  mimeType: string
  /** What the SERVICE computed, base64 — present only when the double
   * is configured to support checksums. */
  checksumSha256: string | null
}

interface FakeS3Options {
  /** Whether the service returns its own SHA-256 checksum. */
  supportsChecksums?: boolean
  /** Force a specific failure from the next send(). */
  failWith?: unknown
}

/** Records every command the adapter sent, so parameters can be
 * asserted rather than assumed. */
interface FakeS3 extends S3ClientLike {
  objects: Map<string, StoredObject>
  sent: Array<{ name: string; input: Record<string, unknown> }>
}

function commandName(command: unknown): string {
  return (command as { constructor: { name: string } }).constructor.name
}

function commandInput(command: unknown): Record<string, unknown> {
  return (command as { input: Record<string, unknown> }).input
}

function notFound(): Error {
  return Object.assign(new Error('not found'), {
    name: 'NotFound',
    $metadata: { httpStatusCode: 404 },
  })
}

function preconditionFailed(): Error {
  return Object.assign(new Error('precondition failed'), {
    name: 'PreconditionFailed',
    $metadata: { httpStatusCode: 412 },
  })
}

function makeFakeS3(options: FakeS3Options = {}): FakeS3 {
  const objects = new Map<string, StoredObject>()
  const sent: FakeS3['sent'] = []
  return {
    objects,
    sent,
    async send(command: unknown) {
      const name = commandName(command)
      const input = commandInput(command)
      sent.push({ name, input })
      if (options.failWith) throw options.failWith

      if (name === 'PutObjectCommand') {
        const key = String(input.Key)
        // THE CONDITIONAL CREATE, enforced by the "service" exactly as a
        // real one does: the exclusion happens here, atomically, not in
        // the adapter.
        if (input.IfNoneMatch === '*' && objects.has(key)) {
          throw preconditionFailed()
        }
        if (input.IfNoneMatch !== '*') {
          // A blind put at a canonical key is forbidden; if the adapter
          // ever stops sending the condition, this makes it obvious.
          throw new Error('adapter sent an unconditional PutObject')
        }
        objects.set(key, {
          bytes: input.Body as Uint8Array,
          mimeType: String(input.ContentType),
          checksumSha256:
            options.supportsChecksums === true
              ? String(input.ChecksumSHA256)
              : null,
        })
        return {
          // An ETag that is deliberately NOT the content hash.
          ETag: '"d41d8cd98f00b204e9800998ecf8427e"',
          VersionId: 'v1',
          ...(options.supportsChecksums === true
            ? { ChecksumSHA256: String(input.ChecksumSHA256) }
            : {}),
        }
      }

      if (name === 'HeadObjectCommand') {
        const stored = objects.get(String(input.Key))
        if (!stored) throw notFound()
        return {
          ContentLength: stored.bytes.length,
          ContentType: stored.mimeType,
          ETag: '"d41d8cd98f00b204e9800998ecf8427e"',
          VersionId: 'v1',
          ...(stored.checksumSha256 != null
            ? { ChecksumSHA256: stored.checksumSha256 }
            : {}),
        }
      }

      if (name === 'GetObjectCommand') {
        const stored = objects.get(String(input.Key))
        if (!stored) throw notFound()
        return {
          ContentLength: stored.bytes.length,
          ContentType: stored.mimeType,
          Body: { transformToByteArray: async () => stored.bytes },
        }
      }
      throw new Error(`unexpected command ${name}`)
    },
  }
}

function makeAdapter(
  fake: FakeS3,
  signUrl?: (
    client: S3ClientLike,
    command: unknown,
    options: { expiresIn: number },
  ) => Promise<string>,
): ObjectStorageProvider {
  return createS3CompatibleObjectStorage(CONFIG, {
    client: fake,
    signUrl:
      signUrl ??
      (async (_client, command, options) =>
        `https://s3.example/${String(commandInput(command).Key)}?X-Amz-Expires=${String(options.expiresIn)}`),
  })
}

async function put(adapter: ObjectStorageProvider) {
  return adapter.putPrivateObject({
    objectKey: KEY,
    bytes: BYTES,
    mimeType: MIME,
    sha256: SHA256,
  })
}

describe('S3 adapter configuration', () => {
  it('reports MISSING VARIABLE NAMES, never values', () => {
    const resolved = resolveS3CompatibleConfig({
      ...CONFIG,
      OBJECT_STORAGE_BUCKET: '',
      OBJECT_STORAGE_SECRET_ACCESS_KEY: '   ',
    })
    expect(resolved.ok).toBe(false)
    if (resolved.ok) throw new Error('expected failure')
    expect(resolved.missing).toEqual([
      'OBJECT_STORAGE_BUCKET',
      'OBJECT_STORAGE_SECRET_ACCESS_KEY',
    ])
    expect(JSON.stringify(resolved)).not.toContain(
      CONFIG.OBJECT_STORAGE_ACCESS_KEY_ID,
    )
  })

  it('refuses to build with incomplete configuration, and NEVER substitutes local storage', () => {
    let thrown: unknown
    try {
      createS3CompatibleObjectStorage({ ...CONFIG, OBJECT_STORAGE_BUCKET: '' })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ObjectStorageError)
    expect((thrown as ObjectStorageError).code).toBe(
      'object_storage_misconfigured',
    )
    expect((thrown as ObjectStorageError).retryable).toBe(false)
  })

  it('is not local, and says so — the flag production refuses on', () => {
    const adapter = makeAdapter(makeFakeS3())
    expect(adapter.isLocal).toBe(false)
    expect(adapter.code).toBe('S3_PRIVATE')
    expect(adapter.isEnabled()).toBe(true)
  })
})

describe('conditional create', () => {
  it('writes PRIVATELY with a conditional create and no ACL of any kind', async () => {
    const fake = makeFakeS3()
    const adapter = makeAdapter(fake)
    const descriptor = await put(adapter)

    const command = fake.sent.find((entry) => entry.name === 'PutObjectCommand')!
    expect(command.input.IfNoneMatch).toBe('*')
    expect(command.input.Bucket).toBe(CONFIG.OBJECT_STORAGE_BUCKET)
    expect(command.input.Key).toBe(KEY)
    expect(command.input.ContentType).toBe(MIME)
    // TEETH: no ACL parameter, under any spelling. A single
    // `ACL: 'public-read'` would turn a private recording into a public
    // one, and nothing downstream would notice.
    for (const forbidden of ['ACL', 'GrantRead', 'GrantFullControl']) {
      expect(command.input[forbidden]).toBeUndefined()
    }
    expect(descriptor.byteSize).toBe(BYTES.length)
    expect(descriptor.mimeType).toBe(MIME)
  })

  it('hands the service its own SHA-256 so a corrupted transfer is refused on write', async () => {
    const fake = makeFakeS3({ supportsChecksums: true })
    await put(makeAdapter(fake))
    const command = fake.sent.find((entry) => entry.name === 'PutObjectCommand')!
    expect(command.input.ChecksumAlgorithm).toBe('SHA256')
    expect(command.input.ChecksumSHA256).toBe(
      Buffer.from(SHA256, 'hex').toString('base64'),
    )
  })

  it('refuses to write bytes that disagree with the caller’s own hash', async () => {
    const adapter = makeAdapter(makeFakeS3())
    let thrown: unknown
    try {
      await adapter.putPrivateObject({
        objectKey: KEY,
        bytes: BYTES,
        mimeType: MIME,
        sha256: 'f'.repeat(64),
      })
    } catch (error) {
      thrown = error
    }
    expect((thrown as ObjectStorageError).code).toBe('checksum_mismatch_on_write')
  })

  it('maps an existing canonical object to the SHARED already-exists code, and NEVER overwrites', async () => {
    const fake = makeFakeS3()
    const adapter = makeAdapter(fake)
    await put(adapter)
    const first = fake.objects.get(KEY)!

    let thrown: unknown
    try {
      await adapter.putPrivateObject({
        objectKey: KEY,
        // Different bytes, same canonical key — the exact race the
        // condition exists for.
        bytes: new TextEncoder().encode('a different render entirely'),
        mimeType: MIME,
        sha256: createHash('sha256')
          .update(new TextEncoder().encode('a different render entirely'))
          .digest('hex'),
      })
    } catch (error) {
      thrown = error
    }
    // The SAME code the local adapter throws: the upload service treats
    // it as a normal recovery outcome and must not have to know which
    // backend it is talking to.
    expect((thrown as ObjectStorageError).code).toBe(OBJECT_ALREADY_EXISTS_CODE)
    expect((thrown as ObjectStorageError).retryable).toBe(false)
    // TEETH: the winner's object is untouched.
    expect(fake.objects.get(KEY)!.bytes).toBe(first.bytes)
  })

  it('never deletes a canonical object', async () => {
    // The key is shared by every attempt, so a stale worker that lost a
    // database race would otherwise destroy another worker's valid
    // upload. Retention is an operator decision on the bucket.
    const adapter = makeAdapter(makeFakeS3())
    let thrown: unknown
    try {
      await adapter.removePrivateObject(KEY)
    } catch (error) {
      thrown = error
    }
    expect((thrown as ObjectStorageError).code).toBe('object_deletion_forbidden')
  })
})

describe('integrity', () => {
  it('accepts a checksum the SERVICE computed', async () => {
    const adapter = makeAdapter(makeFakeS3({ supportsChecksums: true }))
    await put(adapter)
    const verified = await adapter.verifyPrivateObjectIntegrity({
      objectKey: KEY,
      expectedSha256: SHA256,
      expectedByteSize: BYTES.length,
      expectedMimeType: MIME,
    })
    expect(verified.ok).toBe(true)
  })

  it('proves integrity from the BYTES when the service offers no checksum', async () => {
    const fake = makeFakeS3({ supportsChecksums: false })
    const adapter = makeAdapter(fake)
    await put(adapter)
    const verified = await adapter.verifyPrivateObjectIntegrity({
      objectKey: KEY,
      expectedSha256: SHA256,
      expectedByteSize: BYTES.length,
      expectedMimeType: MIME,
    })
    expect(verified.ok).toBe(true)
    // It really did download rather than take metadata's word for it.
    expect(fake.sent.some((entry) => entry.name === 'GetObjectCommand')).toBe(true)
  })

  it('NEVER accepts an ETag as a SHA-256', async () => {
    const fake = makeFakeS3({ supportsChecksums: false })
    const adapter = makeAdapter(fake)
    await put(adapter)
    // Substitute different bytes of the SAME LENGTH behind the
    // adapter's back. Every piece of metadata still matches — size,
    // MIME, and the ETag, which is what a lazy implementation would
    // compare. Only reading the bytes catches it.
    const tampered = new Uint8Array(BYTES.length).fill(7)
    fake.objects.set(KEY, {
      bytes: tampered,
      mimeType: MIME,
      checksumSha256: null,
    })
    const verified = await adapter.verifyPrivateObjectIntegrity({
      objectKey: KEY,
      expectedSha256: SHA256,
      expectedByteSize: BYTES.length,
      expectedMimeType: MIME,
    })
    expect(verified.ok).toBe(false)
    if (verified.ok) throw new Error('expected refusal')
    expect(verified.reasonCode).toBe('object_checksum_mismatch')
  })

  it('refuses a provider checksum that disagrees, without downloading', async () => {
    const fake = makeFakeS3({ supportsChecksums: true })
    const adapter = makeAdapter(fake)
    await put(adapter)
    fake.objects.set(KEY, {
      bytes: BYTES,
      mimeType: MIME,
      checksumSha256: Buffer.from('e'.repeat(64), 'hex').toString('base64'),
    })
    const verified = await adapter.verifyPrivateObjectIntegrity({
      objectKey: KEY,
      expectedSha256: SHA256,
      expectedByteSize: BYTES.length,
      expectedMimeType: MIME,
    })
    expect(verified.ok).toBe(false)
    if (verified.ok) throw new Error('expected refusal')
    expect(verified.reasonCode).toBe('object_checksum_mismatch')
  })

  it('fails closed on a missing object, a size change and a MIME change', async () => {
    const fake = makeFakeS3({ supportsChecksums: true })
    const adapter = makeAdapter(fake)
    const base = {
      objectKey: KEY,
      expectedSha256: SHA256,
      expectedByteSize: BYTES.length,
      expectedMimeType: MIME,
    }
    const missing = await adapter.verifyPrivateObjectIntegrity(base)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reasonCode).toBe('object_missing')

    await put(adapter)
    const wrongSize = await adapter.verifyPrivateObjectIntegrity({
      ...base,
      expectedByteSize: BYTES.length + 1,
    })
    expect(wrongSize.ok).toBe(false)
    if (!wrongSize.ok) expect(wrongSize.reasonCode).toBe('object_size_mismatch')

    const wrongMime = await adapter.verifyPrivateObjectIntegrity({
      ...base,
      expectedMimeType: 'video/webm',
    })
    expect(wrongMime.ok).toBe(false)
    if (!wrongMime.ok) expect(wrongMime.reasonCode).toBe('object_mime_mismatch')
  })
})

describe('signed private reads', () => {
  it('bounds the TTL at the Step 17 ceiling', async () => {
    const adapter = makeAdapter(makeFakeS3())
    const now = new Date('2026-01-01T00:00:00.000Z')
    const signed = await adapter.createSignedReadUrl({
      objectKey: KEY,
      ttlSeconds: 300,
      now,
    })
    expect(signed.expiresAt.getTime()).toBe(now.getTime() + 300_000)

    for (const ttl of [0, -1, MAX_SIGNED_URL_TTL_SECONDS + 1, Number.NaN]) {
      let thrown: unknown
      try {
        await adapter.createSignedReadUrl({ objectKey: KEY, ttlSeconds: ttl, now })
      } catch (error) {
        thrown = error
      }
      // TEETH: an adapter that trusted its caller's number is one
      // refactor away from a week-long link to somebody's prayer.
      expect((thrown as ObjectStorageError).code).toBe(
        'signed_url_ttl_out_of_bounds',
      )
    }
  })

  it('signs a GET of that exact key and nothing else', async () => {
    const seen: Array<{ name: string; key: string; expiresIn: number }> = []
    const adapter = makeAdapter(makeFakeS3(), async (_client, command, options) => {
      seen.push({
        name: commandName(command),
        key: String(commandInput(command).Key),
        expiresIn: options.expiresIn,
      })
      return 'https://s3.example/signed'
    })
    await adapter.createSignedReadUrl({
      objectKey: KEY,
      ttlSeconds: 120,
      now: new Date(),
    })
    expect(seen).toEqual([
      { name: 'GetObjectCommand', key: KEY, expiresIn: 120 },
    ])
  })
})

describe('errors carry no credentials', () => {
  it('drops the SDK message and keeps only a bounded code', async () => {
    // A real SDK error quotes request ids, endpoints and sometimes
    // headers. That text ends up in logs and rows.
    const leaky = Object.assign(
      new Error(
        `AccessDenied at ${CONFIG.OBJECT_STORAGE_ENDPOINT}/${CONFIG.OBJECT_STORAGE_BUCKET} using ${CONFIG.OBJECT_STORAGE_ACCESS_KEY_ID}`,
      ),
      { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } },
    )
    const adapter = makeAdapter(makeFakeS3({ failWith: leaky }))
    let thrown: unknown
    try {
      await put(adapter)
    } catch (error) {
      thrown = error
    }
    const error = thrown as ObjectStorageError
    expect(error.code).toBe('s3_put_failed')
    // 403 is a deterministic refusal, not worth retrying.
    expect(error.retryable).toBe(false)
    for (const secret of Object.values(CONFIG)) {
      expect(error.message).not.toContain(secret)
      expect(JSON.stringify({ ...error, message: error.message })).not.toContain(
        secret,
      )
    }
  })

  it('treats transport and 5xx as retryable, and a deterministic refusal as not', async () => {
    const transient = Object.assign(new Error('boom'), {
      name: 'InternalError',
      $metadata: { httpStatusCode: 503 },
    })
    const adapter = makeAdapter(makeFakeS3({ failWith: transient }))
    let thrown: unknown
    try {
      await put(adapter)
    } catch (error) {
      thrown = error
    }
    expect((thrown as ObjectStorageError).retryable).toBe(true)
  })
})

describe('no public surface anywhere in the adapter', () => {
  it('mentions no ACL, bucket policy, website or CDN concept', async () => {
    const source = await Bun.file('src/providers/object-storage/s3.ts').text()
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*'))
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    for (const forbidden of [
      'public-read',
      'PutBucketAcl',
      'PutBucketPolicy',
      'PutBucketWebsite',
      'cloudfront',
      'CloudFront',
    ]) {
      expect(code).not.toContain(forbidden)
    }
  })
})
