import { EmailProviderError } from './types'
import type {
  EmailChannelProvider,
  EmailMessage,
  EmailSendResult,
} from './types'

/**
 * Deterministic in-memory email channel (development and test only).
 *
 * Canon requires mock providers in development, and this one makes NO
 * network call of any kind — there is no fetch, no SDK and no socket in
 * this file. It records what would have been sent so tests can assert
 * on it, and nothing leaves the process.
 *
 * It is refused in production by the registry, not by politeness here.
 */

export const MOCK_EMAIL_CODE = 'MOCK'

export interface RecordedEmail extends EmailMessage {
  sentAtMs: number
}

/**
 * Sent messages, newest last. Module-level so a test can inspect what
 * the dispatcher did without threading the provider through every call.
 */
const outbox: Array<RecordedEmail> = []

export function readMockOutbox(): ReadonlyArray<RecordedEmail> {
  return outbox
}

export function clearMockOutbox(): void {
  outbox.length = 0
}

/**
 * An address the mock always refuses, so the FAILURE path is testable
 * without waiting for a real provider to misbehave. Anything else is
 * accepted.
 */
export const MOCK_FAILING_ADDRESS = 'bounce@mock.invalid'

export function createMockEmailProvider(options?: {
  nowMs?: () => number
}): EmailChannelProvider {
  const nowMs = options?.nowMs ?? (() => Date.now())
  return {
    code: MOCK_EMAIL_CODE,
    displayName: 'Mock email channel',
    async send(message: EmailMessage): Promise<EmailSendResult> {
      if (message.to === MOCK_FAILING_ADDRESS) {
        throw new EmailProviderError(
          'mock_rejected_recipient',
          'The mock email channel refuses this address by design.',
          // Not retryable: the address is the problem, not the moment.
          false,
        )
      }
      outbox.push({ ...message, sentAtMs: nowMs() })
      return { providerMessageId: `mock-${message.reference}` }
    },
  }
}
