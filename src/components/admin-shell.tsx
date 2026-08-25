import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { ADMIN_NAV } from './navigation'
import { BrandMark, IconClose, IconMenu, SkipLink } from './ui'

/**
 * Shared admin shell (Step 21A.6): the dark sidebar and cream
 * workspace of UI_VISUAL_DIRECTION.md §10.5, replacing the single
 * crowded dark bar the admin area used to wear.
 *
 * PRESENTATIONAL ONLY. Authorization is unchanged and stays where it
 * lives: the /admin route's beforeLoad guard, and a server-side
 * permission check inside every mutation. This shell only decides
 * which links are worth SHOWING an operator — a hidden link is a
 * courtesy, never a boundary.
 *
 * Groups collapse into a disclosure panel on small screens; the toggle
 * carries aria-expanded/aria-controls and every destination stays a
 * real anchor. Page content lands in <main id="main-content"> so the
 * SkipLink always has its target.
 */

function AdminNavLinks({
  permissions,
  idPrefix,
  onNavigate,
}: {
  permissions: ReadonlyArray<string>
  idPrefix: string
  onNavigate?: () => void
}) {
  return (
    <>
      {ADMIN_NAV.map((group) => {
        const visible = group.items.filter(
          (item) =>
            item.permission === null || permissions.includes(item.permission),
        )
        if (visible.length === 0) return null
        const labelId = `${idPrefix}-${group.label.toLowerCase()}`
        return (
          <div key={group.label} className="mt-5 first:mt-0">
            {/* A plain label, not a heading: the page's own <h1> owns
                the document outline. */}
            <p
              id={labelId}
              className="px-3 text-[0.65rem] font-semibold tracking-[0.28em] text-cream-soft-on-night uppercase"
            >
              {group.label}
            </p>
            <ul aria-labelledby={labelId} className="mt-2 flex flex-col gap-1">
              {visible.map((item) => (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    activeOptions={{ exact: item.to === '/admin' }}
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
          </div>
        )
      })}
    </>
  )
}

export function AdminShell({
  userName,
  permissions,
  children,
}: {
  /** The signed-in operator's real preferredName — never a placeholder. */
  userName: string
  /** The operator's actual granted permissions, from the server guard. */
  permissions: ReadonlyArray<string>
  children: ReactNode
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="min-h-screen bg-canvas text-ink lg:flex">
      <SkipLink />

      {/* Mobile topbar */}
      <header className="texture-night flex items-center justify-between gap-3 border-b border-night-line bg-night px-4 py-3 lg:hidden">
        <Link
          to="/admin"
          className="flex min-w-0 items-center gap-2 text-cream-on-night"
        >
          <span className="text-gold">
            <BrandMark className="h-6 w-6" />
          </span>
          <span className="min-w-0 leading-tight">
            <span className="font-display block truncate text-sm">
              Yorùbá Heritage World
            </span>
            <span className="block text-[0.55rem] font-semibold tracking-[0.3em] text-cream-soft-on-night uppercase">
              Admin
            </span>
          </span>
        </Link>
        <button
          type="button"
          className="inline-flex items-center justify-center rounded-md border border-night-line p-2 text-cream-on-night transition-colors hover:border-gold hover:text-gold-bright"
          aria-expanded={menuOpen}
          aria-controls="admin-menu"
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
          id="admin-menu"
          aria-label="Admin"
          className="texture-night border-b border-night-line bg-night px-4 py-4 lg:hidden"
        >
          <AdminNavLinks
            permissions={permissions}
            idPrefix="admin-menu"
            onNavigate={() => setMenuOpen(false)}
          />
        </nav>
      ) : null}

      {/* Desktop sidebar */}
      <div className="texture-night hidden w-64 shrink-0 flex-col border-r border-night-line bg-night lg:flex">
        <div className="px-5 pt-6 pb-4">
          <Link
            to="/admin"
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
                Admin
              </span>
            </span>
          </Link>
        </div>
        <nav aria-label="Admin" className="flex-1 overflow-y-auto px-3 pb-6">
          <AdminNavLinks permissions={permissions} idPrefix="admin-sidebar" />
        </nav>
        <div className="border-t border-night-line px-5 py-4">
          <p className="truncate text-sm text-cream-on-night">{userName}</p>
          <p className="text-xs text-cream-soft-on-night">Signed in</p>
        </div>
      </div>

      {/* Workspace */}
      <div className="min-w-0 flex-1">
        <main id="main-content" className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
          {children}
        </main>
      </div>
    </div>
  )
}
