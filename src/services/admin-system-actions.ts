import { createServerFn } from '@tanstack/react-start'

import { getAuthenticatedUser } from '@/auth/guards'
import { getUserPermissionCodes } from '@/auth/rbac'
import { env } from '@/lib/env'
import { getHealthStatus, getReadinessStatus } from '@/server/health'

class UnauthenticatedError extends Error {
  constructor() {
    super('Authentication required')
    this.name = 'UnauthenticatedError'
  }
}

async function requireAdminRelevantUser(): Promise<void> {
  const user = await getAuthenticatedUser()
  if (!user) throw new UnauthenticatedError()
  const permissions = await getUserPermissionCodes(user.id)
  const relevant = permissions.some(
    (code) =>
      code.startsWith('deities.') ||
      code.startsWith('sacred_houses.') ||
      code.startsWith('services.') ||
      code.startsWith('catalogue.') ||
      code.startsWith('spiritual_content.') ||
      code === 'admin.access',
  )
  if (!relevant) throw new UnauthenticatedError()
}

export const adminGetSystemStatusFn = createServerFn({
  method: 'GET',
}).handler(async () => {
  await requireAdminRelevantUser()
  const [health, readiness] = await Promise.all([
    getHealthStatus(),
    getReadinessStatus(),
  ])
  return {
    health,
    readiness,
    payments: {
      globalCurrency: 'USD',
      paymentsEnabled: env.PAYMENTS_ENABLED,
      paypalEnabled: env.PAYPAL_ENABLED,
      paypalEnv: env.PAYPAL_ENV,
      stripeEnabled: env.STRIPE_ENABLED,
    },
    productionPath: {
      manualPreparedVideoUpload: true,
      prayerRoomUploadMax: '1 GiB',
      automatedVisualGeneration: env.VISUAL_GENERATION_DRIVER !== 'DISABLED',
      automatedTts: env.TTS_DRIVER !== 'DISABLED',
    },
  }
})
