import { ObjectStorageError } from './types'
import type { ObjectStorageProvider } from './types'

/**
 * S3-compatible production adapter BOUNDARY (Phase One, Step 17).
 *
 * This file is the seam, and deliberately not an implementation yet.
 * Phase One ships no production deployment and performs no paid or
 * network calls in verification, so shipping an SDK-backed adapter now
 * would add an unexercised dependency and an untested code path to the
 * one place that must never be improvised: where a finished prayer
 * video leaves this machine.
 *
 * What DOES ship here is the part that must exist before any adapter
 * can: the configuration contract, its validation, and a fail-closed
 * factory. Production can therefore never quietly fall back to local
 * storage — it either has a real adapter configured or it refuses to
 * run the upload stage at all.
 *
 * REQUIREMENTS ON THE FUTURE ADAPTER (all enforced by the interface it
 * must satisfy, see types.ts):
 * - credentials, endpoint, region and bucket come from environment
 *   secrets and never appear in a service, a row, an event or a log;
 * - every write is PRIVATE: no public-read ACL, no public bucket
 *   policy, no public URL, no CDN origin;
 * - `verifyPrivateObjectIntegrity` must use provider-supported checksum
 *   verification (e.g. an SHA-256 checksum recorded at upload and
 *   re-read on head/get) and MUST fail closed when equivalent integrity
 *   cannot be proved. An ETag is never accepted as a SHA-256;
 * - `createSignedReadUrl` issues a short-lived PRIVATE GET only,
 *   bounded by MAX_SIGNED_URL_TTL_SECONDS.
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
 * Constructs the production adapter. Validates configuration first so a
 * misconfigured deployment fails on its config rather than at the
 * moment it tries to upload someone's prayer video, then fails closed
 * because no SDK-backed implementation has landed yet.
 *
 * It NEVER returns a local provider as a substitute. Silent fallback is
 * the specific failure this function exists to make impossible.
 */
export function createS3CompatibleObjectStorage(
  source: Record<string, string | undefined>,
): ObjectStorageProvider {
  const resolved = resolveS3CompatibleConfig(source)
  if (!resolved.ok) {
    throw new ObjectStorageError(
      'object_storage_misconfigured',
      `S3-compatible object storage is missing configuration: ${resolved.missing.join(', ')}.`,
      false,
    )
  }
  throw new ObjectStorageError(
    'object_storage_adapter_not_installed',
    'No S3-compatible object storage adapter is installed in this build. Configure a real adapter; local storage is never a production substitute.',
    false,
  )
}
