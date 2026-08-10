/**
 * PRIVATE object storage abstraction (canon §23; Phase One, Step 17).
 *
 * Deliberately SEPARATE from the Step 10 `MediaStorageProvider`. That
 * one is local working storage for approved media and generated
 * artifacts; this one is the durable private destination a finished
 * render is uploaded to. Conflating them would mean a local disk
 * adapter could silently satisfy a production upload.
 *
 * PRIVATE MEANS PRIVATE. There is no public-read ACL, no public bucket
 * policy, no public URL and no CDN anywhere in this contract. The only
 * way an object can ever be read by a browser is a short-lived signed
 * GET, and Step 17 does not hand one to anybody — it exists so a LATER
 * approved stage has a boundary to call, and a signed URL is never
 * persisted and never logged.
 *
 * S3-COMPATIBLE, NOT S3-SPECIFIC. Service code talks to this interface
 * only. A production adapter for any S3-compatible service supplies its
 * own endpoint, region, bucket and credentials from environment
 * secrets; none of that appears in a service, a row or a log.
 */

/** Safe, non-secret facts about a stored object. Never bytes, never a
 * URL, never a credential. */
export interface PrivateObjectDescriptor {
  objectKey: string
  byteSize: number
  mimeType: string
  /**
   * Opaque provider identity (an S3 ETag, a version id, whatever the
   * provider issues). NEVER a content hash: an ETag is a provider's own
   * bookkeeping and for multipart uploads is not a digest of the object
   * at all. It is stored for support/debugging and is never accepted as
   * integrity evidence.
   */
  providerEtag: string | null
  providerVersionId: string | null
  /**
   * A checksum the PROVIDER genuinely computed over the stored object,
   * when it supports that. Null means "this provider offered no
   * checksum" — which is a reason to prove integrity another way, never
   * a reason to skip proving it.
   */
  providerChecksumSha256: string | null
}

export interface PutPrivateObjectInput {
  objectKey: string
  bytes: Uint8Array
  mimeType: string
  /** The exact SHA-256 the caller already computed over these bytes,
   * so an adapter can hand it to a provider that supports checksum
   * verification on write. */
  sha256: string
}

export interface SignedReadUrl {
  url: string
  expiresAt: Date
}

export type ObjectIntegrityVerification =
  | { ok: true; descriptor: PrivateObjectDescriptor }
  | { ok: false; reasonCode: string }

/**
 * Thrown by adapters for storage-CALL failures (network/transport/
 * permission). A deterministic refusal is NOT retryable; a transient
 * transport failure IS — mirroring the provider-error discipline used
 * by payments, visual generation, speech synthesis and rendering.
 */
export class ObjectStorageError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable: boolean) {
    super(message)
    this.name = 'ObjectStorageError'
    this.code = code
    this.retryable = retryable
  }
}

/** Hard ceiling for a signed read URL. A "private" object reachable by
 * a link that lasts a week is not private. */
export const MAX_SIGNED_URL_TTL_SECONDS = 15 * 60

export interface ObjectStorageProvider {
  readonly code: string
  /**
   * TRUE for any adapter that is not real durable private object
   * storage (the deterministic local/test one). Persisted on every
   * upload row and refused outright in production, exactly like the
   * render engine's mock flag.
   */
  readonly isLocal: boolean
  isEnabled: () => boolean
  /** Writes bytes at a SERVER-GENERATED key with NO public ACL. */
  putPrivateObject: (
    input: PutPrivateObjectInput,
  ) => Promise<PrivateObjectDescriptor>
  /** Metadata only — null when the object does not exist. */
  headPrivateObject: (
    objectKey: string,
  ) => Promise<PrivateObjectDescriptor | null>
  /** Exact stored bytes, or null when missing. Used to prove integrity
   * where the provider offers no checksum of its own. */
  getPrivateObject: (objectKey: string) => Promise<Uint8Array | null>
  removePrivateObject: (objectKey: string) => Promise<void>
  /**
   * Proves the stored object really is the expected one, by whatever
   * means this provider genuinely supports, and FAILS CLOSED when it
   * cannot prove it. An adapter must never satisfy this by comparing an
   * ETag to a SHA-256.
   */
  verifyPrivateObjectIntegrity: (input: {
    objectKey: string
    expectedSha256: string
    expectedByteSize: number
    expectedMimeType: string
  }) => Promise<ObjectIntegrityVerification>
  /**
   * Short-lived PRIVATE GET. `now` is passed in rather than read from a
   * wall clock so expiry is testable and deterministic. The returned
   * URL is a secret: it is never persisted, never logged and never
   * returned to a user by Step 17.
   */
  createSignedReadUrl: (input: {
    objectKey: string
    ttlSeconds: number
    now: Date
  }) => Promise<SignedReadUrl>
}
