import { Link, createFileRoute } from '@tanstack/react-router'

import { listServicesFn } from '@/services/catalogue-actions'

export const Route = createFileRoute('/services/')({
  loader: () => listServicesFn(),
  component: ServicesPage,
})

function ServicesPage() {
  const groups = Route.useLoaderData()

  return (
    <main className="min-h-screen bg-stone-950 px-6 py-12 text-stone-100">
      <div className="mx-auto w-full max-w-3xl">
        <p className="text-sm font-medium tracking-[0.3em] text-amber-500 uppercase">
          Yorùbá Heritage World Virtual
        </p>
        <h1 className="mt-2 text-3xl font-bold">Service Families</h1>
        <p className="mt-3 text-sm text-stone-400">
          Grouped by Sacred House. Details will be provided when each service is
          opened for booking.
        </p>

        {groups.map((group) => (
          <section key={group.sacredHouse.id} className="mt-10">
            <h2 className="text-lg font-semibold">
              <Link
                to="/sacred-houses/$slug"
                params={{ slug: group.sacredHouse.slug }}
                className="hover:text-amber-500"
              >
                {group.sacredHouse.name}
              </Link>
            </h2>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {group.services.map((service) => (
                <li key={service.id}>
                  <Link
                    to="/services/$slug"
                    params={{ slug: service.slug }}
                    className="block rounded-lg border border-stone-800 bg-stone-900 p-4 transition-colors hover:border-amber-600"
                  >
                    {service.name}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  )
}
