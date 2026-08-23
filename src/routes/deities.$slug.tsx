import { Link, createFileRoute, notFound } from '@tanstack/react-router'

import { getDeityFn } from '@/services/catalogue-actions'
import { PublicPage } from '@/components/site-chrome'
import {
  BackLink,
  Card,
  Container,
  IconArrow,
  PageBanner,
  buttonClass,
} from '@/components/ui'

/**
 * Deity profile (Step 21A.3). The name and description are the stored
 * approved record and nothing is added to them: no attributes, no
 * iconography, no ritual or doctrinal claim may be introduced by the
 * interface.
 */
export const Route = createFileRoute('/deities/$slug')({
  loader: async ({ params }) => {
    const deity = await getDeityFn({ data: { slug: params.slug } })
    if (!deity) throw notFound()
    return deity
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData
          ? `${loaderData.name} — Yorùbá Heritage World Virtual`
          : 'Deity profile — Yorùbá Heritage World Virtual',
      },
    ],
  }),
  notFoundComponent: DeityNotFound,
  component: DeityPage,
})

function DeityNotFound() {
  return (
    <PublicPage>
      <PageBanner
        title="Profile not found"
        intro="This deity profile is not available."
      >
        <div className="mt-6">
          <Link to="/deities" className={buttonClass('secondary-on-dark', 'md')}>
            Back to deity profiles
          </Link>
        </div>
      </PageBanner>
    </PublicPage>
  )
}

function DeityPage() {
  const deity = Route.useLoaderData()

  return (
    <PublicPage>
      <PageBanner
        kicker="Deity profile"
        title={deity.name}
        intro={deity.shortDescription ?? undefined}
      >
        <div className="mt-6">
          <BackLink to="/deities">All deity profiles</BackLink>
        </div>
      </PageBanner>

      <Container className="py-12 sm:py-16">
        {deity.sacredHouses.length === 0 && deity.services.length === 0 ? (
          <p className="text-ink-soft">
            No connected Sacred Houses or services are published for this
            profile yet.
          </p>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            {deity.sacredHouses.length > 0 ? (
              <Card>
                <h2 className="text-sm font-semibold tracking-wide text-ink">
                  Connected Sacred Houses
                </h2>
                <ul className="mt-4 flex flex-col gap-2">
                  {deity.sacredHouses.map((house) => (
                    <li key={house.id}>
                      <Link
                        to="/sacred-houses/$slug"
                        params={{ slug: house.slug }}
                        className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface px-4 py-3 text-sm text-ink transition-colors hover:border-gold-deep hover:text-gold-deep"
                      >
                        {house.name}
                        <IconArrow />
                      </Link>
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-xs leading-relaxed text-ink-soft">
                  Appointments are booked with a Sacred House, never with an
                  individual member.
                </p>
              </Card>
            ) : null}

            {deity.services.length > 0 ? (
              <Card>
                <h2 className="text-sm font-semibold tracking-wide text-ink">
                  Connected service families
                </h2>
                <ul className="mt-4 flex flex-col gap-2">
                  {deity.services.map((service) => (
                    <li key={service.id}>
                      <Link
                        to="/services/$slug"
                        params={{ slug: service.slug }}
                        className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface px-4 py-3 text-sm text-ink transition-colors hover:border-gold-deep hover:text-gold-deep"
                      >
                        {service.name}
                        <IconArrow />
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </div>
        )}
      </Container>
    </PublicPage>
  )
}
