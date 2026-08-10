import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { getAuthenticatedUser } from '@/auth/guards'
import { getPrayerRoomStatus } from './prayer-room'

/**
 * Owner-facing Prayer Room server actions (Phase One, Step 18).
 *
 * The ONLY input a browser supplies is the appointment publicId. There
 * is no parameter for a job, an upload, an object key or a provider —
 * not validated-and-rejected, but absent, so a caller has nothing to
 * aim at.
 *
 * Returns SAFE snapshots only: service name, Sacred House name,
 * scheduled time and a coarse state. Never the private request note,
 * never a hash, provider code, object key, upload/job id or pipeline
 * error.
 */

const publicIdSchema = z.string().uuid()

export const getPrayerRoomStatusFn = createServerFn({ method: 'GET' })
  .validator(z.object({ publicId: publicIdSchema }))
  .handler(async ({ data }) => {
    const user = await getAuthenticatedUser()
    // Unauthenticated answers exactly like unknown — the page cannot be
    // used to discover whether an appointment id exists.
    if (!user) return null
    return getPrayerRoomStatus(user.id, data.publicId)
  })
