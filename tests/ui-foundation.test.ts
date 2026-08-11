import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

import {
  APP_DISCOVER_NAV,
  APP_NAV,
  PUBLIC_NAV,
} from '@/components/navigation'
import { formatDurationMinutes, formatMinorAmount } from '@/lib/format'

/**
 * ============================================================================
 * UI FOUNDATION — Phase One, Step 21A.
 *
 * The repo has no DOM test harness by design, so these tests follow the
 * established house pattern: pure-function units, plus source/route-tree
 * invariants that keep the UI direction's hard rules — link only to real
 * routes, invent no prices or spiritual copy, keep Olódùmárè separate,
 * keep accessibility affordances present — from silently eroding.
 * ============================================================================
 */

const read = (relativePath: string): string =>
  readFileSync(join(process.cwd(), relativePath), 'utf8')

/** Comments stripped, so prose ABOUT a rule cannot satisfy or violate
 * the rule — the house pattern from the deployment-topology suite. */
const withoutComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

// --- Formatting helpers -------------------------------------------------------

describe('formatMinorAmount', () => {
  it('formats real minor-unit amounts in their real currency', () => {
    const naira = formatMinorAmount(500_000, 'NGN')
    expect(naira).not.toBeNull()
    expect(naira!).toContain('5,000')
    expect(naira!).toMatch(/₦|NGN/)

    const dollars = formatMinorAmount(12_050, 'USD')
    expect(dollars).not.toBeNull()
    expect(dollars!).toContain('120.50')
    expect(dollars!).toContain('$')
  })

  it('respects zero-decimal currencies instead of assuming cents', () => {
    const yen = formatMinorAmount(1_200, 'JPY')
    expect(yen).not.toBeNull()
    expect(yen!).toContain('1,200')
    expect(yen!).not.toContain('.')
  })

  it('renders NOTHING for malformed input — a price is never guessed', () => {
    expect(formatMinorAmount(-1, 'NGN')).toBeNull()
    expect(formatMinorAmount(10.5, 'NGN')).toBeNull()
    expect(formatMinorAmount(Number.NaN, 'NGN')).toBeNull()
    expect(formatMinorAmount(1000, 'US')).toBeNull()
    expect(formatMinorAmount(1000, 'N GN')).toBeNull()
  })
})

describe('formatDurationMinutes', () => {
  it('formats real stored durations and refuses the rest', () => {
    expect(formatDurationMinutes(60)).toBe('60 minutes')
    expect(formatDurationMinutes(1)).toBe('1 minute')
    expect(formatDurationMinutes(0)).toBeNull()
    expect(formatDurationMinutes(-5)).toBeNull()
    expect(formatDurationMinutes(2.5)).toBeNull()
  })
})

// --- "Only link to routes that actually exist" --------------------------------

describe('navigation destinations are real routes', () => {
  const routeTree = read('src/routeTree.gen.ts')
  const fullPaths = new Set(
    [...routeTree.matchAll(/fullPath: '([^']*)'/g)].map((match) => match[1]),
  )
  const exists = (to: string): boolean =>
    fullPaths.has(to) || fullPaths.has(`${to}/`)

  it('every public navigation destination exists in the generated route tree', () => {
    for (const item of PUBLIC_NAV) {
      expect(exists(item.to)).toBe(true)
    }
  })

  it('every authenticated shell destination exists in the generated route tree', () => {
    for (const item of [...APP_NAV, ...APP_DISCOVER_NAV]) {
      expect(exists(item.to)).toBe(true)
    }
  })

  it('invents no empty modules from the design reference', () => {
    // The showcase shows About/Resources/Messages/Settings — none of
    // those routes exist, so no nav model may point at them.
    const all = [...PUBLIC_NAV, ...APP_NAV, ...APP_DISCOVER_NAV]
    for (const item of all) {
      expect(item.to).not.toMatch(/about|resources|messages|settings|help/i)
    }
  })
})

// --- Design tokens and typography ---------------------------------------------

describe('design tokens', () => {
  const css = read('src/styles.css')

  it('defines the semantic palette and typography as Tailwind theme tokens', () => {
    expect(css).toContain('@theme')
    for (const token of [
      '--color-canvas',
      '--color-surface',
      '--color-ink',
      '--color-night',
      '--color-gold',
      '--color-line',
      '--font-display',
      '--font-sans',
    ]) {
      expect(css).toContain(token)
    }
  })

  it('keeps every asset self-hosted — the CSP has no external origin', () => {
    // font-src 'self' data:; img-src 'self' data: blob:. Nothing in the
    // stylesheet may FETCH from a CDN, webfont host or remote image —
    // every url() must be a data: URI or a same-origin path. (The SVG
    // xmlns inside a data: URI is a namespace name, not a fetch.)
    expect(css).not.toMatch(/url\(\s*["']?https?:/i)
    expect(css).not.toContain('@import url(')
    expect(css).toContain('url("data:image/svg+xml')
  })

  it('respects prefers-reduced-motion and keeps keyboard focus visible', () => {
    expect(css).toContain('prefers-reduced-motion')
    expect(css).toContain(':focus-visible')
  })
})

// --- Landing page content policy ----------------------------------------------

describe('landing page (src/routes/index.tsx)', () => {
  const source = read('src/routes/index.tsx')
  const code = withoutComments(source)

  it('renders REAL catalogue data through the public read contracts', () => {
    expect(code).toContain('listSacredHousesFn')
    expect(code).toContain('listServicesFn')
    expect(code).toContain('listDeitiesFn')
  })

  it('renders NO price on the landing page — locked, even when one is stored', () => {
    // The landing lock from the Step 21A fidelity pass: featured
    // services never show price/currency here. Real prices surface in
    // the booking flow, not on discovery.
    expect(code).not.toMatch(/[$₦]\s*\d/)
    expect(code).not.toMatch(/From \$/i)
    expect(code).not.toContain('formatMinorAmount')
    expect(code).not.toContain('priceMinor')
    expect(code).not.toContain('currency')
    expect(code).not.toMatch(/testimonial/i)
  })

  it('presents Olódùmárè separately, respectfully, and BEFORE the deity profiles', () => {
    // The approved wording from the existing /olodumare page, verbatim.
    expect(code).toContain(
      'Olódùmárè is presented separately and respectfully',
    )
    expect(code).toContain('to="/olodumare"')
    // LOCKED landing order: … Sacred Houses → Olódùmárè → deity
    // profiles. Olódùmárè is its own ceremonial section ahead of the
    // grid, never an entry inside the deity map.
    const olodumareSection = code.indexOf('Olódùmárè is presented separately')
    const deityGrid = code.indexOf('deities.map')
    expect(olodumareSection).toBeGreaterThan(-1)
    expect(deityGrid).toBeGreaterThan(-1)
    expect(olodumareSection).toBeLessThan(deityGrid)
  })

  it('follows the locked section order: services → houses → Olódùmárè → deities → trust', () => {
    const markers = [
      'Featured Spiritual Services',
      '<EmblemMedallion',
      'Olódùmárè is presented separately',
      'deities.map',
      'Built for dignity and privacy',
    ]
    const positions = markers.map((marker) => code.indexOf(marker))
    for (const position of positions) expect(position).toBeGreaterThan(-1)
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1])
    }
  })

  it('keeps the skip-link target, page chrome and the illustrated hero', () => {
    expect(source).toContain('SkipLink')
    expect(source).toContain('id="main-content"')
    expect(source).toContain('SiteHeader')
    expect(source).toContain('SiteFooter')
    // The reference-matching hero tableau — a standalone original
    // asset, never a crop of the showcase screenshot.
    expect(source).toContain('HeroTableau')
  })
})

// --- Chrome and shell accessibility ---------------------------------------------

describe('site chrome and authenticated shell', () => {
  const chrome = read('src/components/site-chrome.tsx')
  const shell = read('src/components/app-shell.tsx')
  const ui = read('src/components/ui.tsx')

  it('mobile disclosure menus are real buttons with ARIA state', () => {
    for (const source of [chrome, shell]) {
      expect(source).toContain('aria-expanded')
      expect(source).toContain('aria-controls')
      expect(source).toContain('type="button"')
    }
  })

  it('navigation landmarks are labelled', () => {
    expect(chrome).toContain('aria-label="Primary"')
    expect(chrome).toContain('aria-label="Footer"')
    expect(shell).toContain('aria-label="Account"')
  })

  it('decorative graphics are hidden from assistive technology', () => {
    expect(ui).toContain('aria-hidden="true"')
    expect(ui).toContain('href="#main-content"')
  })

  it('renders no raw HTML anywhere in the new UI layer', () => {
    for (const source of [chrome, shell, ui]) {
      expect(source).not.toContain('dangerouslySetInnerHTML')
    }
  })

  it('drives navigation from the shared tested nav models', () => {
    expect(chrome).toContain('PUBLIC_NAV')
    expect(shell).toContain('APP_NAV')
  })
})

// --- Route hygiene (house rules extended to the new files) ----------------------

describe('route hygiene', () => {
  it('no route file renders raw HTML', () => {
    const routesDir = join(process.cwd(), 'src', 'routes')
    for (const entry of readdirSync(routesDir)) {
      if (!/\.tsx?$/.test(entry)) continue
      const source = readFileSync(join(routesDir, entry), 'utf8')
      expect(source).not.toContain('dangerouslySetInnerHTML')
    }
  })
})
