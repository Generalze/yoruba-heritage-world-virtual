import { join } from 'node:path'

import { env } from '@/lib/env'
import { LocalPrivateObjectStorage } from './local'
import { createS3CompatibleObjectStorage } from './s3'
import { ObjectStorageError } from './types'
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
  return env.OBJECT_STORAGE_ROOT.trim() === ''
    ? join(process.cwd(), 'var', 'objects')
    : env.OBJECT_STORAGE_ROOT
}

/**
 * Builds the configured provider. EXPLICIT SELECTION ONLY — there is no
 * "try S3, fall back to local" path anywhere in this function, by
 * design, and the default branch throws rather than guessing.
 *
 * An unknown driver string never reaches here: OBJECT_STORAGE_DRIVER is
 * a validated enum, so a typo stops the process at configuration time,
 * in EVERY environment. The exhaustive switch below is the second lock
 * on the same door — if a value is ever added to the enum and not
 * handled here, this throws instead of silently returning local
 * storage.
 */
export function getObjectStorage(): ObjectStorageProvider {
  if (overrideProvider) return overrideProvider
  if (defaultProvider) return defaultProvider
  switch (env.OBJECT_STORAGE_DRIVER) {
    case 'LOCAL':
      defaultProvider = new LocalPrivateObjectStorage(defaultRootDir())
      break
    case 'S3':
      defaultProvider = createS3CompatibleObjectStorage(process.env)
      break
    default:
      throw new ObjectStorageError(
        'object_storage_driver_unknown',
        'OBJECT_STORAGE_DRIVER names no implemented adapter; local storage is never a substitute.',
        false,
      )
  }
  return defaultProvider
}

/** Drops the memoized provider so a configuration change (or a test
 * that varies the driver) is observed rather than cached forever. */
export function resetObjectStorageDefaultForTests(): void {
  defaultProvider = null
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
