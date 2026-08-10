import { join } from 'node:path'

import { env } from '@/lib/env'
import { LocalPrivateObjectStorage } from './local'
import { createS3CompatibleObjectStorage } from './s3'
import type { ObjectStorageProvider } from './types'

/**
 * Private object storage access point (Phase One, Step 17). The ONLY
 * way the upload service obtains a provider — mirrors the Step 14/15/16
 * registries (exactly one active slot, swappable for tests).
 *
 * The driver is chosen by explicit configuration, never by fallback: if
 * OBJECT_STORAGE_DRIVER says S3, a missing or broken adapter THROWS
 * rather than degrading to local storage.
 */

let overrideProvider: ObjectStorageProvider | null = null
let defaultProvider: ObjectStorageProvider | null = null

function defaultRootDir(): string {
  return process.env.OBJECT_STORAGE_ROOT ?? join(process.cwd(), 'var', 'objects')
}

export function getObjectStorage(): ObjectStorageProvider {
  if (overrideProvider) return overrideProvider
  if (defaultProvider) return defaultProvider
  // Explicit selection only. There is no "try S3, fall back to local"
  // path anywhere in this function, by design.
  defaultProvider =
    (process.env.OBJECT_STORAGE_DRIVER ?? 'LOCAL').toUpperCase() === 'S3'
      ? createS3CompatibleObjectStorage(process.env)
      : new LocalPrivateObjectStorage(defaultRootDir())
  return defaultProvider
}

/**
 * Resolves the provider a PERSISTED provider code refers to, failing
 * CLOSED on mismatch. An upload row records which provider holds the
 * object; re-verifying it later against whichever provider happens to
 * be active would be asking the wrong storage about someone else's key.
 */
export function resolveObjectStorage(
  providerCode: string,
): ObjectStorageProvider | null {
  const active = getObjectStorage()
  return active.code === providerCode ? active : null
}

export type ObjectStorageEnvironmentCheck =
  | { ok: true }
  | { ok: false; reasonCode: string }

/**
 * PRODUCTION MUST NEVER USE LOCAL/MOCK OBJECT STORAGE.
 *
 * The local adapter is a directory on one machine: it is not durable,
 * not replicated, and not private object storage in any sense a person
 * trusting this platform with their prayer would recognise. In
 * development and test it is exactly right; in production it would mean
 * telling someone their video is safely stored when it is one disk
 * failure from gone. So it is refused outright when NODE_ENV is
 * production — no flag, no override.
 *
 * Checked TWICE on purpose — before the upload and again at the final
 * gate — so a provider swapped in mid-flight cannot smuggle a local
 * object forward.
 */
export function checkObjectStorageAllowed(
  provider: Pick<ObjectStorageProvider, 'code' | 'isLocal' | 'isEnabled'>,
  nodeEnv: string = env.NODE_ENV,
): ObjectStorageEnvironmentCheck {
  if (!provider.isEnabled()) {
    return { ok: false, reasonCode: 'object_storage_disabled' }
  }
  if (provider.isLocal && nodeEnv === 'production') {
    return { ok: false, reasonCode: 'local_object_storage_forbidden_in_production' }
  }
  return { ok: true }
}

export function setObjectStorageForTests(provider: ObjectStorageProvider): void {
  overrideProvider = provider
}

export function resetObjectStorageForTests(): void {
  overrideProvider = null
}
