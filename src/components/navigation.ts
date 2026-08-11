/**
 * Navigation models for the public site chrome and the authenticated
 * shell (Step 21A).
 *
 * PLAIN DATA, deliberately JSX-free: tests import these arrays and
 * prove every destination exists in the generated route tree, which is
 * how the UI direction's rule — "only link to routes that actually
 * exist" — stays a tested invariant instead of a hope. Add an entry
 * here only for a route that already exists; never invent an empty
 * module because the design reference shows one.
 */

export interface NavItem {
  label: string
  to: string
}

/** Public header/footer destinations — every one is a live route. */
export const PUBLIC_NAV: ReadonlyArray<NavItem> = [
  { label: 'Home', to: '/' },
  { label: 'Sacred Houses', to: '/sacred-houses' },
  { label: 'Deities', to: '/deities' },
  { label: 'Services', to: '/services' },
  { label: 'Olódùmárè', to: '/olodumare' },
]

/**
 * Authenticated shell destinations — the user-facing routes that exist
 * today. Booking, checkout and the Prayer Room are reached from within
 * these surfaces (they need an appointment/service context), so they
 * are not top-level sidebar items.
 */
export const APP_NAV: ReadonlyArray<NavItem> = [
  { label: 'Dashboard', to: '/dashboard' },
  { label: 'Appointments', to: '/appointments' },
  { label: 'Payments', to: '/payments' },
  { label: 'My Profile', to: '/profile' },
  { label: 'Spiritual Interests', to: '/profile/spiritual' },
  { label: 'Consents', to: '/profile/consents' },
]

/** Public discovery links repeated in the shell for convenience. */
export const APP_DISCOVER_NAV: ReadonlyArray<NavItem> = [
  { label: 'Sacred Houses', to: '/sacred-houses' },
  { label: 'Services', to: '/services' },
]
