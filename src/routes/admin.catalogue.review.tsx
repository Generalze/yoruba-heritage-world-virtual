import { Link, createFileRoute, redirect } from '@tanstack/react-router'

import { StatusBadge } from '@/components/admin'
import { adminReviewQueueFn } from '@/services/admin-catalogue-actions'

/**
 * Admin-only review queue: UNDER_REVIEW records across the catalogue.
 * The route guard and the server function both require the approval
 * authority — Content Managers never reach approve/reject controls.
 */
export const Route = createFileRoute('/admin/catalogue/review')({
  beforeLoad: ({ context }) => {
    if (!context.admin.permissions.includes('catalogue.approve')) {
      throw redirect({ to: '/admin/catalogue' })
    }
  },
  loader: () => adminReviewQueueFn(),
  component: ReviewQueuePage,
})

const KIND_LABEL: Record<string, string> = {
  deity: 'Deity profile',
  sacred_house: 'Sacred House',
  service: 'Service',
}

function ReviewQueuePage() {
  const items = Route.useLoaderData()

  return (
    <div>
      <h1 className="text-2xl font-bold">Review Queue</h1>
      <p className="mt-2 text-sm text-stone-400">
        Records submitted for review. Open a record to approve it or return it
        to draft with a reason.
      </p>

      {items.length === 0 ? (
        <p className="mt-8 text-sm text-stone-500">
          Nothing is waiting for review.
        </p>
      ) : (
        <table className="mt-6 w-full text-left text-sm">
          <thead>
            <tr className="border-b border-stone-800 text-xs text-stone-500 uppercase">
              <th className="py-2 pr-4">Type</th>
              <th className="py-2 pr-4">Name</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Last updated</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr
                key={`${item.kind}-${item.id}`}
                className="border-b border-stone-900"
              >
                <td className="py-3 pr-4 text-stone-400">
                  {KIND_LABEL[item.kind]}
                </td>
                <td className="py-3 pr-4">{item.name}</td>
                <td className="py-3 pr-4">
                  <StatusBadge status="UNDER_REVIEW" />
                </td>
                <td className="py-3 pr-4 text-stone-400">
                  {new Date(item.updatedAt).toLocaleString()}
                </td>
                <td className="py-3 text-right">
                  {item.kind === 'deity' ? (
                    <Link
                      to="/admin/catalogue/deities/$id"
                      params={{ id: item.id }}
                      className="text-amber-500 hover:text-amber-400"
                    >
                      Review
                    </Link>
                  ) : item.kind === 'sacred_house' ? (
                    <Link
                      to="/admin/catalogue/sacred-houses/$id"
                      params={{ id: item.id }}
                      className="text-amber-500 hover:text-amber-400"
                    >
                      Review
                    </Link>
                  ) : (
                    <Link
                      to="/admin/catalogue/services/$id"
                      params={{ id: item.id }}
                      className="text-amber-500 hover:text-amber-400"
                    >
                      Review
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
