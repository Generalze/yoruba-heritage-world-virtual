import { Link, Outlet, createFileRoute, redirect } from '@tanstack/react-router'

import { getAdminContextFn } from '@/services/admin-catalogue-actions'

/**
 * Admin area layout. Server-side guard: unauthenticated visitors or
 * accounts without any catalogue/admin permission never load children.
 * Navigation is role-aware (the review queue appears only for holders
 * of catalogue.approve), but every mutation independently re-checks
 * permissions server-side — hidden buttons are not the boundary.
 */
export const Route = createFileRoute('/admin')({
  beforeLoad: async () => {
    const context = await getAdminContextFn()
    if (!context) throw redirect({ to: '/login' })
    return { admin: context }
  },
  component: AdminLayout,
})

function AdminLayout() {
  const { admin } = Route.useRouteContext()
  const canReview = admin.permissions.includes('catalogue.approve')

  return (
    <div className="min-h-screen bg-stone-950 text-stone-100">
      <header className="border-b border-stone-800 bg-stone-900">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <nav className="flex flex-wrap items-center gap-5 text-sm">
            <Link to="/admin" className="font-semibold text-amber-500">
              Admin
            </Link>
            <Link
              to="/admin/catalogue/deities"
              className="text-stone-300 hover:text-amber-500"
            >
              Deity Profiles
            </Link>
            <Link
              to="/admin/catalogue/sacred-houses"
              className="text-stone-300 hover:text-amber-500"
            >
              Sacred Houses
            </Link>
            <Link
              to="/admin/catalogue/services"
              className="text-stone-300 hover:text-amber-500"
            >
              Services
            </Link>
            {canReview ? (
              <Link
                to="/admin/catalogue/review"
                className="text-stone-300 hover:text-amber-500"
              >
                Review Queue
              </Link>
            ) : null}
            {admin.permissions.includes('availability.manage') ? (
              <Link
                to="/admin/scheduling"
                className="text-stone-300 hover:text-amber-500"
              >
                Scheduling
              </Link>
            ) : null}
            {admin.permissions.includes('appointments.view') ? (
              <Link
                to="/admin/appointments"
                className="text-stone-300 hover:text-amber-500"
              >
                Appointments
              </Link>
            ) : null}
            {admin.permissions.includes('payments.view') ? (
              <Link
                to="/admin/payments"
                className="text-stone-300 hover:text-amber-500"
              >
                Payments
              </Link>
            ) : null}
            {admin.permissions.includes('spiritual_content.view') ? (
              <Link
                to="/admin/spiritual-content"
                className="text-stone-300 hover:text-amber-500"
              >
                Spiritual Guidance
              </Link>
            ) : null}
            {admin.permissions.includes('spiritual_content.view') ? (
              <Link
                to="/admin/sacred-content"
                className="text-stone-300 hover:text-amber-500"
              >
                Sacred Content
              </Link>
            ) : null}
          </nav>
          <span className="text-xs text-stone-500">
            {admin.user.preferredName}
          </span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl px-6 py-10">
        <Outlet />
      </main>
    </div>
  )
}
