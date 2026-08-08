import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/admin/catalogue/')({
  component: CatalogueDashboard,
})

const SECTIONS = [
  {
    to: '/admin/catalogue/deities',
    title: 'Deity Profiles',
    detail:
      'Create, edit and submit profiles. Publication requires review and approval.',
  },
  {
    to: '/admin/catalogue/sacred-houses',
    title: 'Sacred Houses',
    detail: 'Manage Houses with their focus areas and public member lists.',
  },
  {
    to: '/admin/catalogue/services',
    title: 'Services',
    detail: 'Manage the service catalogue and its Sacred House connections.',
  },
] as const

function CatalogueDashboard() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Spiritual Catalogue</h1>
      <p className="mt-2 max-w-2xl text-sm text-stone-400">
        New records start as drafts. Drafts are submitted for review; approval
        and publication are Admin authorities. Nothing appears publicly until it
        is approved, published and active.
      </p>
      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        {SECTIONS.map((section) => (
          <Link
            key={section.to}
            to={section.to}
            className="rounded-lg border border-stone-800 bg-stone-900 p-5 transition-colors hover:border-amber-600"
          >
            <h2 className="font-semibold">{section.title}</h2>
            <p className="mt-2 text-xs text-stone-400">{section.detail}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}
