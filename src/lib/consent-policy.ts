import type { ConsentType } from '@/db/schema'

/**
 * Development version identifiers. Approved legal text and real version
 * numbers replace these through the governed notice workflow; bumping a
 * version makes re-acceptance required because consent rows are scoped by
 * (type, version).
 */
export const CONSENT_VERSIONS: Record<ConsentType, string> = {
  TERMS: '1',
  PRIVACY: '1',
  SPIRITUAL_NOTICE: '1',
  MARKETING: '1',
}

/** Marketing is optional, never required. */
export const REQUIRED_CONSENT_TYPES: ReadonlyArray<ConsentType> = [
  'TERMS',
  'PRIVACY',
  'SPIRITUAL_NOTICE',
]
