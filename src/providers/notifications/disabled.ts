import { EmailProviderError } from './types'
import type { EmailChannelProvider } from './types'

/**
 * The HONEST absence of an email backend.
 *
 * No email vendor has been approved for this platform, and this
 * codebase does not choose one on its own initiative. This is the
 * truthful production configuration until one is: email delivery is
 * unavailable, and every attempt is refused loudly rather than skipped
 * quietly.
 *
 * A refused email is not a lost notification. The in-app channel is
 * independent and has already delivered the same record, so a member
 * never misses the fact of a confirmed appointment because no vendor
 * is configured — they simply do not also get an email about it.
 */

export const DISABLED_EMAIL_CODE = 'DISABLED'

export function createDisabledEmailProvider(): EmailChannelProvider {
  return {
    code: DISABLED_EMAIL_CODE,
    displayName: 'Email delivery unavailable',
    async send(): Promise<never> {
      throw new EmailProviderError(
        'email_disabled',
        'No approved email adapter is configured for this deployment.',
        // Deterministic, not transient: retrying cannot install a vendor.
        false,
      )
    },
  }
}
