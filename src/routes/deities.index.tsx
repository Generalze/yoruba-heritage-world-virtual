import { Link, createFileRoute } from '@tanstack/react-router'

import { listDeitiesFn } from '@/services/catalogue-actions'
import { PublicPage } from '@/components/site-chrome'
import { InitialMedallion } from '@/components/motifs'
import { Container, IconArrow, PageBanner } from '@/components/ui'

/**
 * Deity profile directory (Step 21A.3). Only published, approved
 * profiles appear, and Olódùmárè is never among them — Olódùmárè is
 * presented separately, on its own page, and is not a catalogue
 * record (canon §1).
 */
export const Route = createFileRoute('/deities/')({
  loader: () => listDeitiesFn(),
  head: () => ({
    meta: [{ title: 'Deity profiles — Yorùbá Heritage World Virtual' }],
  }),
  component: DeitiesPage,
})

function DeitiesPage() {
  const deities = Route.useLoaderData()

  return (
    <PublicPage>
      <PageBanner
        kicker="Deity profiles"
        title="Approved spiritual profiles"
        intro="Informational and educational profiles, published through the platform's editorial approval workflow."
      >
        <p className="mt-4 text-sm text-cream-soft-on-night">
          <Link
            to="/olodumare"
            className="font-semibold text-gold-bright underline-offset-4 hover:underline"
          >
            Olódùmárè is presented separately
          </Link>
          .
        </p>
      </PageBanner>

      <Container className="py-12 sm:py-16">
        {deities.length === 0 ? (
          <p className="text-ink-soft">
            Deity profiles will appear here once they are published.
          </p>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {deities.map((deity) => (
              <li key={deity.id}>
                <Link
                  to="/deities/$slug"
                  params={{ slug: deity.slug }}
                  className="group flex h-full items-start gap-4 rounded-lg border border-line bg-surface-raised p-5 shadow-[0_1px_3px_rgba(43,32,24,0.08)] transition-colors hover:border-gold-deep"
                >
                  <InitialMedallion name={deity.name} />
                  <span className="min-w-0">
                    <span className="font-display block text-lg text-ink transition-colors group-hover:text-gold-deep">
                      {deity.name}
                    </span>
                    {deity.shortDescription ? (
                      <span className="mt-1 block text-sm leading-relaxed text-ink-soft">
                        {deity.shortDescription}
                      </span>
                    ) : (
                      <span className="mt-1 inline-flex items-center gap-2 text-xs font-semibold text-gold-deep">
                        View profile
                        <IconArrow />
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Container>
    </PublicPage>
  )
}
