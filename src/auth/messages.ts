/**
 * User-facing messages for auth failure codes. Client-safe module (no
 * server imports). INVALID_CREDENTIALS is deliberately generic and is
 * also used for suspended/disabled accounts so responses never reveal
 * whether an email is registered or why access was denied.
 */
export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  EMAIL_IN_USE: 'An account with this email already exists.',
  INVALID_CREDENTIALS: 'Invalid email or password.',
  RATE_LIMITED: 'Too many attempts. Please wait a few minutes and try again.',
}

export function authErrorMessage(code?: string): string {
  return (
    (code !== undefined && AUTH_ERROR_MESSAGES[code]) ||
    'Something went wrong. Please try again.'
  )
}
