import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { getAuthenticatedUser } from '@/auth/guards'
import { requestContext } from '@/server/request-context'
import { COUNTRIES } from '@/lib/countries'
import {
  SUPPORTED_LANGUAGES,
  acceptRequiredConsents,
  canUserBookSpiritualService,
  getConsentStatus,
  getOwnProfile,
  getOwnSpiritualInterestIds,
  getProfileCompletion,
  listActiveSpiritualInterests,
  personalDetailsSchema,
  replaceSpiritualInterests,
  savePersonalDetails,
  setMarketingPreference,
} from './profile'
import type { SafeUser } from '@/auth/session'

/**
 * Self-service profile server functions. The acting user is ALWAYS
 * resolved from the authenticated server session — no input schema
 * here accepts a user id, so a client can never address another
 * user's profile. CSRF/origin validation applies globally.
 */

export class UnauthenticatedProfileError extends Error {
  constructor() {
    super('Authentication required')
    this.name = 'UnauthenticatedProfileError'
  }
}

async function requireActor(): Promise<SafeUser> {
  const user = await getAuthenticatedUser()
  if (!user) throw new UnauthenticatedProfileError()
  return user
}

/** Everything the profile pages need, for the acting user only. */
export const getMyProfileFn = createServerFn({ method: 'GET' }).handler(
  async () => {
    const actor = await requireActor()
    const [profile, interestIds, catalogue, consents, completion] =
      await Promise.all([
        getOwnProfile(actor.id),
        getOwnSpiritualInterestIds(actor.id),
        listActiveSpiritualInterests(),
        getConsentStatus(actor.id),
        getProfileCompletion(actor.id),
      ])
    return {
      user: { preferredName: actor.preferredName, email: actor.email },
      profile,
      interestIds,
      catalogue,
      consents,
      completion,
      countries: COUNTRIES,
      languages: SUPPORTED_LANGUAGES,
      timezones: Intl.supportedValuesOf('timeZone'),
    }
  },
)

export const savePersonalDetailsFn = createServerFn({ method: 'POST' })
  .validator(personalDetailsSchema)
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await savePersonalDetails(actor.id, data, requestContext())
    return { ok: true }
  })

export const saveSpiritualInterestsFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      interestIds: z.array(z.number().int().positive()).max(50),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await replaceSpiritualInterests(
      actor.id,
      data.interestIds,
      requestContext(),
    )
    return { ok: true }
  })

export const acceptRequiredConsentsFn = createServerFn({
  method: 'POST',
}).handler(async () => {
  const actor = await requireActor()
  await acceptRequiredConsents(actor.id, requestContext())
  return { ok: true }
})

export const setMarketingPreferenceFn = createServerFn({ method: 'POST' })
  .validator(z.object({ optIn: z.boolean() }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await setMarketingPreference(actor.id, data.optIn, requestContext())
    return { ok: true }
  })

/** Used by the dashboard for the completion banner. */
export const getMyCompletionFn = createServerFn({ method: 'GET' }).handler(
  async () => {
    const actor = await requireActor()
    const [completion, eligibility] = await Promise.all([
      getProfileCompletion(actor.id),
      canUserBookSpiritualService(actor.id),
    ])
    return { completion, eligibility }
  },
)
