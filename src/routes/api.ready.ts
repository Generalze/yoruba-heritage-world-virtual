import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'

import { getReadinessStatus } from '@/server/health'

/**
 * Readiness probe (Phase One, Step 20).
 *
 * Answers 503 when this process cannot serve real traffic, so a load
 * balancer or an orchestrator takes it out of rotation rather than
 * sending people to a deployment that cannot finish their booking. The
 * body carries bounded codes only — never a credential, host, bucket,
 * path or personal detail.
 */
export const Route = createFileRoute('/api/ready')({
  server: {
    handlers: {
      GET: async () => {
        const readiness = await getReadinessStatus()
        return json(readiness, {
          status: readiness.status === 'ready' ? 200 : 503,
          headers: { 'Cache-Control': 'no-store' },
        })
      },
    },
  },
})
