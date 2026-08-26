import { Link, createFileRoute } from '@tanstack/react-router'

import { listSacredHousesFn } from '@/services/catalogue-actions'
import { getCurrentUserFn } from '@/auth/actions'
import { PublicPage } from '@/components/site-chrome'
import { EmblemMedallion } from '@/components/motifs'
import { Badge, Container, IconArrow, PageBanner } from '@/components/ui'

/**
 * Sacred House directory (Step 21A.3) on the public page frame. Every
 * House, description and focus area is a published catalogue record —
 * nothing about a real spiritual institution is invented here, and all
 * Houses share the same neutral medallion because a distinct mark per
 * House would be an emblem nobody approved.
 */
export const Route = createFileRoute('/sacred-houses/')({
  beforeLoad: async () => ({ user: await getCurrentUserFn() }),
  loader: () => listSacredHousesFn(),
  head: () => ({
    meta: [{ title: 'Sacred Houses — Yorùbá Heritage World Virtual' }],
  }),
  component: SacredHousesPage,
})

function SacredHousesPage() {
  const { user } = Route.useRouteContext()
  const houses = Route.useLoaderData()

  return (
    <PublicPage user={user}>
      <PageBanner
        kicker="Discover"
        title="Sacred Houses"
        intro="Appointments are booked with a Sacred House — never with an individual member. Each House privately assigns the members responsible for an appointment."
      />

      <Container className="py-12 sm:py-16">
        {houses.length === 0 ? (
          <p className="text-ink-soft">
            Sacred Houses will appear here once they are published.
          </p>
        ) : (
          <ul className="grid gap-6 sm:grid-cols-2">
            {houses.map((house) => (
              <li key={house.id}>
                <Link
                  to="/sacred-houses/$slug"
                  params={{ slug: house.slug }}
                  className="group flex h-full flex-col rounded-lg border border-line bg-surface-raised p-6 shadow-[0_1px_3px_rgba(43,32,24,0.08)] transition-colors hover:border-gold-deep"
                >
                  <div className="flex items-start gap-4">
                    <EmblemMedallion name="lattice" className="h-14 w-14" />
                    <div className="min-w-0">
                      <h2 className="font-display text-xl leading-snug text-ink transition-colors group-hover:text-gold-deep">
                        {house.name}
                      </h2>
                      {house.shortDescription ? (
                        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                          {house.shortDescription}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  {house.focusAreas.length > 0 ? (
                    <ul className="mt-5 flex flex-wrap gap-2">
                      {house.focusAreas.slice(0, 6).map((area) => (
                        <li key={area}>
                          <Badge>{area}</Badge>
                        </li>
                      ))}
                      {house.focusAreas.length > 6 ? (
                        <li>
                          <Badge>+{house.focusAreas.length - 6} more</Badge>
                        </li>
                      ) : null}
                    </ul>
                  ) : null}

                  <span className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-gold-deep">
                    View Sacred House
                    <IconArrow />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Container>
    </PublicPage>
  )
}
