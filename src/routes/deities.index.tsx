import { Link, createFileRoute } from '@tanstack/react-router'

import { listDeitiesFn } from '@/services/catalogue-actions'

export const Route = createFileRoute('/deities/')({
  loader: () => listDeitiesFn(),
  component: DeitiesPage,
})

function DeitiesPage() {
  const deities = Route.useLoaderData()

  return (
    <main className="min-h-screen bg-stone-950 px-6 py-12 text-stone-100">
      <div className="mx-auto w-full max-w-3xl">
        <p className="text-sm font-medium tracking-[0.3em] text-amber-500 uppercase">
          Yorùbá Heritage World Virtual
        </p>
        <h1 className="mt-2 text-3xl font-bold">Deity Profiles</h1>
        <p className="mt-3 text-sm text-stone-400">
          Informational and educational profiles.{' '}
          <Link to="/olodumare" className="text-amber-500 hover:text-amber-400">
            Olódùmárè is presented separately
          </Link>
          .
        </p>

        <ul className="mt-8 grid gap-4 sm:grid-cols-2">
          {deities.map((deity) => (
            <li key={deity.id}>
              <Link
                to="/deities/$slug"
                params={{ slug: deity.slug }}
                className="block rounded-lg border border-stone-800 bg-stone-900 p-5 transition-colors hover:border-amber-600"
              >
                <h2 className="text-lg font-semibold">{deity.name}</h2>
                {deity.shortDescription ? (
                  <p className="mt-2 text-sm text-stone-400">
                    {deity.shortDescription}
                  </p>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </main>
  )
}
