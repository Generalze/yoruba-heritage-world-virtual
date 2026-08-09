import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Private media storage abstraction (Phase One, Step 10).
 *
 * Step 10 ships ONLY the local private adapter (dev/test/VPS disk). A
 * future S3-compatible adapter must implement this same interface —
 * no provider-specific behavior may leak into services.
 *
 * Safety model:
 * - objects live OUTSIDE the public web root and are never committed
 *   to Git (the default root is .gitignored);
 * - object keys are SERVER-GENERATED (uuid-derived) — user input never
 *   contributes to a filesystem path;
 * - every read/write validates the key against a strict pattern, so a
 *   traversal-shaped key ("../…", absolute paths, separators) is
 *   rejected before touching the filesystem;
 * - the SHA-256 integrity hash is computed server-side from the exact
 *   stored bytes, never trusted from a client.
 */

export interface MediaStorageProvider {
  /** Stores bytes under a server-generated key; returns the key. */
  put: (bytes: Uint8Array, extension: string) => Promise<{ storageKey: string }>
  /** Returns the exact stored bytes, or null when the object is missing. */
  get: (storageKey: string) => Promise<Uint8Array | null>
  exists: (storageKey: string) => Promise<boolean>
}

/** Extensions the platform accepts — bounded, non-executable. */
export const MEDIA_STORAGE_EXTENSIONS = [
  'mp3',
  'wav',
  'ogg',
  'jpg',
  'jpeg',
  'png',
  'webp',
  'mp4',
  'webm',
] as const

/** shard/uuid.ext — the ONLY accepted key shape. */
const STORAGE_KEY_PATTERN = /^[a-f0-9]{2}\/[a-f0-9]{32}\.[a-z0-9]{2,5}$/

export function isValidStorageKey(storageKey: string): boolean {
  return STORAGE_KEY_PATTERN.test(storageKey)
}

export function computeFileSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export class LocalMediaStorageProvider implements MediaStorageProvider {
  constructor(private readonly rootDir: string) {}

  async put(
    bytes: Uint8Array,
    extension: string,
  ): Promise<{ storageKey: string }> {
    const ext = extension.toLowerCase()
    if (!(MEDIA_STORAGE_EXTENSIONS as ReadonlyArray<string>).includes(ext)) {
      throw new Error('Unsupported media file extension.')
    }
    const objectId = randomUUID().replaceAll('-', '')
    const shard = objectId.slice(0, 2)
    const storageKey = `${shard}/${objectId}.${ext}`
    if (!isValidStorageKey(storageKey)) {
      throw new Error('Generated storage key failed validation.')
    }
    await mkdir(join(this.rootDir, shard), { recursive: true })
    await writeFile(join(this.rootDir, shard, `${objectId}.${ext}`), bytes)
    return { storageKey }
  }

  async get(storageKey: string): Promise<Uint8Array | null> {
    if (!isValidStorageKey(storageKey)) return null
    try {
      return await readFile(join(this.rootDir, storageKey))
    } catch {
      return null
    }
  }

  async exists(storageKey: string): Promise<boolean> {
    if (!isValidStorageKey(storageKey)) return false
    try {
      await stat(join(this.rootDir, storageKey))
      return true
    } catch {
      return false
    }
  }
}

let overrideProvider: MediaStorageProvider | null = null
let defaultProvider: MediaStorageProvider | null = null

/** Private local root — never inside the public web root, .gitignored. */
function defaultRootDir(): string {
  return process.env.MEDIA_STORAGE_DIR ?? join(process.cwd(), 'var', 'media')
}

export function getMediaStorage(): MediaStorageProvider {
  if (overrideProvider) return overrideProvider
  defaultProvider ??= new LocalMediaStorageProvider(defaultRootDir())
  return defaultProvider
}

export function setMediaStorageForTests(provider: MediaStorageProvider): void {
  overrideProvider = provider
}

export function resetMediaStorageForTests(): void {
  overrideProvider = null
}
