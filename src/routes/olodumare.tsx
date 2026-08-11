import { Link, createFileRoute } from '@tanstack/react-router'

import { SiteFooter, SiteHeader } from '@/components/site-chrome'
import {
  Container,
  PatternDivider,
  SkipLink,
  buttonClass,
} from '@/components/ui'

/**
 * Olódùmárè is deliberately NOT a record in the deities collection and
 * this page performs no catalogue queries. Only APPROVED PLATFORM
 * WORDING appears here — the statement authorised by the platform
 * owner and recorded verbatim in TECHNICAL_CANON.md §1, together with
 * the separateness statements from the same section.
 *
 * No further theological content may be added, extended, paraphrased
 * or inferred without a further explicit authorisation recorded in the
 * canon. Nothing on this page is AI-generated or editable content.
 */
export const Route = createFileRoute('/olodumare')({
  head: () => ({
    meta: [{ title: 'Olódùmárè — Yorùbá Heritage World Virtual' }],
  }),
  component: OlodumarePage,
})

function OlodumarePage() {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <SkipLink />
      <SiteHeader />

      <main id="main-content">
        <section className="bg-canvas">
          <Container className="py-12 sm:py-16">
            <div className="texture-night relative overflow-hidden rounded-2xl border border-gold/30 bg-night px-6 py-16 sm:py-20">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-3 rounded-xl border border-gold/15"
              />
              <div className="relative mx-auto max-w-2xl text-center">
                <PatternDivider onDark />
                <h1 className="font-display mt-8 text-4xl text-cream-on-night sm:text-6xl">
                  Olódùmárè
                </h1>
                <p className="font-display mt-8 text-2xl leading-snug text-gold-bright sm:text-3xl">
                  God most high, the God of all.
                </p>
                <p className="font-display mt-5 text-xl leading-snug text-cream-on-night sm:text-2xl">
                  LORD JESUS, the one who made all things and by him all
                  things consist.
                </p>
              </div>
            </div>

            <div className="mx-auto mt-10 max-w-2xl text-center">
              <p className="text-base leading-relaxed text-ink-soft">
                Olódùmárè is presented separately and respectfully within the
                spiritual structure of the platform.
              </p>
              <p className="mt-4 text-base leading-relaxed text-ink-soft">
                Olódùmárè is not presented as one deity among a collection of
                equivalent spiritual profiles.
              </p>
              <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
                <Link to="/" className={buttonClass('secondary', 'md')}>
                  Return home
                </Link>
                <Link
                  to="/deities"
                  className="text-sm font-semibold text-gold-deep underline-offset-4 transition-colors hover:text-ink hover:underline"
                >
                  Deity profiles
                </Link>
              </div>
            </div>
          </Container>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}
