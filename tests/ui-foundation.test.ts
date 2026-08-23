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

  it('presents Olódùmárè separately and BEFORE the deity profiles', () => {
    // Separateness is STRUCTURAL (canon §1): Olódùmárè has its own
    // section ahead of the catalogue and is never an entry inside the
    // deity map — not a sentence printed on screen.
    expect(code).toContain('to="/olodumare"')
    const olodumareSection = code.indexOf('God most high')
    const deityGrid = code.indexOf('deities.map')
    expect(olodumareSection).toBeGreaterThan(-1)
    expect(deityGrid).toBeGreaterThan(-1)
    expect(olodumareSection).toBeLessThan(deityGrid)
    // …and it is never sourced from the deity catalogue.
    const olodumareBlock = code.slice(olodumareSection, deityGrid)
    expect(olodumareBlock).not.toContain('deities.map')
    expect(olodumareBlock).not.toContain('to="/deities/$slug"')
  })

  it('follows the locked section order: Olódùmárè → services → houses → deities → trust', () => {
    // Olódùmárè comes FIRST after the hero, ahead of every catalogue
    // section (owner-locked order).
    const markers = [
      'God most high',
      'Featured Spiritual Services',
      '<EmblemMedallion',
      'deities.map',
      'Built for dignity and privacy',
    ]
    const positions = markers.map((marker) => code.indexOf(marker))
    for (const position of positions) expect(position).toBeGreaterThan(-1)
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1])
    }
  })

  it('keeps the skip-link target, page chrome and the full-bleed hero image', () => {
    expect(source).toContain('SkipLink')
    expect(source).toContain('id="main-content"')
    expect(source).toContain('SiteHeader')
    expect(source).toContain('SiteFooter')
    // The hero photograph is same-origin (the CSP allows no external
    // image host), decorative, and covers the box at every width.
    expect(code).toContain('src="/hero-sanctuary.jpg"')
    expect(code).toContain('object-cover')
    expect(code).toContain('alt=""')
    expect(code).not.toMatch(/src="https?:/)
  })
})

// --- Approved Olódùmárè wording -------------------------------------------------

describe('the approved Olódùmárè wording', () => {
  // The ONLY theological statement the product may render about
  // Olódùmárè, authorised by the platform owner and recorded verbatim
  // in TECHNICAL_CANON.md §1. These assertions exist so the rendered
  // wording and the canon can never drift apart, and so no further
  // doctrinal line can be added without the canon changing too.
  const APPROVED = [
    'God most high, the God of all.',
    'LORD JESUS, the one who made all things and by him all things consist.',
  ]
  // JSX line-wraps prose, so compare on whitespace-normalised text —
  // the wording must match word-for-word, not line-for-line.
  const flatten = (source: string): string =>
    withoutComments(source).replace(/\s+/g, ' ')
  // The canon records the wording as a markdown blockquote; strip the
  // quote markers before comparing the prose itself.
  const canon = read('TECHNICAL_CANON.md')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\s+/g, ' ')
  const landing = flatten(read('src/routes/index.tsx'))
  const page = flatten(read('src/routes/olodumare.tsx'))

  it('is recorded in the canon as approved, fixed platform wording', () => {
    expect(canon).toContain('APPROVED OLÓDÙMÁRÈ WORDING')
    for (const line of APPROVED) {
      expect(canon).toContain(line)
    }
    expect(canon).toContain('not editable content and not')
  })

  it('renders identically on the landing page and the Olódùmárè page', () => {
    for (const surface of [landing, page]) {
      for (const line of APPROVED) {
        expect(surface).toContain(line)
      }
    }
  })

  it('keeps the canon-§1 separateness statements on the Olódùmárè page', () => {
    // The landing card carries the devotional wording alone; the fuller
    // policy statements live on the page the card links to.
    expect(page).toContain(
      'Olódùmárè is presented separately and respectfully',
    )
    expect(page).toContain(
      'Olódùmárè is not presented as one deity among a collection',
    )
  })

  it('is never rendered as a deity catalogue card', () => {
    // The Olódùmárè page performs no catalogue queries at all.
    expect(page).not.toContain('listDeitiesFn')
    expect(page).not.toContain('deities.map')
    // And the landing keeps it out of the deity grid.
    const deityGrid = landing.indexOf('deities.map')
    expect(landing.indexOf('God most high')).toBeLessThan(deityGrid)
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

// --- Authenticated surfaces (Step 21A.2) ---------------------------------------

describe('authenticated shell and dashboard', () => {
  const AUTHED_ROUTES = [
    'src/routes/dashboard.tsx',
    'src/routes/profile.index.tsx',
    'src/routes/profile.edit.tsx',
    'src/routes/profile.spiritual.tsx',
    'src/routes/profile.consents.tsx',
  ] as const

  it('every signed-in page renders inside the shared shell', () => {
    for (const file of AUTHED_ROUTES) {
      const code = withoutComments(read(file))
      expect(code).toContain('AppShell')
      expect(code).toContain('userName=')
    }
  })

  it('KEEPS the server-side auth guard on every signed-in page', () => {
    // The whole point of a restyle is that protection survives it. A
    // page that lost its beforeLoad redirect would still LOOK right.
    for (const file of AUTHED_ROUTES) {
      const code = withoutComments(read(file))
      expect(code).toContain('beforeLoad')
      expect(code).toContain('getCurrentUserFn()')
      expect(code).toContain("redirect({ to: '/login' })")
    }
  })

  it('reads only the acting user’s own server contracts', () => {
    const dashboard = withoutComments(read('src/routes/dashboard.tsx'))
    expect(dashboard).toContain('getMyCompletionFn')
    expect(dashboard).toContain('getMyAppointmentsFn')
    // Nothing admin-scoped may be pulled into a user surface.
    for (const file of AUTHED_ROUTES) {
      const code = withoutComments(read(file))
      expect(code).not.toMatch(/admin[A-Z]\w*Fn/)
    }
  })

  it('fabricates no member id, location or statistic', () => {
    const dashboard = withoutComments(read('src/routes/dashboard.tsx'))
    // The showcase invents "Member ID YHWV-0004587" and a location.
    // The platform issues neither, so neither may be rendered.
    expect(dashboard).not.toMatch(/member\s*id/i)
    expect(dashboard).not.toMatch(/YHWV-/)
    expect(dashboard).not.toMatch(/Lagos, Nigeria/)
    // Percentages must be COMPUTED from the server's own missing-field
    // list, never written as a literal.
    expect(dashboard).not.toMatch(/\d{1,3}\s*%/)
    expect(dashboard).toContain('completion.missingFields')
  })

  it('measures completion against the fields the server actually returns', () => {
    const dashboard = withoutComments(read('src/routes/dashboard.tsx'))
    const service = read('src/services/profile.ts')
    // Each field name the dashboard checks must be one the server can
    // put in missingFields, or a step would silently never complete.
    const fields = [...dashboard.matchAll(/field: '([a-zA-Z]+)'/g)].map(
      (match) => match[1],
    )
    expect(fields.length).toBeGreaterThan(0)
    for (const field of fields) {
      expect(service).toContain(`missingFields.push('${field}')`)
    }
  })

  it('states every status in words, never by colour alone', () => {
    const ui = withoutComments(read('src/components/ui.tsx'))
    // The completion dial prints its own figure, and each checklist row
    // carries an explicit word beside the mark.
    expect(ui).toContain('{percent}%')
    expect(ui).toContain('Still needed')
    expect(ui).toContain("done ? 'Added'")
  })

  it('keeps the sign-out action on the dashboard', () => {
    const dashboard = withoutComments(read('src/routes/dashboard.tsx'))
    expect(dashboard).toContain('logoutFn')
    expect(dashboard).toContain('Sign out')
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
