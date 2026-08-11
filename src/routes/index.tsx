import { Link, createFileRoute } from '@tanstack/react-router'

import {
  listDeitiesFn,
  listSacredHousesFn,
  listServicesFn,
} from '@/services/catalogue-actions'
import { SiteFooter, SiteHeader } from '@/components/site-chrome'
import {
  Badge,
  Card,
  Container,
  IconArrow,
  PatternDivider,
  SectionHeading,
  SkipLink,
  buttonClass,
} from '@/components/ui'
import { formatDurationMinutes, formatMinorAmount } from '@/lib/format'

/**
 * Home / landing page (Step 21A), following Screen 1 of the approved
 * visual direction: a deep-brown hero with serif display type and one
 * gold call-to-action, then warm cream discovery sections.
 *
 * EVERY catalogue fact on this page is REAL — Sacred Houses, services
 * and deity profiles come from the published-only public read
 * contracts. Nothing spiritual is invented here: no prices (rendered
 * only when a service really carries one), no deity descriptions
 * beyond stored approved copy, no testimonials, no sacred quotations.
 * Olódùmárè is presented separately and respectfully, never as a
 * deity catalogue card.
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

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <SkipLink />
      <SiteHeader />

      <main id="main-content">
        {/* Hero — deep brown, serif display, restrained gold */}
        <section className="texture-night bg-night">
          <Container className="py-20 sm:py-28">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold tracking-[0.3em] text-gold-bright uppercase">
                Yorùbá Heritage World Virtual
              </p>
              <h1 className="font-display mt-5 text-4xl leading-tight text-balance text-cream-on-night sm:text-5xl md:text-6xl">
                A digital home for Yorùbá prayer, ancestral connection and
                sacred cultural practice.
              </h1>
              <p className="mt-6 max-w-2xl text-lg leading-relaxed text-cream-soft-on-night">
                Explore Sacred Houses and their services, book a private
                appointment, and receive your recording in your own Prayer
                Room.
              </p>
              <div className="mt-10 flex flex-col gap-4 sm:flex-row sm:items-center">
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
              <p className="mt-8 text-sm text-cream-soft-on-night">
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

        {/* Sacred Houses — the heart of the platform */}
        <section className="bg-canvas">
          <Container className="py-16 sm:py-20">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
              <SectionHeading
                kicker="Discover"
                title="Sacred Houses"
                intro="Appointments are booked with a Sacred House — never with an individual member."
              />
              <Link
                to="/sacred-houses"
                className="inline-flex shrink-0 items-center gap-2 text-sm font-semibold text-gold-deep transition-colors hover:text-ink"
              >
                View all Sacred Houses
                <IconArrow />
              </Link>
            </div>

            {houses.length === 0 ? (
              <p className="mt-10 text-ink-soft">
                Sacred Houses will appear here once they are published.
              </p>
            ) : (
              <ul className="mt-10 grid gap-6 sm:grid-cols-2">
                {houses.map((house) => (
                  <li key={house.id}>
                    <Link
                      to="/sacred-houses/$slug"
                      params={{ slug: house.slug }}
                      className="group block h-full"
                    >
                      <Card className="h-full transition-colors group-hover:border-gold-deep">
                        <h3 className="font-display text-xl text-ink">
                          {house.name}
                        </h3>
                        {house.shortDescription ? (
                          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                            {house.shortDescription}
                          </p>
                        ) : null}
                        {house.focusAreas.length > 0 ? (
                          <ul className="mt-4 flex flex-wrap gap-2">
                            {house.focusAreas.slice(0, 4).map((area) => (
                              <li key={area}>
                                <Badge>{area}</Badge>
                              </li>
                            ))}
                            {house.focusAreas.length > 4 ? (
                              <li>
                                <Badge>
                                  +{house.focusAreas.length - 4} more
                                </Badge>
                              </li>
                            ) : null}
                          </ul>
                        ) : null}
                      </Card>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Container>
        </section>

        {/* Services — real published service families, grouped by House */}
        <section className="border-y border-line bg-surface">
          <Container className="py-16 sm:py-20">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
              <SectionHeading
                kicker="Spiritual services"
                title="Service families by Sacred House"
                intro="Each service belongs to the Sacred House that offers it. Details are shown when a service opens for booking."
              />
              <Link
                to="/services"
                className="inline-flex shrink-0 items-center gap-2 text-sm font-semibold text-gold-deep transition-colors hover:text-ink"
              >
                View all services
                <IconArrow />
              </Link>
            </div>

            {serviceGroups.length === 0 ? (
              <p className="mt-10 text-ink-soft">
                Services will appear here once they are published.
              </p>
            ) : (
              <div className="mt-10 grid gap-8 lg:grid-cols-2">
                {serviceGroups.map((group) => (
                  <section key={group.sacredHouse.id}>
                    <h3 className="text-sm font-semibold tracking-wide text-ink">
                      <Link
                        to="/sacred-houses/$slug"
                        params={{ slug: group.sacredHouse.slug }}
                        className="transition-colors hover:text-gold-deep"
                      >
                        {group.sacredHouse.name}
                      </Link>
                    </h3>
                    <ul className="mt-3 flex flex-col gap-2">
                      {group.services.map((service) => {
                        const price =
                          service.priceMinor != null && service.currency
                            ? formatMinorAmount(
                                service.priceMinor,
                                service.currency,
                              )
                            : null
                        const duration =
                          service.durationMinutes != null
                            ? formatDurationMinutes(service.durationMinutes)
                            : null
                        return (
                          <li key={service.id}>
                            <Link
                              to="/services/$slug"
                              params={{ slug: service.slug }}
                              className="flex items-center justify-between gap-4 rounded-md border border-line bg-surface-raised px-4 py-3 transition-colors hover:border-gold-deep"
                            >
                              <span className="min-w-0">
                                <span className="block truncate text-sm font-medium text-ink">
                                  {service.name}
                                </span>
                                {service.shortDescription ? (
                                  <span className="mt-0.5 block truncate text-xs text-ink-soft">
                                    {service.shortDescription}
                                  </span>
                                ) : null}
                              </span>
                              {price || duration ? (
                                <span className="shrink-0 text-right text-xs text-ink-soft">
                                  {price ? (
                                    <span className="block font-semibold text-ink">
                                      {price}
                                    </span>
                                  ) : null}
                                  {duration ? (
                                    <span className="block">{duration}</span>
                                  ) : null}
                                </span>
                              ) : null}
                            </Link>
                          </li>
                        )
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </Container>
        </section>

        {/* Deity discovery — approved profiles only */}
        <section className="bg-canvas">
          <Container className="py-16 sm:py-20">
            <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
              <SectionHeading
                kicker="Deity profiles"
                title="Approved spiritual profiles"
                intro="Informational and educational profiles, published through the platform's editorial approval workflow."
              />
              <Link
                to="/deities"
                className="inline-flex shrink-0 items-center gap-2 text-sm font-semibold text-gold-deep transition-colors hover:text-ink"
              >
                View all profiles
                <IconArrow />
              </Link>
            </div>

            {deities.length === 0 ? (
              <p className="mt-10 text-ink-soft">
                Deity profiles will appear here once they are published.
              </p>
            ) : (
              <ul className="mt-10 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {deities.map((deity) => (
                  <li key={deity.id}>
                    <Link
                      to="/deities/$slug"
                      params={{ slug: deity.slug }}
                      className="group flex h-full flex-col items-center justify-center rounded-lg border border-line bg-surface-raised px-4 py-6 text-center transition-colors hover:border-gold-deep"
                    >
                      <span className="font-display text-lg text-ink transition-colors group-hover:text-gold-deep">
                        {deity.name}
                      </span>
                      {deity.shortDescription ? (
                        <span className="mt-2 line-clamp-2 text-xs text-ink-soft">
                          {deity.shortDescription}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Container>
        </section>

        {/* Olódùmárè — separate and respectful, never a catalogue card */}
        <section className="texture-night bg-night">
          <Container className="py-16 sm:py-20">
            <div className="mx-auto max-w-2xl text-center">
              <PatternDivider onDark />
              <h2 className="font-display mt-8 text-3xl text-cream-on-night">
                Olódùmárè
              </h2>
              <p className="mt-5 text-base leading-relaxed text-cream-soft-on-night">
                Olódùmárè is presented separately and respectfully within the
                spiritual structure of the platform.
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
          </Container>
        </section>

        {/* Trust — real platform facts, quietly stated */}
        <section className="bg-canvas">
          <Container className="py-16 sm:py-20">
            <SectionHeading
              kicker="A private sacred space"
              title="Built for dignity and privacy"
              align="center"
            />
            <ul className="mx-auto mt-10 grid max-w-4xl gap-6 sm:grid-cols-3">
              <li>
                <Card className="h-full text-center">
                  <h3 className="text-sm font-semibold text-ink">
                    Private by account
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                    Appointments and Prayer Rooms are private to your account.
                  </p>
                </Card>
              </li>
              <li>
                <Card className="h-full text-center">
                  <h3 className="text-sm font-semibold text-ink">
                    Approved content only
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                    Spiritual content is reviewed and approved before it is
                    published.
                  </p>
                </Card>
              </li>
              <li>
                <Card className="h-full text-center">
                  <h3 className="text-sm font-semibold text-ink">
                    Sacred Houses, not individuals
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                    Appointments are booked with a Sacred House — never with an
                    individual member.
                  </p>
                </Card>
              </li>
            </ul>
          </Container>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}
