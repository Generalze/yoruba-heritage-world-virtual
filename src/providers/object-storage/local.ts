import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { MAX_SIGNED_URL_TTL_SECONDS, ObjectStorageError } from './types'
import type {
  ObjectIntegrityVerification,
  ObjectStorageProvider,
  PrivateObjectDescriptor,
  PutPrivateObjectInput,
  SignedReadUrl,
} from './types'

/**
 * Deterministic LOCAL private object storage (Phase One, Step 17).
 *
 * Zero network, zero paid calls, suitable for development and for
 * end-to-end pipeline verification in tests. It is NOT durable private
 * object storage, and it says so: `isLocal` is true, it is persisted on
 * every upload row, and the environment guard refuses it in production.
 *
 * Objects live OUTSIDE any public web root, under a dedicated private
 * root that is distinct from the Step 10 media root — a finished render
 * is a different kind of thing from working media, and mixing them
 * would let one adapter's rules leak onto the other's objects.
 *
 * There is no ACL concept here at all, which is the point: there is
 * nothing to accidentally set to public-read.
 */

/** renders/<shard>/<64 hex>.<ext> — the ONLY accepted key shape. Server
 * generated from an opaque identity; never anything a user supplied. */
const OBJECT_KEY_PATTERN =
  /^renders\/[a-f0-9]{2}\/[a-f0-9]{64}\.[a-z0-9]{2,5}$/

export function isValidPrivateObjectKey(objectKey: string): boolean {
  return OBJECT_KEY_PATTERN.test(objectKey)
}

const SIDECAR_SUFFIX = '.meta.json'

interface StoredSidecar {
  mimeType: string
  byteSize: number
  /** This adapter really does compute a checksum over the stored bytes,
   * so it can answer checksum questions honestly rather than by
   * repeating what it was told. */
  checksumSha256: string
  etag: string
}

export class LocalPrivateObjectStorage implements ObjectStorageProvider {
  readonly code = 'LOCAL_PRIVATE'
  readonly isLocal = true

  constructor(
    private readonly rootDir: string,
    /** Signing secret for local signed URLs. Never a real credential
     * and never leaves this process. */
    private readonly signingSecret: string = 'local-private-object-signing',
  ) {}

  isEnabled(): boolean {
    return true
  }

  private pathFor(objectKey: string): string {
    return join(this.rootDir, objectKey)
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
    const path = this.pathFor(input.objectKey)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, input.bytes)
    // An ETag that is deliberately NOT the content hash, so any code
    // that mistakes one for the other fails loudly in development
    // rather than silently in production.
    const etag = createHash('sha1')
      .update(`${input.objectKey}|${String(input.bytes.length)}`)
      .digest('hex')
    const sidecar: StoredSidecar = {
      mimeType: input.mimeType,
      byteSize: input.bytes.length,
      checksumSha256,
      etag,
    }
    await writeFile(`${path}${SIDECAR_SUFFIX}`, JSON.stringify(sidecar), 'utf8')
    return {
      objectKey: input.objectKey,
      byteSize: sidecar.byteSize,
      mimeType: sidecar.mimeType,
      providerEtag: etag,
      providerVersionId: null,
      providerChecksumSha256: checksumSha256,
    }
  }

  private async readSidecar(objectKey: string): Promise<StoredSidecar | null> {
    try {
      const raw = await readFile(
        `${this.pathFor(objectKey)}${SIDECAR_SUFFIX}`,
        'utf8',
      )
      return JSON.parse(raw) as StoredSidecar
    } catch {
      return null
    }
  }

  async headPrivateObject(
    objectKey: string,
  ): Promise<PrivateObjectDescriptor | null> {
    if (!isValidPrivateObjectKey(objectKey)) return null
    let byteSize: number
    try {
      byteSize = (await stat(this.pathFor(objectKey))).size
    } catch {
      return null
    }
    const sidecar = await this.readSidecar(objectKey)
    return {
      objectKey,
      byteSize,
      mimeType: sidecar?.mimeType ?? 'application/octet-stream',
      providerEtag: sidecar?.etag ?? null,
      providerVersionId: null,
      providerChecksumSha256: sidecar?.checksumSha256 ?? null,
    }
  }

  async getPrivateObject(objectKey: string): Promise<Uint8Array | null> {
    if (!isValidPrivateObjectKey(objectKey)) return null
    try {
      return await readFile(this.pathFor(objectKey))
    } catch {
      return null
    }
  }

  async removePrivateObject(objectKey: string): Promise<void> {
    if (!isValidPrivateObjectKey(objectKey)) return
    for (const path of [
      this.pathFor(objectKey),
      `${this.pathFor(objectKey)}${SIDECAR_SUFFIX}`,
    ]) {
      try {
        await unlink(path)
      } catch {
        // best-effort: a missing object is already the desired state
      }
    }
  }

  /**
   * Re-reads the stored bytes and recomputes their SHA-256 — this
   * adapter can prove integrity directly, so it does, rather than
   * trusting its own sidecar (which is just another thing on disk that
   * could have been edited).
   */
  async verifyPrivateObjectIntegrity(input: {
    objectKey: string
    expectedSha256: string
    expectedByteSize: number
    expectedMimeType: string
  }): Promise<ObjectIntegrityVerification> {
    const descriptor = await this.headPrivateObject(input.objectKey)
    if (!descriptor) {
      return { ok: false, reasonCode: 'object_missing' }
    }
    const bytes = await this.getPrivateObject(input.objectKey)
    if (!bytes || bytes.length === 0) {
      return { ok: false, reasonCode: 'object_empty' }
    }
    if (bytes.length !== input.expectedByteSize) {
      return { ok: false, reasonCode: 'object_size_mismatch' }
    }
    if (descriptor.mimeType !== input.expectedMimeType) {
      return { ok: false, reasonCode: 'object_mime_mismatch' }
    }
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== input.expectedSha256) {
      return { ok: false, reasonCode: 'object_checksum_mismatch' }
    }
    return {
      ok: true,
      descriptor: { ...descriptor, byteSize: bytes.length, providerChecksumSha256: actual },
    }
  }

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
    if (input.ttlSeconds <= 0 || input.ttlSeconds > MAX_SIGNED_URL_TTL_SECONDS) {
      throw new ObjectStorageError(
        'signed_url_ttl_out_of_bounds',
        'Signed URL TTL is outside the permitted bounds.',
        false,
      )
    }
    const expiresAt = new Date(input.now.getTime() + input.ttlSeconds * 1000)
    const expiry = Math.floor(expiresAt.getTime() / 1000)
    const signature = createHmac('sha256', this.signingSecret)
      .update(`${input.objectKey}|${String(expiry)}`)
      .digest('hex')
    // A local, non-network scheme: nothing about this is fetchable, and
    // it can never be mistaken for a public https URL.
    return {
      url: `local-private://${input.objectKey}?expires=${String(expiry)}&signature=${signature}`,
      expiresAt,
    }
  }

  /** Test/dev helper mirroring what a real adapter's edge would do —
   * present so the signing path is exercisable, never used by the
   * pipeline. */
  verifySignedReadUrl(url: string, now: Date): boolean {
    const match = /^local-private:\/\/(.+)\?expires=(\d+)&signature=([a-f0-9]{64})$/.exec(
      url,
    )
    if (!match) return false
    const [, objectKey, expiry, signature] = match
    if (Number(expiry) * 1000 <= now.getTime()) return false
    const expected = createHmac('sha256', this.signingSecret)
      .update(`${objectKey}|${expiry}`)
      .digest('hex')
    return timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex'),
    )
  }
}
