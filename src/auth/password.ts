/**
 * Centralized password hashing (canon §26; stage spec §5).
 *
 * Argon2id via Bun's built-in `Bun.password` — no external dependency,
 * no paid service. Parameters follow current OWASP guidance (~19 MiB
 * memory, 2 iterations) and are centralized here so they can be raised
 * later; verification remains backwards-compatible because Argon2
 * encodes its parameters inside the hash string.
 *
 * Never log passwords or hashes. Never return hashes to clients.
 */

const HASHING_OPTIONS = {
  algorithm: 'argon2id',
  memoryCost: 19456, // KiB (~19 MiB)
  timeCost: 2,
} as const

export async function hashPassword(password: string): Promise<string> {
  return await Bun.password.hash(password, HASHING_OPTIONS)
}

export async function verifyPassword(
  password: string,
  passwordHash: string,
): Promise<boolean> {
  try {
    return await Bun.password.verify(password, passwordHash)
  } catch {
    // Malformed/foreign hash strings must fail closed, not throw.
    return false
  }
}

let dummyHashPromise: Promise<string> | undefined

/**
 * Hash of a random throwaway value, computed once per process. Login
 * verifies against this when the email is unknown so response timing
 * does not reveal whether an account exists.
 */
export function getDummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(crypto.randomUUID())
  return dummyHashPromise
}
