import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'

import { getAdminContextFn } from '@/services/admin-catalogue-actions'
import { AdminShell } from '@/components/admin-shell'

/**
 * Admin area layout. Server-side guard: unauthenticated visitors or
 * accounts without any catalogue/admin permission never load children.
 * Navigation is role-aware (the review queue appears only for holders
 * of catalogue.approve), but every mutation independently re-checks
 * permissions server-side — hidden buttons are not the boundary.
 *
 * Step 21A.6 moved the chrome itself into AdminShell (§10.5: dark
 * sidebar, cream workspace); the guard above is unchanged.
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

  return (
    <AdminShell
      userName={admin.user.preferredName}
      permissions={admin.permissions}
    >
      <Outlet />
    </AdminShell>
  )
}
