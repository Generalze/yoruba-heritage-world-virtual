import { Link, createFileRoute, notFound } from '@tanstack/react-router'

import { getSacredHouseFn } from '@/services/catalogue-actions'

export const Route = createFileRoute('/sacred-houses/$slug')({
  loader: async ({ params }) => {
    const house = await getSacredHouseFn({ data: { slug: params.slug } })
    if (!house) throw notFound()
    return house
  },
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
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-stone-950 px-6 text-stone-100">
      <h1 className="text-2xl font-bold">Sacred House not found</h1>
      <Link
        to="/sacred-houses"
        className="mt-4 text-amber-500 hover:text-amber-400"
      >
        Back to Sacred Houses
      </Link>
    </main>
  )
}

function SacredHousePage() {
  const house = Route.useLoaderData()

  return (
    <main className="min-h-screen bg-stone-950 px-6 py-12 text-stone-100">
      <div className="mx-auto w-full max-w-3xl">
        <Link
          to="/sacred-houses"
          className="text-sm text-stone-400 hover:text-amber-500"
        >
          ← All Sacred Houses
        </Link>
        <h1 className="mt-4 text-3xl font-bold">{house.name}</h1>
        {house.shortDescription ? (
          <p className="mt-4 text-stone-300">{house.shortDescription}</p>
        ) : null}

        {house.deities.length > 0 ? (
          <section className="mt-8">
            <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
              Connected deity profiles
            </h2>
            <ul className="mt-3 flex flex-wrap gap-3">
              {house.deities.map((deity) => (
                <li key={deity.id}>
                  <Link
                    to="/deities/$slug"
                    params={{ slug: deity.slug }}
                    className="rounded-full border border-stone-700 px-4 py-1.5 text-sm text-stone-200 transition-colors hover:border-amber-500 hover:text-amber-500"
                  >
                    {deity.name}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {house.focusAreas.length > 0 ? (
          <section className="mt-8">
            <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
              Focus areas
            </h2>
            <ul className="mt-3 flex flex-wrap gap-2">
              {house.focusAreas.map((area) => (
                <li
                  key={area}
                  className="rounded-full border border-stone-700 px-3 py-1 text-xs text-stone-300"
                >
                  {area}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {house.services.length > 0 ? (
          <section className="mt-8">
            <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
              Service families
            </h2>
            <ul className="mt-3 space-y-2">
              {house.services.map((service) => (
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
        ) : null}

        {house.members.length > 0 ? (
          <section className="mt-8">
            <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
              Sacred House members
            </h2>
            {/* Informational list only. No booking actions here by rule:
                users book the Sacred House, never an individual member. */}
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {house.members.map((member) => (
                <li
                  key={member.displayName}
                  className="rounded-lg border border-stone-800 bg-stone-900 px-4 py-3"
                >
                  <span className="text-stone-200">{member.displayName}</span>
                  <span className="mt-0.5 block text-xs text-stone-500">
                    {MEMBER_TYPE_LABELS[member.memberType] ?? member.memberType}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-xs text-stone-500">
              Appointments are booked with the Sacred House. The House privately
              assigns the members responsible for each appointment — individual
              members cannot be booked.
            </p>
          </section>
        ) : null}
      </div>
    </main>
  )
}
