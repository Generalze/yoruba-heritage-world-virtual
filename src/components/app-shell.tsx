import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { APP_DISCOVER_NAV, APP_NAV } from './navigation'
import { BrandMark, IconClose, IconMenu, SkipLink } from './ui'

/**
 * Shared authenticated shell (Step 21A): the deep-brown left sidebar
 * with a warm cream workspace from UI_VISUAL_DIRECTION.md §7/§10.2.
 *
 * PRESENTATIONAL ONLY. Authorization stays where it lives today — each
 * route's beforeLoad guard and the server functions behind it. The
 * shell renders navigation to the user-facing routes that exist
 * (APP_NAV, tested against the generated route tree), shows the
 * signed-in identity it is given, and hosts whatever page content the
 * route renders into it. It fabricates nothing: no member IDs, no
 * verification states, no statistics.
 *
 * On small screens the sidebar collapses into a topbar with a
 * disclosure panel; the toggle carries aria-expanded/aria-controls and
 * all navigation remains real anchors. Page content lands in
 * <main id="main-content"> so the SkipLink target is always present.
 */

function ShellNavLinks({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <ul className="flex flex-col gap-1">
        {APP_NAV.map((item) => (
          <li key={item.to}>
            <Link
              to={item.to}
              activeOptions={{ exact: item.to === '/dashboard' }}
              activeProps={{
                className: 'bg-night-raised text-gold-bright',
                'aria-current': 'page',
              }}
              inactiveProps={{
                className:
                  'text-cream-soft-on-night hover:bg-night-raised hover:text-cream-on-night',
              }}
              className="block rounded-md px-3 py-2 text-sm font-medium transition-colors"
              onClick={onNavigate}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
      <h2 className="mt-6 px-3 text-[0.65rem] font-semibold tracking-[0.28em] text-cream-soft-on-night uppercase">
        Discover
      </h2>
      <ul className="mt-2 flex flex-col gap-1">
        {APP_DISCOVER_NAV.map((item) => (
          <li key={item.to}>
            <Link
              to={item.to}
              className="block rounded-md px-3 py-2 text-sm font-medium text-cream-soft-on-night transition-colors hover:bg-night-raised hover:text-cream-on-night"
              onClick={onNavigate}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </>
  )
}

export function AppShell({
  userName,
  children,
  actions,
}: {
  /** The signed-in user's real preferredName — never a placeholder. */
  userName: string
  /** Page content, rendered into the cream workspace. */
  children: ReactNode
  /** Optional page-level actions (e.g. the route's sign-out button). */
  actions?: ReactNode
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="min-h-screen bg-canvas text-ink lg:flex">
      <SkipLink />

      {/* Mobile topbar */}
      <header className="texture-night flex items-center justify-between gap-3 border-b border-night-line bg-night px-4 py-3 lg:hidden">
        <Link
          to="/dashboard"
          className="flex items-center gap-2 text-cream-on-night"
        >
          <span className="text-gold">
            <BrandMark className="h-6 w-6" />
          </span>
          <span className="font-display text-base">
            Yorùbá Heritage World
          </span>
        </Link>
        <button
          type="button"
          className="inline-flex items-center justify-center rounded-md border border-night-line p-2 text-cream-on-night transition-colors hover:border-gold hover:text-gold-bright"
          aria-expanded={menuOpen}
          aria-controls="app-menu"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className="sr-only">
            {menuOpen ? 'Close navigation' : 'Open navigation'}
          </span>
          {menuOpen ? <IconClose /> : <IconMenu />}
        </button>
      </header>

      {/* Mobile navigation panel */}
      {menuOpen ? (
        <nav
          id="app-menu"
          aria-label="Account"
          className="texture-night border-b border-night-line bg-night px-4 py-4 lg:hidden"
        >
          <ShellNavLinks onNavigate={() => setMenuOpen(false)} />
        </nav>
      ) : null}

      {/* Desktop sidebar */}
      <div className="texture-night hidden w-64 shrink-0 flex-col border-r border-night-line bg-night lg:flex">
        <div className="px-5 pt-6 pb-4">
          <Link
            to="/dashboard"
            className="flex items-center gap-3 text-cream-on-night transition-colors hover:text-gold-bright"
          >
            <span className="text-gold">
              <BrandMark className="h-7 w-7" />
            </span>
            <span className="leading-tight">
              <span className="font-display block text-base">
                Yorùbá Heritage World
              </span>
              <span className="block text-[0.6rem] font-semibold tracking-[0.3em] text-cream-soft-on-night uppercase">
                Virtual
              </span>
            </span>
          </Link>
        </div>
        <nav
          aria-label="Account"
          className="flex-1 overflow-y-auto px-3 pb-6"
        >
          <ShellNavLinks />
        </nav>
        <div className="border-t border-night-line px-5 py-4">
          <p className="truncate text-sm text-cream-on-night">{userName}</p>
          <p className="text-xs text-cream-soft-on-night">Signed in</p>
        </div>
      </div>

      {/* Workspace */}
      <div className="min-w-0 flex-1">
        {actions ? (
          <div className="border-b border-line bg-surface">
            <div className="mx-auto flex w-full max-w-5xl items-center justify-end gap-3 px-6 py-3">
              {actions}
            </div>
          </div>
        ) : null}
        <main id="main-content" className="mx-auto w-full max-w-5xl px-6 py-10">
          {children}
        </main>
      </div>
    </div>
  )
}
