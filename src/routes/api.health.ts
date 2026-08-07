import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'

import { getHealthStatus } from '@/server/health'

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: async () => json(await getHealthStatus()),
    },
  },
})
