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

/**
 * Admin area destinations, grouped as the UI direction's §10.5 sidebar
 * shows them, and gated by the SAME permission strings the old admin
 * header used. Hiding a link is a courtesy, never the boundary: every
 * mutation behind these routes re-checks permissions server-side.
 *
 * `permission: null` means "any admin context at all" — the /admin
 * guard has already proved that much.
 */
export interface AdminNavItem extends NavItem {
  permission: string | null
}

export interface AdminNavGroup {
  label: string
  items: ReadonlyArray<AdminNavItem>
}

export const ADMIN_NAV: ReadonlyArray<AdminNavGroup> = [
  {
    label: 'Catalogue',
    items: [
      { label: 'Overview', to: '/admin', permission: null },
      {
        label: 'Deity Profiles',
        to: '/admin/catalogue/deities',
        permission: null,
      },
      {
        label: 'Sacred Houses',
        to: '/admin/catalogue/sacred-houses',
        permission: null,
      },
      { label: 'Services', to: '/admin/catalogue/services', permission: null },
      {
        label: 'Review Queue',
        to: '/admin/catalogue/review',
        permission: 'catalogue.approve',
      },
    ],
  },
  {
    label: 'Operations',
    items: [
      {
        label: 'Scheduling',
        to: '/admin/scheduling',
        permission: 'availability.manage',
      },
      {
        label: 'Appointments',
        to: '/admin/appointments',
        permission: 'appointments.view',
      },
      { label: 'Payments', to: '/admin/payments', permission: 'payments.view' },
    ],
  },
  {
    label: 'Content',
    items: [
      {
        label: 'Spiritual Guidance',
        to: '/admin/spiritual-content',
        permission: 'spiritual_content.view',
      },
      {
        label: 'Sacred Content',
        to: '/admin/sacred-content',
        permission: 'spiritual_content.view',
      },
      {
        label: 'Prayer Templates',
        to: '/admin/prayer-templates',
        permission: 'spiritual_content.view',
      },
    ],
  },
  {
    label: 'Production',
    items: [
      { label: 'Media', to: '/admin/media-assets', permission: 'media.view' },
      {
        label: 'Visual Bibles',
        to: '/admin/visual-bibles',
        permission: 'media.view',
      },
      {
        label: 'Recipes',
        to: '/admin/video-recipes',
        permission: 'media.view',
      },
      {
        label: 'Generation',
        to: '/admin/generation-jobs',
        permission: 'appointments.view',
      },
    ],
  },
]
