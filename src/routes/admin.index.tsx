import { Link, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/admin/')({
  component: AdminDashboard,
})

function AdminDashboard() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Administration</h1>
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        <Link
          to="/admin/catalogue"
          className="rounded-lg border border-line bg-surface-raised p-5 transition-colors hover:border-gold-deep"
        >
          <h2 className="font-semibold">Spiritual Catalogue</h2>
          <p className="mt-2 text-xs text-ink-soft">
            Deity profiles, Sacred Houses and services — authoring, review,
            approval and publication.
          </p>
        </Link>
      </div>
    </div>
  )
}
