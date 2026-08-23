import { Link, createFileRoute } from '@tanstack/react-router'

import { listServicesFn } from '@/services/catalogue-actions'
import { PublicPage } from '@/components/site-chrome'
import { MotifTile, motifForIndex } from '@/components/motifs'
import { Container, IconArrow, PageBanner } from '@/components/ui'

/**
 * Service directory (Step 21A.3), grouped by the Sacred House that
 * offers each family. Price and duration are deliberately NOT shown
 * here — discovery pages stay uncluttered, and the real figures appear
 * on the service page and in the booking flow, where they come from
 * the stored record.
 */
export const Route = createFileRoute('/services/')({
  loader: () => listServicesFn(),
  head: () => ({
    meta: [{ title: 'Services — Yorùbá Heritage World Virtual' }],
  }),
  component: ServicesPage,
})

function ServicesPage() {
  const groups = Route.useLoaderData()

  return (
    <PublicPage>
      <PageBanner
        kicker="Spiritual services"
        title="Service families"
        intro="Each service belongs to the Sacred House that offers it. Open a service to see what it involves and whether it is currently open for booking."
      />

      <Container className="py-12 sm:py-16">
        {groups.length === 0 ? (
          <p className="text-ink-soft">
            Services will appear here once they are published.
          </p>
        ) : (
          <div className="grid gap-10">
            {groups.map((group) => (
              <section key={group.sacredHouse.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line pb-3">
                  <h2 className="font-display text-2xl text-ink">
                    {group.sacredHouse.name}
                  </h2>
                  <Link
                    to="/sacred-houses/$slug"
                    params={{ slug: group.sacredHouse.slug }}
                    className="inline-flex items-center gap-2 text-sm font-semibold text-gold-deep transition-colors hover:text-ink"
                  >
                    View Sacred House
                    <IconArrow />
                  </Link>
                </div>
                <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {group.services.map((service, index) => (
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
                            <span className="mt-1 line-clamp-3 block text-xs leading-relaxed text-ink-soft">
                              {service.shortDescription}
                            </span>
                          ) : null}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Container>
    </PublicPage>
  )
}
