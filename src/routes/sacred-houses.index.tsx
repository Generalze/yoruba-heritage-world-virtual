import { Link, createFileRoute } from '@tanstack/react-router'

import { listSacredHousesFn } from '@/services/catalogue-actions'

export const Route = createFileRoute('/sacred-houses/')({
  loader: () => listSacredHousesFn(),
  component: SacredHousesPage,
})

function SacredHousesPage() {
  const houses = Route.useLoaderData()

  return (
    <main className="min-h-screen bg-stone-950 px-6 py-12 text-stone-100">
      <div className="mx-auto w-full max-w-3xl">
        <p className="text-sm font-medium tracking-[0.3em] text-amber-500 uppercase">
          Yorùbá Heritage World Virtual
        </p>
        <h1 className="mt-2 text-3xl font-bold">Sacred Houses</h1>
        <p className="mt-3 text-sm text-stone-400">
          Users book Sacred Houses — not individual members. Appointment booking
          opens in a later stage.
        </p>

        <ul className="mt-8 space-y-5">
          {houses.map((house) => (
            <li key={house.id}>
              <Link
                to="/sacred-houses/$slug"
                params={{ slug: house.slug }}
                className="block rounded-lg border border-stone-800 bg-stone-900 p-6 transition-colors hover:border-amber-600"
              >
                <h2 className="text-xl font-semibold">{house.name}</h2>
                {house.shortDescription ? (
                  <p className="mt-2 text-sm text-stone-400">
                    {house.shortDescription}
                  </p>
                ) : null}
                {house.focusAreas.length > 0 ? (
                  <ul className="mt-4 flex flex-wrap gap-2">
                    {house.focusAreas.map((area) => (
                      <li
                        key={area}
                        className="rounded-full border border-stone-700 px-3 py-1 text-xs text-stone-300"
                      >
                        {area}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </main>
  )
}
