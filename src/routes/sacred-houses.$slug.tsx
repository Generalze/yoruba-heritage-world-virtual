import { Link, createFileRoute, notFound } from '@tanstack/react-router'

import { getSacredHouseFn } from '@/services/catalogue-actions'
import { getCurrentUserFn } from '@/auth/actions'
import { PublicPage } from '@/components/site-chrome'
import {
  BackLink,
  Badge,
  Card,
  Container,
  IconArrow,
  PageBanner,
  buttonClass,
} from '@/components/ui'

/**
 * Sacred House profile (Step 21A.3). Members are listed for
 * information ONLY — the platform books Houses, never individuals, and
 * the House privately assigns who serves an appointment. No booking
 * affordance appears beside a member by rule.
 */
export const Route = createFileRoute('/sacred-houses/$slug')({
  beforeLoad: async () => ({ user: await getCurrentUserFn() }),
  loader: async ({ params }) => {
    const house = await getSacredHouseFn({ data: { slug: params.slug } })
    if (!house) throw notFound()
    return house
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData
          ? `${loaderData.name} — Yorùbá Heritage World Virtual`
          : 'Sacred House — Yorùbá Heritage World Virtual',
      },
    ],
  }),
  notFoundComponent: HouseNotFound,
  component: SacredHousePage,
})

const MEMBER_TYPE_LABELS: Record<string, string> = {
  PRAYER_WARRIOR: 'Prayer Warrior',
  PRIEST: 'Priest',
  BABALAWO: 'Babaláwo',
  REPRESENTATIVE: 'Representative',
}

function HouseNotFound() {
  const { user } = Route.useRouteContext()
  return (
    <PublicPage user={user}>
      <PageBanner
        title="Sacred House not found"
        intro="This Sacred House is not available."
      >
        <div className="mt-6">
          <Link
            to="/sacred-houses"
            className={buttonClass('secondary-on-dark', 'md')}
          >
            Back to Sacred Houses
          </Link>
        </div>
      </PageBanner>
    </PublicPage>
  )
}

function SacredHousePage() {
  const { user } = Route.useRouteContext()
  const house = Route.useLoaderData()

  return (
    <PublicPage user={user}>
      <PageBanner
        kicker="Sacred House"
        title={house.name}
        intro={house.shortDescription ?? undefined}
      >
        <div className="mt-6">
          <BackLink to="/sacred-houses">All Sacred Houses</BackLink>
        </div>
      </PageBanner>

      <Container className="py-12 sm:py-16">
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="grid gap-6 lg:col-span-2">
            {house.services.length > 0 ? (
              <Card>
                <h2 className="text-sm font-semibold tracking-wide text-ink">
                  Service families
                </h2>
                <ul className="mt-4 grid gap-2 sm:grid-cols-2">
                  {house.services.map((service) => (
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

            {house.members.length > 0 ? (
              <Card>
                <h2 className="text-sm font-semibold tracking-wide text-ink">
                  Sacred House members
                </h2>
                {/* Informational list only. No booking actions here by
                    rule: users book the Sacred House, never a member. */}
                <ul className="mt-4 grid gap-2 sm:grid-cols-2">
                  {house.members.map((member) => (
                    <li
                      key={member.displayName}
                      className="rounded-md border border-line bg-surface px-4 py-3"
                    >
                      <span className="block text-sm text-ink">
                        {member.displayName}
                      </span>
                      <span className="mt-0.5 block text-xs text-ink-soft">
                        {MEMBER_TYPE_LABELS[member.memberType] ??
                          member.memberType}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-xs leading-relaxed text-ink-soft">
                  Appointments are booked with the Sacred House. The House
                  privately assigns the members responsible for each appointment
                  — individual members cannot be booked.
                </p>
              </Card>
            ) : null}
          </div>

          <div className="grid gap-6 lg:content-start">
            {house.focusAreas.length > 0 ? (
              <Card>
                <h2 className="text-sm font-semibold tracking-wide text-ink">
                  Focus areas
                </h2>
                <ul className="mt-4 flex flex-wrap gap-2">
                  {house.focusAreas.map((area) => (
                    <li key={area}>
                      <Badge>{area}</Badge>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}

            {house.deities.length > 0 ? (
              <Card>
                <h2 className="text-sm font-semibold tracking-wide text-ink">
                  Connected deity profiles
                </h2>
                <ul className="mt-4 flex flex-col gap-2">
                  {house.deities.map((deity) => (
                    <li key={deity.id}>
                      <Link
                        to="/deities/$slug"
                        params={{ slug: deity.slug }}
                        className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface px-4 py-2.5 text-sm text-ink transition-colors hover:border-gold-deep hover:text-gold-deep"
                      >
                        {deity.name}
                        <IconArrow />
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}
          </div>
        </div>
      </Container>
    </PublicPage>
  )
}
