/**
 * Email channel contract for notifications (Phase One, canon §42
 * item 23; rules in TECHNICAL_CANON.md §48).
 *
 * Deliberately tiny. Phase One has no approved email vendor, so this
 * exists to define the SEAM one would occupy, not to anticipate its
 * feature set: no templates, no attachments, no tracking pixels, no
 * bulk send. One message, one recipient, one plain-text body.
 *
 * The body is composed from safe snapshots by the notification service
 * before it ever reaches a provider — a provider never reads the
 * database and never learns anything a notification did not already
 * carry.
 */

export interface EmailMessage {
  /** The member's own address, from their account. */
  to: string
  subject: string
  /** Plain text. No HTML is composed or sent. */
  body: string
  /**
   * The notification's public id, so a provider's own logs can be
   * correlated with ours without exposing an internal row id.
   */
  reference: string
}

export interface EmailSendResult {
  /** The provider's identifier for the accepted message, if it gives one. */
  providerMessageId: string | null
}

export class EmailProviderError extends Error {
  /** Whether trying the same message again could plausibly succeed. */
  readonly retryable: boolean
  readonly code: string

  constructor(code: string, message: string, retryable: boolean) {
    super(message)
    this.name = 'EmailProviderError'
    this.code = code
    this.retryable = retryable
  }
}

export interface EmailChannelProvider {
  readonly code: string
  readonly displayName: string
  send: (message: EmailMessage) => Promise<EmailSendResult>
}
