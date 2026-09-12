import { Link, createFileRoute, notFound } from '@tanstack/react-router'

import { getServiceFn } from '@/services/catalogue-actions'
import { getServiceBookableFn } from '@/services/booking-actions'
import { getCurrentUserFn } from '@/auth/actions'
import { PublicPage } from '@/components/site-chrome'
import {
  BackLink,
  Card,
  Container,
  IconArrow,
  Notice,
  PageBanner,
  buttonClass,
} from '@/components/ui'
import { formatAmountMinor } from '@/lib/display-time'

/**
 * Service profile (Step 21A.3) — the last public step before booking.
 *
 * Price is shown ONLY when the stored record actually carries it, and
 * the amount is formatted through the shared
 * currency helper, which derives the minor-unit scale from the
 * currency itself. Internal scheduling duration is not advertised as
 * the length of the spiritual experience. The Book affordance appears
 * only when the SERVER says a genuine booking path exists.
 */
export const Route = createFileRoute('/services/$slug')({
  beforeLoad: async () => ({ user: await getCurrentUserFn() }),
  loader: async ({ params }) => {
    const service = await getServiceFn({ data: { slug: params.slug } })
    if (!service) throw notFound()
    // Server-computed boolean only: the Book button appears solely when
    // a genuine booking path exists (published + active + configured +
    // booking enabled) — never a fake path, never internal details.
    const { bookable } = await getServiceBookableFn({
      data: { serviceSlug: params.slug },
    })
    return { ...service, bookable }
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData
          ? `${loaderData.name} — Yorùbá Heritage World Virtual`
          : 'Service — Yorùbá Heritage World Virtual',
      },
    ],
  }),
  notFoundComponent: ServiceNotFound,
  component: ServicePage,
})

function ServiceNotFound() {
  const { user } = Route.useRouteContext()
  return (
    <PublicPage user={user}>
      <PageBanner
        title="Service not found"
        intro="This service is not available."
      >
        <div className="mt-6">
          <Link
            to="/services"
            className={buttonClass('secondary-on-dark', 'md')}
          >
            Back to services
          </Link>
        </div>
      </PageBanner>
    </PublicPage>
  )
}

function ServicePage() {
  const { user } = Route.useRouteContext()
  const service = Route.useLoaderData()
  const price =
    service.priceMinor !== null && service.currency !== null
      ? formatAmountMinor(service.priceMinor, service.currency)
      : null

  return (
    <PublicPage user={user}>
      <PageBanner kicker="Spiritual service" title={service.name}>
        <p className="mt-4 text-sm text-cream-soft-on-night">
          Offered by{' '}
          <Link
            to="/sacred-houses/$slug"
            params={{ slug: service.sacredHouse.slug }}
            className="font-semibold text-gold-bright underline-offset-4 hover:underline"
          >
            {service.sacredHouse.name}
          </Link>
        </p>
        <div className="mt-6">
          <BackLink to="/services">All services</BackLink>
        </div>
      </PageBanner>

      <Container className="py-12 sm:py-16">
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Card>
              <h2 className="text-sm font-semibold tracking-wide text-ink">
                About this service
              </h2>
              {service.shortDescription ? (
                <p className="mt-3 leading-relaxed text-ink-soft">
                  {service.shortDescription}
                </p>
              ) : (
                <p className="mt-3 text-sm text-ink-soft">
                  This service is offered through {service.sacredHouse.name}.
                </p>
              )}
              <p className="mt-6 text-sm leading-relaxed text-ink-soft">
                Appointments are booked with {service.sacredHouse.name}, never
                with an individual member. The Sacred House privately assigns
                the members responsible for your appointment.
              </p>
            </Card>
          </div>

          <div className="lg:content-start">
            <Card>
              <h2 className="text-sm font-semibold tracking-wide text-ink">
                Booking
              </h2>
              {price ? (
                <dl className="mt-4 divide-y divide-line text-sm">
                  <div className="flex justify-between gap-4 py-2.5">
                    <dt className="text-ink-soft">Private appointment</dt>
                    <dd className="font-semibold text-ink">{price}</dd>
                  </div>
                </dl>
              ) : (
                <p className="mt-3 text-sm leading-relaxed text-ink-soft">
                  Booking details are not open yet for this service.
                </p>
              )}
              <p className="mt-4 text-sm leading-relaxed text-ink-soft">
                Select an available appointment date and time and provide a
                brief private note about the matter you would like addressed.
                Your appointment is with the Sacred House; the approved
                representative is assigned privately.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-ink-soft">
                Following confirmation, the Sacred House prepares the spiritual
                experience associated with your appointment. Your private Prayer
                Room remains locked until your scheduled appointment time and
                becomes accessible when that time arrives.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-ink-soft">
                There is no fixed appointment duration. The length of the
                experience follows the approved video prepared specifically for
                your appointment.
              </p>

              <div className="mt-5">
                {service.bookable ? (
                  <Link
                    to="/book/$serviceSlug"
                    params={{ serviceSlug: service.slug }}
                    className={buttonClass('primary', 'md')}
                  >
                    Book appointment
                    <IconArrow />
                  </Link>
                ) : (
                  <Notice>
                    Online booking is not open for this service yet. Please
                    check back soon or contact Yoruba Heritage World for help
                    with this Sacred House.
                  </Notice>
                )}
              </div>
            </Card>
          </div>
        </div>
      </Container>
    </PublicPage>
  )
}
