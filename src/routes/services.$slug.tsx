import { Link, createFileRoute, notFound } from '@tanstack/react-router'

import { getServiceFn } from '@/services/catalogue-actions'
import { getServiceBookableFn } from '@/services/booking-actions'

export const Route = createFileRoute('/services/$slug')({
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
  notFoundComponent: ServiceNotFound,
  component: ServicePage,
})

function ServiceNotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-stone-950 px-6 text-stone-100">
      <h1 className="text-2xl font-bold">Service not found</h1>
      <Link to="/services" className="mt-4 text-amber-500 hover:text-amber-400">
        Back to services
      </Link>
    </main>
  )
}

function ServicePage() {
  const service = Route.useLoaderData()
  // Prices/durations are shown only when real approved data exists —
  // never fake placeholders.
  const hasBookingDetails =
    service.durationMinutes !== null || service.priceMinor !== null

  return (
    <main className="min-h-screen bg-stone-950 px-6 py-12 text-stone-100">
      <div className="mx-auto w-full max-w-3xl">
        <Link
          to="/services"
          className="text-sm text-stone-400 hover:text-amber-500"
        >
          ← All services
        </Link>
        <h1 className="mt-4 text-3xl font-bold">{service.name}</h1>
        <p className="mt-2 text-sm text-stone-400">
          Offered by{' '}
          <Link
            to="/sacred-houses/$slug"
            params={{ slug: service.sacredHouse.slug }}
            className="text-amber-500 hover:text-amber-400"
          >
            {service.sacredHouse.name}
          </Link>
        </p>

        {service.shortDescription ? (
          <p className="mt-6 text-stone-300">{service.shortDescription}</p>
        ) : null}

        {hasBookingDetails ? (
          <dl className="mt-6 space-y-2 text-sm">
            {service.durationMinutes !== null ? (
              <div className="flex gap-3">
                <dt className="text-stone-400">Duration</dt>
                <dd>{service.durationMinutes} minutes</dd>
              </div>
            ) : null}
            {service.priceMinor !== null && service.currency !== null ? (
              <div className="flex gap-3">
                <dt className="text-stone-400">Price</dt>
                <dd>
                  {(service.priceMinor / 100).toLocaleString()}{' '}
                  {service.currency}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : (
          <p className="mt-6 text-sm text-stone-500">
            Details will be provided when this service is opened for booking.
          </p>
        )}

        {service.bookable ? (
          <Link
            to="/book/$serviceSlug"
            params={{ serviceSlug: service.slug }}
            className="mt-8 inline-block rounded-md bg-amber-600 px-6 py-3 text-sm font-medium text-stone-950 transition-colors hover:bg-amber-500"
          >
            Book Appointment
          </Link>
        ) : (
          <p className="mt-8 text-sm text-stone-500">
            Online booking is not available for this service at the moment.
          </p>
        )}
      </div>
    </main>
  )
}
