import { Link, createFileRoute } from '@tanstack/react-router'

import {
  listDeitiesFn,
  listSacredHousesFn,
  listServicesFn,
} from '@/services/catalogue-actions'
import { SiteFooter, SiteHeader } from '@/components/site-chrome'
import { HeroBackdrop } from '@/components/hero-scene'
import {
  EmblemMedallion,
  InitialMedallion,
  MotifTile,
  motifForIndex,
} from '@/components/motifs'
import {
  Badge,
  Container,
  IconArrow,
  PatternDivider,
  SectionHeading,
  SkipLink,
  buttonClass,
} from '@/components/ui'

/**
 * Home / landing page (Step 21A, high-fidelity pass): Screen 1 of the
 * showcase is the PRIMARY VISUAL TARGET — a full-bleed candle-lit hero
 * with the copy overlaid on a dark scrim, then dense premium sections.
 * The repository and canon win only where the reference conflicts with
 * real data, governance, accessibility or routes.
 *
 * EVERY catalogue fact on this page is REAL — Sacred Houses, services
 * and deity profiles come from the published-only public read
 * contracts. No testimonials, no invented deity facts.
 *
 * LOCKED RULES: featured services show NO price on the landing page,
 * and Olódùmárè is presented FIRST — immediately after the hero,
 * ahead of every catalogue section — separately and respectfully, and
 * never as a deity catalogue card. Its wording is approved platform
 * wording (TECHNICAL_CANON.md §1); it is not editable copy.
 */

export const Route = createFileRoute('/')({
  loader: async () => {
    const [houses, serviceGroups, deities] = await Promise.all([
      listSacredHousesFn(),
      listServicesFn(),
      listDeitiesFn(),
    ])
    return { houses, serviceGroups, deities }
  },
  head: () => ({
    meta: [{ title: 'Yorùbá Heritage World Virtual' }],
  }),
  component: Home,
})

function Home() {
  const { houses, serviceGroups, deities } = Route.useLoaderData()

  const featuredServices = serviceGroups
    .flatMap((group) =>
      group.services.map((service) => ({
        ...service,
        sacredHouse: group.sacredHouse,
      })),
    )
    .slice(0, 4)

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <SkipLink />
      <SiteHeader />

      <main id="main-content">
        {/* 1 — Hero: full-bleed candle-lit backdrop, copy on a scrim */}
        <section className="relative isolate overflow-hidden bg-night">
          <div aria-hidden="true" className="absolute inset-0 -z-20">
            <HeroBackdrop className="h-full w-full" />
          </div>
          {/* Scrims: darken toward the copy so the headline holds
              contrast at every width, exactly as the reference does. */}
          <div
            aria-hidden="true"
            className="absolute inset-0 -z-10 bg-gradient-to-r from-night via-night/88 to-night/35 lg:via-night/70 lg:to-transparent"
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 -z-10 bg-gradient-to-t from-night/60 via-transparent to-night/35"
          />
          <Container className="py-24 sm:py-32 lg:py-40">
            <div className="max-w-2xl">
              <p className="text-xs font-semibold tracking-[0.3em] text-gold-bright uppercase">
                Yorùbá Heritage World Virtual
              </p>
              <h1 className="font-display mt-5 text-4xl leading-tight text-balance text-cream-on-night sm:text-5xl xl:text-6xl">
                A digital home for Yorùbá prayer, ancestral connection and
                sacred cultural practice.
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-cream-soft-on-night">
                Explore Sacred Houses and their services, book a private
                appointment, and receive your recording in your own Prayer
                Room.
              </p>
              <div className="mt-9 flex flex-col gap-4 sm:flex-row sm:items-center">
                <Link to="/register" className={buttonClass('primary', 'lg')}>
                  Create your account
                  <IconArrow />
                </Link>
                <Link
                  to="/sacred-houses"
                  className={buttonClass('secondary-on-dark', 'lg')}
                >
                  Explore Sacred Houses
                </Link>
              </div>
              <p className="mt-7 text-sm text-cream-soft-on-night">
                Already a member?{' '}
                <Link
                  to="/login"
                  className="font-medium text-gold-bright underline-offset-4 hover:underline"
                >
                  Log in
                </Link>
              </p>
            </div>
          </Container>
        </section>

        {/* 2 — Olódùmárè: first after the hero, given its own dignity */}
        <section className="bg-canvas">
          <Container className="py-12 sm:py-16">
            <div className="texture-night relative overflow-hidden rounded-2xl border border-gold/30 bg-night px-6 py-14 sm:py-16">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-3 rounded-xl border border-gold/15"
              />
              <div className="relative mx-auto max-w-2xl text-center">
                <PatternDivider onDark />
                <h2 className="font-display mt-7 text-4xl text-cream-on-night sm:text-5xl">
                  Olódùmárè
                </h2>
                <p className="font-display mt-6 text-2xl leading-snug text-gold-bright sm:text-3xl">
                  God most high, the God of all.
                </p>
                <p className="font-display mt-4 text-xl leading-snug text-cream-on-night sm:text-2xl">
                  LORD JESUS, the one who made all things and by him all
                  things consist.
                </p>
                <p className="mt-8 text-base leading-relaxed text-cream-soft-on-night">
                  Olódùmárè is presented separately and respectfully within
                  the spiritual structure of the platform.
                </p>
                <p className="mt-3 text-base leading-relaxed text-cream-soft-on-night">
                  Olódùmárè is not presented as one deity among a collection
                  of equivalent spiritual profiles.
                </p>
                <div className="mt-8">
                  <Link
                    to="/olodumare"
                    className={buttonClass('secondary-on-dark', 'md')}
                  >
                    Read more
                  </Link>
                </div>
              </div>
            </div>
          </Container>
        </section>

        {/* 3 — Featured Spiritual Services: premium cards, NO price */}
        <section className="border-y border-line bg-surface">
          <Container className="py-12 sm:py-14">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-xs font-semibold tracking-[0.28em] text-gold-deep uppercase">
                  Spiritual services
                </p>
                <h2 className="font-display mt-2 text-2xl text-ink sm:text-3xl">
                  Featured Spiritual Services
                </h2>
              </div>
              <Link
                to="/services"
                className="inline-flex items-center gap-2 text-sm font-semibold text-gold-deep transition-colors hover:text-ink"
              >
                View all services
                <IconArrow />
              </Link>
            </div>

            {featuredServices.length === 0 ? (
              <p className="mt-8 text-ink-soft">
                Services will appear here once they are published.
              </p>
            ) : (
              <ul className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {featuredServices.map((service, index) => (
                  <li key={service.id}>
                    <Link
                      to="/services/$slug"
                      params={{ slug: service.slug }}
                      className="flex h-full gap-4 rounded-lg border border-line bg-surface-raised p-4 shadow-[0_1px_3px_rgba(43,32,24,0.08)] transition-colors hover:border-gold-deep"
                    >
                      <MotifTile name={motifForIndex(index)} />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-ink">
                          {service.name}
                        </span>
                        {service.shortDescription ? (
                          <span className="mt-1 line-clamp-2 block text-xs leading-relaxed text-ink-soft">
                            {service.shortDescription}
                          </span>
                        ) : null}
                        <span className="mt-1.5 block truncate text-[0.7rem] font-medium text-gold-deep">
                          {service.sacredHouse.name}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Container>
        </section>

        {/* 4 — Sacred Houses: dark premium discovery band */}
        <section className="texture-night bg-night">
          <Container className="py-12 sm:py-16">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-xs font-semibold tracking-[0.28em] text-gold-bright uppercase">
                  Discover
                </p>
                <h2 className="font-display mt-2 text-2xl text-cream-on-night sm:text-3xl">
                  Sacred Houses
                </h2>
                <p className="mt-2 max-w-xl text-sm leading-relaxed text-cream-soft-on-night">
                  Appointments are booked with a Sacred House — never with an
                  individual member.
                </p>
              </div>
              <Link
                to="/sacred-houses"
                className={buttonClass('secondary-on-dark', 'md')}
              >
                View all
                <IconArrow />
              </Link>
            </div>

            {houses.length === 0 ? (
              <p className="mt-8 text-cream-soft-on-night">
                Sacred Houses will appear here once they are published.
              </p>
            ) : (
              <ul className="mt-10 grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-4">
                {houses.map((house) => (
                  <li key={house.id}>
                    <Link
                      to="/sacred-houses/$slug"
                      params={{ slug: house.slug }}
                      className="group flex h-full flex-col items-center gap-4 text-center"
                    >
                      {/* ONE shared neutral mark for every House — a
                          distinct mark per real institution would be an
                          invented emblem (UI direction §5/§13). */}
                      <EmblemMedallion name="lattice" />
                      <span>
                        <span className="font-display block text-lg leading-snug text-cream-on-night transition-colors group-hover:text-gold-bright">
                          {house.name}
                        </span>
                        {house.focusAreas.length > 0 ? (
                          <span className="mt-2 block text-xs leading-relaxed text-cream-soft-on-night">
                            {house.focusAreas.slice(0, 2).join(' • ')}
                          </span>
                        ) : null}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Container>
        </section>

        {/* 5 — Deity discovery: premium cards from real records */}
        <section className="bg-canvas">
          <Container className="py-12 sm:py-14">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-xs font-semibold tracking-[0.28em] text-gold-deep uppercase">
                  Deity profiles
                </p>
                <h2 className="font-display mt-2 text-2xl text-ink sm:text-3xl">
                  Approved spiritual profiles
                </h2>
                <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-soft">
                  Informational and educational profiles, published through
                  the platform's editorial approval workflow.
                </p>
              </div>
              <Link
                to="/deities"
                className="inline-flex items-center gap-2 text-sm font-semibold text-gold-deep transition-colors hover:text-ink"
              >
                View all profiles
                <IconArrow />
              </Link>
            </div>

            {deities.length === 0 ? (
              <p className="mt-8 text-ink-soft">
                Deity profiles will appear here once they are published.
              </p>
            ) : (
              <ul className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {deities.map((deity) => (
                  <li key={deity.id}>
                    <Link
                      to="/deities/$slug"
                      params={{ slug: deity.slug }}
                      className="group flex h-full items-center gap-4 rounded-lg border border-line bg-surface-raised p-4 shadow-[0_1px_3px_rgba(43,32,24,0.08)] transition-colors hover:border-gold-deep"
                    >
                      <InitialMedallion name={deity.name} />
                      <span className="min-w-0">
                        <span className="font-display block truncate text-lg text-ink transition-colors group-hover:text-gold-deep">
                          {deity.name}
                        </span>
                        {deity.shortDescription ? (
                          <span className="mt-1 line-clamp-2 block text-xs leading-relaxed text-ink-soft">
                            {deity.shortDescription}
                          </span>
                        ) : (
                          <span className="mt-1 block text-xs text-ink-soft">
                            View profile
                          </span>
                        )}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Container>
        </section>

        {/* 6 — Privacy / trust: real platform facts, quietly stated */}
        <section className="border-t border-line bg-surface">
          <Container className="py-12 sm:py-14">
            <SectionHeading
              kicker="A private sacred space"
              title="Built for dignity and privacy"
              align="center"
            />
            <ul className="mx-auto mt-8 grid max-w-4xl gap-4 sm:grid-cols-3">
              <li className="flex h-full flex-col items-center rounded-lg border border-line bg-surface-raised p-6 text-center shadow-[0_1px_3px_rgba(43,32,24,0.08)]">
                <Badge>Private by account</Badge>
                <p className="mt-3 text-sm leading-relaxed text-ink-soft">
                  Appointments and Prayer Rooms are private to your account.
                </p>
              </li>
              <li className="flex h-full flex-col items-center rounded-lg border border-line bg-surface-raised p-6 text-center shadow-[0_1px_3px_rgba(43,32,24,0.08)]">
                <Badge>Approved content only</Badge>
                <p className="mt-3 text-sm leading-relaxed text-ink-soft">
                  Spiritual content is reviewed and approved before it is
                  published.
                </p>
              </li>
              <li className="flex h-full flex-col items-center rounded-lg border border-line bg-surface-raised p-6 text-center shadow-[0_1px_3px_rgba(43,32,24,0.08)]">
                <Badge>Sacred Houses, not individuals</Badge>
                <p className="mt-3 text-sm leading-relaxed text-ink-soft">
                  Appointments are booked with a Sacred House — never with an
                  individual member.
                </p>
              </li>
            </ul>
          </Container>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}
