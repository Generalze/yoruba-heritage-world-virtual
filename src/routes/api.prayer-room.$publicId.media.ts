import { createFileRoute } from '@tanstack/react-router'

import { getAuthenticatedUser } from '@/auth/guards'
import { servePrayerRoomMedia } from '@/services/prayer-room'

/**
 * Authenticated Prayer Room media endpoint (Phase One, Step 18):
 *
 *   GET /api/prayer-room/:appointmentPublicId/media
 *
 * The browser identifies the recording by appointment publicId ONLY.
 * There is no parameter for an object key, a provider, an upload or a
 * job, so a caller cannot select what is served — the server derives
 * all of that from the appointment it has just proved they own.
 *
 * Every request repeats the ENTIRE proof: authentication, ownership,
 * appointment status, the appointment-time gate, job READY, and the
 * shared Step 17 upload verification (identity, provider permission,
 * remote existence, size, mime and SHA-256). Nothing is cached between
 * requests and nothing is trusted from page load.
 *
 * This route is deliberately thin: all of the behaviour lives in
 * servePrayerRoomMedia so it can be exercised directly, with real
 * Request objects and real byte ranges, without a running server.
 */
export const Route = createFileRoute('/api/prayer-room/$publicId/media')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const user = await getAuthenticatedUser()
        return servePrayerRoomMedia({
          userId: user?.id ?? null,
          publicId: params.publicId,
          request,
        })
      },
    },
  },
})
