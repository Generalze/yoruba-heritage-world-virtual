import { env } from '@/lib/env'
import { createDisabledEmailProvider } from './disabled'
import { createMockEmailProvider } from './mock'
import { EmailProviderError } from './types'
import type { EmailChannelProvider } from './types'

/**
 * Email channel access point (Phase One, Step 23).
 *
 * The ONLY way the notification dispatcher obtains a channel. Mirrors
 * the TTS registry: a single active provider slot, swappable for tests,
 * selected by an explicit validated enum.
 *
 * TWO configurations exist today. MOCK is the deterministic in-memory
 * channel for development and test — refused in production by env
 * validation, not by this file. DISABLED is the honest statement that
 * no email backend is configured, which is the correct production
 * setting until a vendor is approved.
 *
 * There is NO fallback between them, and no third branch that quietly
 * becomes the mock: a driver added to the enum and forgotten here
 * stops the process rather than sending member mail through a fake.
 */

let overrideProvider: EmailChannelProvider | null = null
let defaultProvider: EmailChannelProvider | null = null

export function getEmailProvider(): EmailChannelProvider {
  if (overrideProvider) return overrideProvider
  if (defaultProvider) return defaultProvider
  switch (env.NOTIFICATION_EMAIL_DRIVER) {
    case 'MOCK':
      defaultProvider = createMockEmailProvider()
      break
    case 'DISABLED':
      defaultProvider = createDisabledEmailProvider()
      break
    default:
      throw new EmailProviderError(
        'email_driver_unknown',
        'NOTIFICATION_EMAIL_DRIVER names no implemented adapter; the mock is never a substitute.',
        false,
      )
  }
  return defaultProvider
}

/** Injects a channel for tests. Pass null to restore selection by env. */
export function setEmailProviderForTests(
  provider: EmailChannelProvider | null,
): void {
  overrideProvider = provider
}

/** Drops the memoized provider so a configuration change is observed. */
export function resetEmailProviderForTests(): void {
  overrideProvider = null
  defaultProvider = null
}
