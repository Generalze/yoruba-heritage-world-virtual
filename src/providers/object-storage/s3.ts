import { createHash } from 'node:crypto'

import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import { isValidPrivateObjectKey } from './local'
import {
  MAX_SIGNED_URL_TTL_SECONDS,
  OBJECT_ALREADY_EXISTS_CODE,
  ObjectStorageError,
} from './types'
import type {
  ObjectIntegrityVerification,
  ObjectStorageProvider,
  PrivateObjectDescriptor,
  PutPrivateObjectInput,
  SignedReadUrl,
} from './types'

/**
 * S3-compatible PRIVATE object storage (Phase One, Step 20; canon §23,
 * §10.13).
 *
 * This is the real adapter behind the Step 17 boundary. Everything the
 * boundary promised is enforced here, and none of it is negotiable:
 *
 * PRIVATE MEANS PRIVATE. No ACL parameter is ever sent — not
 * `public-read`, not `bucket-owner-read`, not any other. The bucket's
 * own default (which an operator MUST leave private, see the runbook)
 * is the only access policy, there is no bucket-policy management here,
 * no website configuration, no CDN origin and no public URL is ever
 * constructed. The single way bytes leave the bucket is a short-lived
 * signed GET.
 *
 * CREATE-IF-ABSENT, NEVER BLIND OVERWRITE. `putPrivateObject` sends
 * `IfNoneMatch: '*'`, so the STORAGE SERVICE performs the exclusion
 * atomically and answers 412 when the key is taken. A head-then-put
 * would leave a gap in which two workers racing the same canonical key
 * both believe they won, and the loser would destroy the winner's valid
 * upload. Any already-exists answer is translated to the SAME
 * OBJECT_ALREADY_EXISTS_CODE the local adapter throws, because the
 * upload service treats that as a normal recovery outcome — verify and
 * adopt — and it must not have to know which backend it is talking to.
 *
 * AN ETAG IS NOT A HASH. S3 returns an ETag that is an MD5 for simple
 * uploads and something else entirely for multipart, and it is never a
 * SHA-256. It is recorded as opaque provider bookkeeping and is NEVER
 * compared against, derived from, or accepted as integrity evidence.
 * Integrity is proved from the object's own bytes, or from a
 * provider-computed SHA-256 checksum the service genuinely supports —
 * and when neither can be obtained, verification FAILS CLOSED.
 *
 * CREDENTIALS ARE NEVER PERSISTED OR LOGGED. They exist only inside the
 * client this factory builds. No descriptor, error, log line or
 * loggable field in this file contains an endpoint, bucket, key id or
 * secret; errors carry bounded codes only.
 */

export interface S3CompatibleObjectStorageConfig {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** Most non-AWS S3-compatible services need path-style addressing. */
  forcePathStyle: boolean
}

export type S3ConfigResolution =
  | { ok: true; config: S3CompatibleObjectStorageConfig }
  | { ok: false; missing: Array<string> }

/**
 * Resolves the adapter's configuration from an environment-like record.
 * Returns the MISSING KEY NAMES on failure — never the values, and
 * never a partially-populated config that could be logged.
 */
export function resolveS3CompatibleConfig(
  source: Record<string, string | undefined>,
): S3ConfigResolution {
  const required = {
    OBJECT_STORAGE_ENDPOINT: source.OBJECT_STORAGE_ENDPOINT,
    OBJECT_STORAGE_REGION: source.OBJECT_STORAGE_REGION,
    OBJECT_STORAGE_BUCKET: source.OBJECT_STORAGE_BUCKET,
    OBJECT_STORAGE_ACCESS_KEY_ID: source.OBJECT_STORAGE_ACCESS_KEY_ID,
    OBJECT_STORAGE_SECRET_ACCESS_KEY: source.OBJECT_STORAGE_SECRET_ACCESS_KEY,
  }
  // The reported names are the ENVIRONMENT VARIABLES an operator has to
  // set — actionable without ever naming a value.
  const missing = Object.entries(required)
    .filter(([, value]) => value == null || value.trim() === '')
    .map(([name]) => name)
  if (missing.length > 0) return { ok: false, missing }
  return {
    ok: true,
    config: {
      endpoint: required.OBJECT_STORAGE_ENDPOINT!,
      region: required.OBJECT_STORAGE_REGION!,
      bucket: required.OBJECT_STORAGE_BUCKET!,
      accessKeyId: required.OBJECT_STORAGE_ACCESS_KEY_ID!,
      secretAccessKey: required.OBJECT_STORAGE_SECRET_ACCESS_KEY!,
      forcePathStyle: source.OBJECT_STORAGE_FORCE_PATH_STYLE !== 'false',
    },
  }
}

/**
 * The narrow slice of the SDK this adapter uses.
 *
 * Declared as a structural type rather than taking S3Client directly so
 * automated tests can supply a deterministic in-memory double and prove
 * the CONDITIONAL-CREATE, CONFLICT, INTEGRITY and TTL semantics without
 * a single network call. That is the point: the rules above are only
 * worth anything if they are exercised, and they cannot be exercised
 * against a real bucket in this project's verification.
 */
export interface S3ClientLike {
  send: (command: unknown) => Promise<unknown>
}

/** The presigner, injectable for the same reason. */
export type SignedUrlFactory = (
  client: S3ClientLike,
  command: unknown,
  options: { expiresIn: number },
) => Promise<string>

export interface S3AdapterDependencies {
  client?: S3ClientLike
  signUrl?: SignedUrlFactory
}

interface HeadObjectLikeOutput {
  ContentLength?: number
  ContentType?: string
  ETag?: string
  VersionId?: string
  ChecksumSHA256?: string
}

interface GetObjectLikeOutput extends HeadObjectLikeOutput {
  Body?: {
    transformToByteArray?: () => Promise<Uint8Array>
  }
}

interface PutObjectLikeOutput {
  ETag?: string
  VersionId?: string
  ChecksumSHA256?: string
}

/** S3 answers a failed `IfNoneMatch: '*'` with 412; some compatible
 * services use their own name for the same thing. All of them mean the
 * canonical key is taken. */
function isAlreadyExists(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } })
    .$metadata?.httpStatusCode
  if (status === 412 || status === 409) return true
  const name = (error as { name?: string }).name ?? ''
  return (
    name === 'PreconditionFailed' ||
    name === 'ConditionalRequestConflict' ||
    name === 'ObjectAlreadyExists'
  )
}

function isNotFound(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } })
    .$metadata?.httpStatusCode
  if (status === 404) return true
  const name = (error as { name?: string }).name ?? ''
  return name === 'NotFound' || name === 'NoSuchKey'
}

/** Transport/5xx/throttling is worth another attempt; a deterministic
 * refusal is not. Mirrors the provider-error discipline used by
 * payments, visual generation, speech synthesis and rendering. */
function isRetryableTransport(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } })
    .$metadata?.httpStatusCode
  if (status != null) return status >= 500 || status === 429
  return true
}

/**
 * Wraps an SDK failure in a bounded code.
 *
 * DELIBERATELY DROPS THE ORIGINAL MESSAGE. SDK errors quote request
 * ids, endpoints, bucket names and sometimes headers; that text ends up
 * in logs and rows. Only the error's NAME (an S3 error code such as
 * `AccessDenied`) survives, and nothing else.
 */
function wrapTransportError(operation: string, error: unknown): never {
  const name = (error as { name?: string }).name ?? 'unknown_error'
  throw new ObjectStorageError(
    `s3_${operation}_failed`,
    `S3-compatible storage ${operation} failed (${name}).`,
    isRetryableTransport(error),
  )
}

class S3CompatibleObjectStorage implements ObjectStorageProvider {
  readonly code = 'S3_PRIVATE'
  /** Real durable private object storage — the whole point of it. */
  readonly isLocal = false

  private readonly bucket: string

  constructor(
    config: S3CompatibleObjectStorageConfig,
    private readonly client: S3ClientLike,
    private readonly signUrl: SignedUrlFactory,
  ) {
    // ONLY the bucket name is retained on the instance. Endpoint,
    // region and credentials live inside the client and are
    // unreachable from here, so no field of this object can leak one.
    this.bucket = config.bucket
  }

  isEnabled(): boolean {
    return true
  }

  async putPrivateObject(
    input: PutPrivateObjectInput,
  ): Promise<PrivateObjectDescriptor> {
    if (!isValidPrivateObjectKey(input.objectKey)) {
      throw new ObjectStorageError(
        'invalid_object_key',
        'Object key failed validation.',
        false,
      )
    }
    if (input.bytes.length === 0) {
      throw new ObjectStorageError(
        'empty_object',
        'Refusing to store an empty object.',
        false,
      )
    }
    const checksumSha256 = createHash('sha256').update(input.bytes).digest('hex')
    if (checksumSha256 !== input.sha256) {
      // The caller's own hash disagrees with the bytes it handed over:
      // something upstream is wrong and writing would only persist it.
      throw new ObjectStorageError(
        'checksum_mismatch_on_write',
        'Bytes do not match the supplied checksum.',
        false,
      )
    }

    let output: PutObjectLikeOutput
    try {
      output = (await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: input.objectKey,
          Body: input.bytes,
          ContentType: input.mimeType,
          ContentLength: input.bytes.length,
          // The service computes SHA-256 over what it actually received
          // and rejects the write if it disagrees, so a corrupted
          // transfer never becomes a stored object.
          ChecksumAlgorithm: 'SHA256',
          ChecksumSHA256: Buffer.from(checksumSha256, 'hex').toString('base64'),
          // ATOMIC CREATE-IF-ABSENT. Not an optimisation: without it,
          // two workers racing the same canonical key both write, and
          // the second destroys the first's valid upload.
          IfNoneMatch: '*',
          // NO ACL PARAMETER IS SENT, HERE OR ANYWHERE. The bucket's
          // private default governs, and there is no code path in this
          // adapter that could make an object public.
        }),
      )) as PutObjectLikeOutput
    } catch (error) {
      if (isAlreadyExists(error)) {
        throw new ObjectStorageError(
          OBJECT_ALREADY_EXISTS_CODE,
          'An object already exists at this canonical key.',
          false,
        )
      }
      wrapTransportError('put', error)
    }

    return {
      objectKey: input.objectKey,
      byteSize: input.bytes.length,
      mimeType: input.mimeType,
      // Opaque bookkeeping, recorded and never trusted.
      providerEtag: output.ETag ?? null,
      providerVersionId: output.VersionId ?? null,
      providerChecksumSha256: decodeProviderChecksum(output.ChecksumSHA256),
    }
  }

  async headPrivateObject(
    objectKey: string,
  ): Promise<PrivateObjectDescriptor | null> {
    if (!isValidPrivateObjectKey(objectKey)) return null
    let output: HeadObjectLikeOutput
    try {
      output = (await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          ChecksumMode: 'ENABLED',
        }),
      )) as HeadObjectLikeOutput
    } catch (error) {
      if (isNotFound(error)) return null
      wrapTransportError('head', error)
    }
    return {
      objectKey,
      byteSize: output.ContentLength ?? 0,
      mimeType: output.ContentType ?? 'application/octet-stream',
      providerEtag: output.ETag ?? null,
      providerVersionId: output.VersionId ?? null,
      providerChecksumSha256: decodeProviderChecksum(output.ChecksumSHA256),
    }
  }

  async getPrivateObject(objectKey: string): Promise<Uint8Array | null> {
    if (!isValidPrivateObjectKey(objectKey)) return null
    let output: GetObjectLikeOutput
    try {
      output = (await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          ChecksumMode: 'ENABLED',
        }),
      )) as GetObjectLikeOutput
    } catch (error) {
      if (isNotFound(error)) return null
      wrapTransportError('get', error)
    }
    const body = output.Body
    if (!body?.transformToByteArray) return null
    return body.transformToByteArray()
  }

  /**
   * DELETION IS REFUSED, DELIBERATELY.
   *
   * Step 17 established that a canonical object is never deleted: the
   * key is shared by every attempt, so a stale worker that lost a
   * database race would otherwise destroy another worker's valid
   * upload. The local adapter can afford a best-effort unlink for its
   * own temporary directories; a production bucket holding people's
   * recorded prayers cannot. Retention and lifecycle are an OPERATOR
   * decision made on the bucket, never an application one made in a
   * retry path.
   */
  async removePrivateObject(): Promise<void> {
    throw new ObjectStorageError(
      'object_deletion_forbidden',
      'Canonical private objects are never deleted by the application.',
      false,
    )
  }

  /**
   * Proves the stored object is the expected one — from BYTES, or from
   * a checksum the service genuinely computed. Never from an ETag.
   *
   * Order matters: cheap metadata first (existence, size, MIME), and
   * only then the download that actually proves content. A mismatch
   * found early saves pulling a whole video to learn the same thing.
   */
  async verifyPrivateObjectIntegrity(input: {
    objectKey: string
    expectedSha256: string
    expectedByteSize: number
    expectedMimeType: string
  }): Promise<ObjectIntegrityVerification> {
    const descriptor = await this.headPrivateObject(input.objectKey)
    if (!descriptor) return { ok: false, reasonCode: 'object_missing' }
    if (descriptor.byteSize === 0) {
      return { ok: false, reasonCode: 'object_empty' }
    }
    if (descriptor.byteSize !== input.expectedByteSize) {
      return { ok: false, reasonCode: 'object_size_mismatch' }
    }
    if (descriptor.mimeType !== input.expectedMimeType) {
      return { ok: false, reasonCode: 'object_mime_mismatch' }
    }

    // A PROVIDER-COMPUTED SHA-256 is real evidence and is accepted.
    // It is the only provider-supplied value in this file that is, and
    // it is accepted because the service computed it over the stored
    // object — unlike an ETag, which is bookkeeping.
    if (descriptor.providerChecksumSha256 != null) {
      if (descriptor.providerChecksumSha256 !== input.expectedSha256) {
        return { ok: false, reasonCode: 'object_checksum_mismatch' }
      }
      return { ok: true, descriptor }
    }

    // No provider checksum: prove it from the bytes themselves rather
    // than assume. There is no third branch — a service that offers
    // neither is one this adapter cannot verify, and it fails closed.
    const bytes = await this.getPrivateObject(input.objectKey)
    if (!bytes || bytes.length === 0) {
      return { ok: false, reasonCode: 'object_unverifiable' }
    }
    if (bytes.length !== input.expectedByteSize) {
      return { ok: false, reasonCode: 'object_size_mismatch' }
    }
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== input.expectedSha256) {
      return { ok: false, reasonCode: 'object_checksum_mismatch' }
    }
    return {
      ok: true,
      descriptor: { ...descriptor, providerChecksumSha256: actual },
    }
  }

  /**
   * A short-lived PRIVATE GET, and nothing else.
   *
   * The TTL is bounded HERE as well as by the caller: an adapter that
   * trusts its caller's number is one refactor away from issuing a
   * week-long link to somebody's prayer. The result is a secret — never
   * persisted, never logged, never returned by Step 17 — and Step 18
   * independently validates what comes back rather than trusting it.
   */
  async createSignedReadUrl(input: {
    objectKey: string
    ttlSeconds: number
    now: Date
  }): Promise<SignedReadUrl> {
    if (!isValidPrivateObjectKey(input.objectKey)) {
      throw new ObjectStorageError(
        'invalid_object_key',
        'Object key failed validation.',
        false,
      )
    }
    if (
      !Number.isFinite(input.ttlSeconds) ||
      input.ttlSeconds <= 0 ||
      input.ttlSeconds > MAX_SIGNED_URL_TTL_SECONDS
    ) {
      throw new ObjectStorageError(
        'signed_url_ttl_out_of_bounds',
        'Signed URL TTL is outside the permitted bounds.',
        false,
      )
    }
    let url: string
    try {
      url = await this.signUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.bucket, Key: input.objectKey }),
        { expiresIn: input.ttlSeconds },
      )
    } catch (error) {
      wrapTransportError('sign', error)
    }
    return {
      url,
      expiresAt: new Date(input.now.getTime() + input.ttlSeconds * 1000),
    }
  }
}

/** S3 reports checksums base64-encoded; the platform speaks lowercase
 * hex everywhere. A value that is not a well-formed SHA-256 is treated
 * as ABSENT rather than as evidence. */
function decodeProviderChecksum(value: string | undefined): string | null {
  if (value == null || value.trim() === '') return null
  let hex: string
  try {
    hex = Buffer.from(value, 'base64').toString('hex')
  } catch {
    return null
  }
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null
}

/**
 * Constructs the production adapter.
 *
 * Validates configuration FIRST, so a misconfigured deployment fails on
 * its config rather than at the moment it tries to upload somebody's
 * prayer video. It NEVER returns a local provider as a substitute:
 * silent fallback is the specific failure this function exists to make
 * impossible.
 */
export function createS3CompatibleObjectStorage(
  source: Record<string, string | undefined>,
  dependencies: S3AdapterDependencies = {},
): ObjectStorageProvider {
  const resolved = resolveS3CompatibleConfig(source)
  if (!resolved.ok) {
    throw new ObjectStorageError(
      'object_storage_misconfigured',
      `S3-compatible object storage is missing configuration: ${resolved.missing.join(', ')}.`,
      false,
    )
  }
  const config = resolved.config
  // The SDK's own `send` is generically typed over its command union;
  // the adapter only ever hands it the three commands above, so the
  // structural view is narrowed here rather than leaking SDK generics
  // through every method signature.
  const client: S3ClientLike =
    dependencies.client ??
    (new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    }) as unknown as S3ClientLike)
  const signUrl: SignedUrlFactory =
    dependencies.signUrl ??
    ((c, command, options) =>
      getSignedUrl(c as S3Client, command as GetObjectCommand, options))
  return new S3CompatibleObjectStorage(config, client, signUrl)
}
