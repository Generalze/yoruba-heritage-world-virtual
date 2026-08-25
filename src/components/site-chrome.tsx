import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { PUBLIC_NAV } from './navigation'
import { BrandMark, IconClose, IconMenu, SkipLink, buttonClass } from './ui'

/**
 * The public page frame: skip link, header, the single <main> the skip
 * link targets, and the footer. Every public route uses this so the
 * chrome and the accessibility affordances cannot drift apart between
 * pages.
 */
export function PublicPage({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <SkipLink />
      <SiteHeader />
      <main id="main-content">{children}</main>
      <SiteFooter />
    </div>
  )
}

/**
 * Public site chrome (Step 21A): the responsive header/navigation and
 * footer shared by public pages, per UI_VISUAL_DIRECTION.md §7 — a
 * refined horizontal header on a deep-brown ground, gold reserved for
 * the active state and the one Join call-to-action.
 *
 * Every destination comes from PUBLIC_NAV, which links only to routes
 * that actually exist (tested against the generated route tree). On
 * small screens the navigation collapses into a disclosure panel with
 * full keyboard support: the toggle carries aria-expanded/aria-controls
 * and every link remains a real focusable anchor.
 */

function BrandLockup() {
  return (
    <Link
      to="/"
      className="flex min-w-0 items-center gap-3 text-cream-on-night transition-colors hover:text-gold-bright"
    >
      <span className="text-gold">
        <BrandMark className="h-8 w-8" />
      </span>
      <span className="min-w-0 leading-tight">
        <span className="font-display block truncate text-lg">
          Yorùbá Heritage World
        </span>
        <span className="block text-[0.65rem] font-semibold tracking-[0.3em] text-cream-soft-on-night uppercase">
          Virtual
        </span>
      </span>
    </Link>
  )
}

export function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <header className="texture-night border-b border-night-line bg-night">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <BrandLockup />

        {/* Desktop navigation */}
        <nav aria-label="Primary" className="hidden items-center gap-6 lg:flex">
          {PUBLIC_NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.to === '/' }}
              activeProps={{
                className: 'text-gold-bright',
                'aria-current': 'page',
              }}
              inactiveProps={{
                className:
                  'text-cream-soft-on-night hover:text-cream-on-night',
              }}
              className="text-sm font-medium transition-colors"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-3 lg:flex">
          <Link
            to="/login"
            className="text-sm font-medium text-cream-soft-on-night transition-colors hover:text-cream-on-night"
          >
            Log in
          </Link>
          <Link to="/register" className={buttonClass('primary', 'md')}>
            Join now
          </Link>
        </div>

        {/* Mobile menu toggle */}
        <button
          type="button"
          className="inline-flex items-center justify-center rounded-md border border-night-line p-2 text-cream-on-night transition-colors hover:border-gold hover:text-gold-bright lg:hidden"
          aria-expanded={menuOpen}
          aria-controls="site-menu"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className="sr-only">
            {menuOpen ? 'Close menu' : 'Open menu'}
          </span>
          {menuOpen ? <IconClose /> : <IconMenu />}
        </button>
      </div>

      {/* Mobile navigation panel */}
      {menuOpen ? (
        <nav
          id="site-menu"
          aria-label="Primary"
          className="border-t border-night-line px-4 pt-2 pb-6 sm:px-6 lg:hidden"
        >
          <ul className="flex flex-col gap-1">
            {PUBLIC_NAV.map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  activeOptions={{ exact: item.to === '/' }}
                  activeProps={{
                    className: 'text-gold-bright',
                    'aria-current': 'page',
                  }}
                  inactiveProps={{ className: 'text-cream-on-night' }}
                  className="block rounded-md px-3 py-2.5 text-base font-medium transition-colors hover:bg-night-raised"
                  onClick={() => setMenuOpen(false)}
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-col gap-3 border-t border-night-line pt-4">
            <Link
              to="/login"
              className={buttonClass('secondary-on-dark', 'md')}
              onClick={() => setMenuOpen(false)}
            >
              Log in
            </Link>
            <Link
              to="/register"
              className={buttonClass('primary', 'md')}
              onClick={() => setMenuOpen(false)}
            >
              Join now
            </Link>
          </div>
        </nav>
      ) : null}
    </header>
  )
}

export function SiteFooter() {
  return (
    <footer className="texture-night border-t border-night-line bg-night">
      <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6">
        <div className="flex flex-col gap-10 md:flex-row md:items-start md:justify-between">
          <div className="max-w-sm">
            <BrandLockup />
            <p className="mt-4 text-sm leading-relaxed text-cream-soft-on-night">
              A digital home for Yorùbá prayer, ancestral connection and
              sacred cultural practice.
            </p>
          </div>

          <nav aria-label="Footer">
            <h2 className="text-xs font-semibold tracking-[0.28em] text-gold-bright uppercase">
              Explore
            </h2>
            <ul className="mt-4 grid gap-x-10 gap-y-2 min-[360px]:grid-cols-2">
              {PUBLIC_NAV.map((item) => (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    className="text-sm text-cream-soft-on-night transition-colors hover:text-cream-on-night"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
              <li>
                <Link
                  to="/login"
                  className="text-sm text-cream-soft-on-night transition-colors hover:text-cream-on-night"
                >
                  Log in
                </Link>
              </li>
              <li>
                <Link
                  to="/register"
                  className="text-sm text-cream-soft-on-night transition-colors hover:text-cream-on-night"
                >
                  Join now
                </Link>
              </li>
            </ul>
          </nav>
        </div>

        <div className="mt-10 border-t border-night-line pt-6">
          <p className="text-xs text-cream-soft-on-night">
            Appointments and Prayer Rooms are private to your account.
          </p>
        </div>
      </div>
    </footer>
  )
}
