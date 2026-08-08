import { Link, createFileRoute, notFound } from '@tanstack/react-router'

import { getDeityFn } from '@/services/catalogue-actions'

export const Route = createFileRoute('/deities/$slug')({
  loader: async ({ params }) => {
    const deity = await getDeityFn({ data: { slug: params.slug } })
    if (!deity) throw notFound()
    return deity
  },
  notFoundComponent: DeityNotFound,
  component: DeityPage,
})

function DeityNotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-stone-950 px-6 text-stone-100">
      <h1 className="text-2xl font-bold">Profile not found</h1>
      <Link to="/deities" className="mt-4 text-amber-500 hover:text-amber-400">
        Back to deity profiles
      </Link>
    </main>
  )
}

function DeityPage() {
  const deity = Route.useLoaderData()

  return (
    <main className="min-h-screen bg-stone-950 px-6 py-12 text-stone-100">
      <div className="mx-auto w-full max-w-3xl">
        <Link
          to="/deities"
          className="text-sm text-stone-400 hover:text-amber-500"
        >
          ← All deity profiles
        </Link>
        <h1 className="mt-4 text-3xl font-bold">{deity.name}</h1>
        {deity.shortDescription ? (
          <p className="mt-4 text-stone-300">{deity.shortDescription}</p>
        ) : (
          <p className="mt-4 text-sm text-stone-500">
            An approved profile description will be published here.
          </p>
        )}

        {deity.sacredHouses.length > 0 ? (
          <section className="mt-10">
            <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
              Connected Sacred Houses
            </h2>
            <ul className="mt-4 space-y-3">
              {deity.sacredHouses.map((house) => (
                <li key={house.id}>
                  <Link
                    to="/sacred-houses/$slug"
                    params={{ slug: house.slug }}
                    className="block rounded-lg border border-stone-800 bg-stone-900 p-4 transition-colors hover:border-amber-600"
                  >
                    {house.name}
                  </Link>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-stone-500">
              Appointments are made with Sacred Houses, in a later stage of the
              platform.
            </p>
          </section>
        ) : null}

        {deity.services.length > 0 ? (
          <section className="mt-10">
            <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
              Connected service families
            </h2>
            <ul className="mt-4 space-y-2">
              {deity.services.map((service) => (
                <li key={service.id}>
                  <Link
                    to="/services/$slug"
                    params={{ slug: service.slug }}
                    className="text-stone-300 hover:text-amber-500"
                  >
                    {service.name}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </main>
  )
}
