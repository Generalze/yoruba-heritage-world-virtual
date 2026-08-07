/**
 * Canonical email normalization: applied before every storage and
 * comparison so `Ade@Example.COM ` and `ade@example.com` are the same
 * account. Kept deliberately minimal — no provider-specific rewriting
 * (gmail dots, plus-addressing), which would conflate distinct
 * addresses.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}
