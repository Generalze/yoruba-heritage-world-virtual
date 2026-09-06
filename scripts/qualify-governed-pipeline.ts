/**
 * GOVERNED PIPELINE QUALIFICATION — the smallest real end-to-end run,
 * repeatable.
 *
 *   bun run scripts/qualify-governed-pipeline.ts /out/report.json
 *
 * STAGING ONLY. It refuses to run against a production configuration,
 * because it publishes governed versions, configures a bookable price
 * and settles a payment — every one of which is a real act.
 *
 * WHAT IT PROVES: that one confirmed appointment for one House and one
 * service produces a real MP4 in private object storage, built from
 * exactly the approved content, media and rules a person authorised,
 * with every identity and hash checked rather than assumed.
 *
 * WHAT IT DOES NOT DO: nothing here mutates a status by hand. The
 * appointment is CONFIRMED only by settling a payment through the real
 * webhook path, and the recording is produced only by the same
 * pipeline pass the worker runs. A test that reached into the database
 * to set CONFIRMED would prove the database accepts writes, which
 * nobody doubts.
 *
 * REPEATABLE, WITHOUT WEAKENING ANYTHING. The first version assumed a
 * pristine database: it created availability windows blindly, so a
 * rerun after an interrupted run died on an overlap and needed a manual
 * reset. Every setup step below is now CONVERGENT — it inspects the
 * current state and treats it as satisfied ONLY when that state is
 * exactly what this qualification requires, and otherwise fails loudly.
 * Nothing is wrapped in a bare catch: "already fine" and "broken in a
 * way I did not look at" must never be the same branch.
 *
 * Setup converges; the appointment, payment, job and recording are
 * always FRESH, because a qualification that reused a previous run's
 * recording would prove nothing about this one.
 *
 * NO PAID PROVIDER IS REACHABLE. TTS and visual generation are
 * DISABLED, and the English launch content is TEXT_ONLY — so the
 * manifest carries no audio requirement at all and 9jaLingo is never
 * called, not even to be refused.
 */
import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { and, eq } from 'drizzle-orm'

import { closeDb, getDb } from '@/db'
import {
  appointments,
  paymentAttempts,
  prayerGenerationAudioTasks,
  prayerGenerationJobs,
  prayerGenerationRecipeSnapshots,
  prayerGenerationRenderResults,
  prayerGenerationUploads,
  prayerGenerationVisualTasks,
  prayerSessionTemplateVersions,
  sacredHouseAvailability,
  sacredHouseBookingSettings,
  sacredHouses,
  services,
  visualBibleReferenceMedia,
  visualBibleVersions,
} from '@/db/schema'
import { env } from '@/lib/env'
import { V3_LAUNCH_CONTENT } from '@/lib/launch-content-v3'
import { buildMockWebhook } from '@/providers/payments/mock'
import { getObjectStorage } from '@/providers/object-storage/registry'
import { registerUser } from '@/auth/service'
import { grantRoleByEmail } from '@/db/grant-role'
import { acceptRequiredConsents, savePersonalDetails } from '@/services/profile'
import { updateService } from '@/services/admin-catalogue'
import {
  addAvailabilityWindow,
  updateBookingSettings,
} from '@/services/scheduling'
import { publishVisualBibleVersion } from '@/services/visual-bibles'
import { publishTemplateVersion } from '@/services/prayer-templates'
import {
  computeAvailableSlots,
  createReservation,
} from '@/services/appointments'
import { initiatePayment, processProviderWebhook } from '@/services/payments'
import { runGenerationPipelinePass } from '@/services/generation-pipeline'
import { systemGenerationClock } from '@/services/generation-jobs'

const OUT = process.argv[2] ?? '/out/report.json'

const HOUSE_CODE = 'ILE_AWON_BABALAWO'
const SERVICE_CODE = 'BABALAWO_DIVINATION'
const VISUAL_BIBLE_VERSION = 886
const TEMPLATE_VERSION = 28958
const LANGUAGE = 'en'
const PRICE_MINOR = 12345
const CURRENCY = 'NGN'
const DURATION_MINUTES = 30
const WINDOW_START = '09:00:00'
const WINDOW_END = '17:00:00'
const BOOKING_SETTINGS = {
  schedulingTimezone: 'Africa/Lagos',
  bookingEnabled: true,
  slotIncrementMinutes: 30,
  minimumLeadMinutes: 60,
  maximumAdvanceDays: 14,
  reservationHoldMinutes: 15,
  cancellationCutoffMinutes: 120,
  rescheduleCutoffMinutes: 120,
} as const

// THE PRODUCTION GUARD. Not a warning — a refusal.
if (env.NODE_ENV === 'production') {
  console.error(
    'refusing: this qualification publishes, prices and settles. Staging only.',
  )
  process.exit(1)
}

const runId = `qual-${new Date()
  .toISOString()
  .replace(/[^0-9]/g, '')
  .slice(0, 14)}-${randomUUID().slice(0, 8)}`
const ctx = {
  ipAddress: '127.0.0.1',
  userAgent: `staging-qualification/${runId}`,
}
const db = getDb()

const report: Record<string, unknown> = {
  runId,
  gitSha: process.env.APP_REVISION ?? null,
  startedAt: new Date().toISOString(),
  environment: env.NODE_ENV,
  drivers: {
    render: env.RENDER_DRIVER,
    tts: env.TTS_DRIVER,
    visualGeneration: env.VISUAL_GENERATION_DRIVER,
    email: env.NOTIFICATION_EMAIL_DRIVER,
    objectStorage: env.OBJECT_STORAGE_DRIVER,
  },
  setup: {} as Record<string, string>,
}
const setup = report.setup as Record<string, string>

function step(name: string): void {
  console.log(`\n== ${name}`)
}

function writeReport(): void {
  report.finishedAt = new Date().toISOString()
  writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')
}

/** Evidence first, always. A failure that destroys its own explanation
 * is a failure nobody can act on. */
function fail(message: string): never {
  console.error(`\nFAILED: ${message}`)
  report.passed = false
  report.failure = message
  writeReport()
  console.error(`report written to ${OUT}`)
  // Synchronous on purpose: `fail()` does not narrow types, and
  // the narrowing is what stops a later line from using a value this
  // function has already proved absent.
  process.exit(1)
}

console.log(`GOVERNED PIPELINE QUALIFICATION\nrunId ${runId}`)
console.log(`revision ${String(report.gitSha ?? '(unset)')}`)

// --- 1. Identities. Always fresh, always traceable to this run ---------
step('operator and seeker (real registration flow)')
const operatorEmail = `qual-operator+${runId}@example.invalid`
const seekerEmail = `qual-seeker+${runId}@example.invalid`

const operator = await registerUser(
  {
    email: operatorEmail,
    password: 'Staging-Operator-Passw0rd!',
    preferredName: 'Qual Operator',
  },
  ctx,
)
if (!operator.ok) fail(`operator registration failed: ${operator.error}`)
await grantRoleByEmail(operatorEmail, 'SUPER_ADMIN')
const operatorId = operator.user.id

const seeker = await registerUser(
  {
    email: seekerEmail,
    password: 'Staging-Seeker-Passw0rd!',
    preferredName: 'Qual Seeker',
  },
  ctx,
)
if (!seeker.ok) fail(`seeker registration failed: ${seeker.error}`)
const seekerId = seeker.user.id

await savePersonalDetails(
  seekerId,
  {
    preferredName: 'Qual Seeker',
    fullName: 'Qualification Seeker',
    phone: '+2348000000000',
    countryCode: 'NG',
    timezone: 'Africa/Lagos',
    preferredLanguage: LANGUAGE,
    dateOfBirth: '1990-01-01',
  },
  ctx,
)
await acceptRequiredConsents(seekerId, ctx)
console.log(`  operator ${operatorId}, seeker ${seekerId} (fresh for this run)`)
setup.identities = 'created'

// --- 2. The one service, converged -------------------------------------
step('configure exactly one service (convergent)')
const house = (
  await db
    .select()
    .from(sacredHouses)
    .where(eq(sacredHouses.code, HOUSE_CODE))
    .limit(1)
).at(0)
if (!house) fail(`House ${HOUSE_CODE} not found`)
const serviceBefore = (
  await db.select().from(services).where(eq(services.code, SERVICE_CODE)).limit(1)
).at(0)
if (!serviceBefore) fail(`Service ${SERVICE_CODE} not found`)
if (serviceBefore.sacredHouseId !== house.id) {
  fail('service does not belong to the expected House')
}

if (
  serviceBefore.durationMinutes === DURATION_MINUTES &&
  serviceBefore.priceMinor === PRICE_MINOR &&
  serviceBefore.currency === CURRENCY
) {
  console.log('  already exactly the required values — satisfied')
  setup.service = 'already-correct'
} else {
  await updateService(operatorId, ctx, serviceBefore.id, {
    durationMinutes: DURATION_MINUTES,
    priceMinor: PRICE_MINOR,
    currency: CURRENCY,
  })
  console.log(`  ${SERVICE_CODE}: ${DURATION_MINUTES}min ${CURRENCY} ${PRICE_MINOR}`)
  setup.service = 'configured'
}
const service = (
  await db.select().from(services).where(eq(services.id, serviceBefore.id)).limit(1)
).at(0)!

// --- 3. Booking settings, converged ------------------------------------
step('booking settings for this House only (convergent)')
const settingsBefore = (
  await db
    .select()
    .from(sacredHouseBookingSettings)
    .where(eq(sacredHouseBookingSettings.sacredHouseId, house.id))
    .limit(1)
).at(0)
if (
  settingsBefore != null &&
  settingsBefore.schedulingTimezone === BOOKING_SETTINGS.schedulingTimezone &&
  settingsBefore.bookingEnabled === BOOKING_SETTINGS.bookingEnabled &&
  settingsBefore.slotIncrementMinutes === BOOKING_SETTINGS.slotIncrementMinutes &&
  settingsBefore.minimumLeadMinutes === BOOKING_SETTINGS.minimumLeadMinutes &&
  settingsBefore.maximumAdvanceDays === BOOKING_SETTINGS.maximumAdvanceDays &&
  settingsBefore.reservationHoldMinutes ===
    BOOKING_SETTINGS.reservationHoldMinutes &&
  settingsBefore.cancellationCutoffMinutes ===
    BOOKING_SETTINGS.cancellationCutoffMinutes &&
  settingsBefore.rescheduleCutoffMinutes ===
    BOOKING_SETTINGS.rescheduleCutoffMinutes
) {
  console.log('  already exactly the required settings — satisfied')
  setup.bookingSettings = 'already-correct'
} else {
  await updateBookingSettings(operatorId, ctx, house.id, { ...BOOKING_SETTINGS })
  console.log('  booking enabled for this House')
  setup.bookingSettings = 'configured'
}

// --- 4. Availability, converged ----------------------------------------
//
// The defect this replaces: windows were created blindly, so a rerun
// after an interrupted run died on "overlaps an existing active
// window". Each required window is checked for FIRST and created only
// when genuinely absent — and a duplicate that should not exist is a
// failure, not something to paper over.
step('availability windows (convergent, never overlapping)')
let createdWindows = 0
let existingWindows = 0
for (let day = 1; day <= 7; day += 1) {
  const already = (
    await db
      .select()
      .from(sacredHouseAvailability)
      .where(
        and(
          eq(sacredHouseAvailability.sacredHouseId, house.id),
          eq(sacredHouseAvailability.dayOfWeek, day),
          eq(sacredHouseAvailability.active, true),
        ),
      )
  ).filter(
    (row) =>
      String(row.startLocalTime) === WINDOW_START &&
      String(row.endLocalTime) === WINDOW_END,
  )
  if (already.length === 1) {
    existingWindows += 1
    continue
  }
  if (already.length > 1) {
    fail(`day ${day} has ${already.length} identical active windows`)
  }
  await addAvailabilityWindow(operatorId, ctx, house.id, {
    dayOfWeek: day,
    startLocalTime: WINDOW_START.slice(0, 5),
    endLocalTime: WINDOW_END.slice(0, 5),
  })
  createdWindows += 1
}
console.log(`  ${createdWindows} created, ${existingWindows} already present`)
setup.availability = `created=${createdWindows} existing=${existingWindows}`

// --- 5. Publication, converged -----------------------------------------
step('publish the one Visual Bible and the one template (convergent)')
const bibleVersion = (
  await db
    .select()
    .from(visualBibleVersions)
    .where(eq(visualBibleVersions.id, VISUAL_BIBLE_VERSION))
    .limit(1)
).at(0)
if (!bibleVersion) {
  fail(`Visual Bible version ${VISUAL_BIBLE_VERSION} not found`)
}
if (bibleVersion.status === 'PUBLISHED') {
  console.log(`  visual bible ${VISUAL_BIBLE_VERSION} already PUBLISHED — satisfied`)
  setup.visualBible = 'already-published'
} else if (bibleVersion.status === 'APPROVED') {
  await publishVisualBibleVersion(operatorId, ctx, VISUAL_BIBLE_VERSION)
  setup.visualBible = 'published'
} else {
  fail(
    `Visual Bible ${VISUAL_BIBLE_VERSION} is ${bibleVersion.status}; expected APPROVED or PUBLISHED`,
  )
}

const templateVersion = (
  await db
    .select()
    .from(prayerSessionTemplateVersions)
    .where(eq(prayerSessionTemplateVersions.id, TEMPLATE_VERSION))
    .limit(1)
).at(0)
if (!templateVersion) fail(`Template version ${TEMPLATE_VERSION} not found`)
if (templateVersion.status === 'PUBLISHED') {
  console.log(`  template ${TEMPLATE_VERSION} already PUBLISHED — satisfied`)
  setup.template = 'already-published'
} else if (templateVersion.status === 'APPROVED') {
  await publishTemplateVersion(operatorId, ctx, TEMPLATE_VERSION)
  setup.template = 'published'
} else {
  fail(
    `Template ${TEMPLATE_VERSION} is ${templateVersion.status}; expected APPROVED or PUBLISHED`,
  )
}

// --- 6. A FRESH reservation for this run --------------------------------
step('reserve a real slot (real availability, real eligibility)')
const now = new Date()
const from = now.toISOString().slice(0, 10)
const to = new Date(now.getTime() + 10 * 86_400_000).toISOString().slice(0, 10)
const slots = await computeAvailableSlots(service.id, from, to)
if (slots.length === 0) fail('no bookable slot was offered')
const reservation = await createReservation(seekerId, ctx, {
  serviceId: service.id,
  startsAtUtc: slots[0].startsAtUtc,
})
console.log(
  `  appointment ${reservation.appointmentId} at ${reservation.startsAtUtc}`,
)

const reserved = (
  await db
    .select()
    .from(appointments)
    .where(eq(appointments.id, reservation.appointmentId))
    .limit(1)
).at(0)
if (reserved?.status !== 'PENDING_PAYMENT') {
  fail(`expected PENDING_PAYMENT, found ${String(reserved?.status)}`)
}

// --- 7. Payment, settled through the REAL webhook path ------------------
step('mock payment settled through the real webhook handler')
const initiated = await initiatePayment(seekerId, ctx, {
  appointmentPublicId: reservation.publicId,
  provider: 'MOCK',
})
const attempt = (
  await db
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.publicId, initiated.attemptPublicId))
    .limit(1)
).at(0)
if (!attempt) fail('payment attempt not found')

const webhook = buildMockWebhook({
  id: `evt-${attempt.publicId}`,
  type: 'payment.succeeded',
  reference: attempt.providerReference ?? attempt.idempotencyKey,
  amountMinor: PRICE_MINOR,
  currency: CURRENCY,
  paidAtMs: Date.now(),
})
const webhookResult = await processProviderWebhook(
  'MOCK',
  webhook.rawBody,
  webhook.headers,
)
console.log(`  webhook -> HTTP ${webhookResult.httpStatus}`)
if (webhookResult.httpStatus !== 200) fail('webhook was not accepted')

const confirmed = (
  await db
    .select()
    .from(appointments)
    .where(eq(appointments.id, reservation.appointmentId))
    .limit(1)
).at(0)
if (confirmed?.status !== 'CONFIRMED') {
  fail(
    `appointment did not reach CONFIRMED (found ${String(confirmed?.status)})`,
  )
}
console.log('  appointment CONFIRMED by settlement, not by hand')

// --- 8. The autonomous pipeline, exactly as the worker runs it ----------
step('drive the pipeline through the normal worker entry point')
let job = (
  await db
    .select()
    .from(prayerGenerationJobs)
    .where(eq(prayerGenerationJobs.appointmentId, reservation.appointmentId))
    .limit(1)
).at(0)
if (!job) fail('confirmation did not enqueue a generation job')
const jobId = job.id
console.log(`  generation job ${jobId} status ${job.status}`)

for (let pass = 1; pass <= 240; pass += 1) {
  await runGenerationPipelinePass(`${runId}-p${pass}`, systemGenerationClock)
  job = (
    await db
      .select()
      .from(prayerGenerationJobs)
      .where(eq(prayerGenerationJobs.id, jobId))
      .limit(1)
  ).at(0)
  if (!job) fail('generation job vanished')
  if (pass % 10 === 0 || job.status === 'READY' || job.status === 'FAILED') {
    console.log(`  pass ${pass}: ${job.status}`)
  }
  if (job.status === 'READY' || job.status === 'FAILED') break
  await new Promise((resolve) => setTimeout(resolve, 1000))
}
if (job.status !== 'READY') {
  fail(
    `generation ended at ${job.status}, not READY (${job.lastErrorCode ?? 'no code'})`,
  )
}

// --- 9. Prove what was actually produced --------------------------------
step('verify identities, hashes and the artifact')
const audioTasks = await db
  .select()
  .from(prayerGenerationAudioTasks)
  .where(eq(prayerGenerationAudioTasks.generationJobId, jobId))
const visualTasks = await db
  .select()
  .from(prayerGenerationVisualTasks)
  .where(eq(prayerGenerationVisualTasks.generationJobId, jobId))
const renderResult = (
  await db
    .select()
    .from(prayerGenerationRenderResults)
    .where(eq(prayerGenerationRenderResults.generationJobId, jobId))
    .limit(1)
).at(0)
const upload = (
  await db
    .select()
    .from(prayerGenerationUploads)
    .where(eq(prayerGenerationUploads.generationJobId, jobId))
    .limit(1)
).at(0)
if (!renderResult) fail('no render result')
if (!upload) fail('no upload row')

// The object as it actually exists in private storage, fetched back and
// hashed HERE — never trusted from the row that claims it.
const storage = getObjectStorage()
const fetched = await storage.getPrivateObject(upload.objectKey)
if (!fetched) fail('the uploaded object could not be read back')
const remoteSha = createHash('sha256').update(fetched).digest('hex')

// And once more the way a person receives it: a signed, time-limited URL.
const signed = await storage.createSignedReadUrl({
  objectKey: upload.objectKey,
  ttlSeconds: 120,
  now: new Date(),
})
const signedResponse = await fetch(signed.url)
const signedBytes = new Uint8Array(await signedResponse.arrayBuffer())
const signedSha = createHash('sha256').update(signedBytes).digest('hex')

const recipe = (
  await db
    .select()
    .from(prayerGenerationRecipeSnapshots)
    .where(eq(prayerGenerationRecipeSnapshots.generationJobId, jobId))
    .limit(1)
).at(0)
const recipePayload = recipe
  ? (JSON.parse(recipe.recipeJsonText) as {
      segments?: Array<{ contentVersionId?: number }>
    })
  : null
const usedContentVersionIds = (recipePayload?.segments ?? [])
  .map((segment) => segment.contentVersionId)
  .filter((value): value is number => typeof value === 'number')

const expectedV3 = V3_LAUNCH_CONTENT.filter(
  (entry) => entry.houseCode === HOUSE_CODE && entry.language === LANGUAGE,
).map((entry) => entry.versionId)

const bindings = await db
  .select({
    role: visualBibleReferenceMedia.role,
    mediaAssetVersionId: visualBibleReferenceMedia.mediaAssetVersionId,
    sha256: visualBibleReferenceMedia.mediaFileSha256,
  })
  .from(visualBibleReferenceMedia)
  .where(eq(visualBibleReferenceMedia.visualBibleVersionId, VISUAL_BIBLE_VERSION))

const problems: Array<string> = []
if (audioTasks.length !== 0) {
  problems.push(`${audioTasks.length} audio task(s) — expected zero`)
}
if (visualTasks.length !== 0) {
  problems.push(`${visualTasks.length} visual generation task(s) — expected zero`)
}
if (renderResult.artifactSha256 !== remoteSha) {
  problems.push('remote object hash differs from the render result')
}
if (upload.artifactSha256 !== remoteSha) {
  problems.push('upload row hash differs from the remote object')
}
if (signedSha !== remoteSha) {
  problems.push('signed retrieval returned different bytes')
}
if (signedResponse.status !== 200) {
  problems.push(`signed retrieval returned HTTP ${signedResponse.status}`)
}
if ((renderResult.artifactDurationMs ?? 0) <= 0) {
  problems.push('render duration not measured')
}
if (renderResult.rendererIsMock !== 0) {
  problems.push('a MOCK renderer produced this')
}
if (bindings.length !== 6) problems.push(`${bindings.length} bindings — expected 6`)
const sortedUsed = [...usedContentVersionIds].sort((a, b) => a - b)
const sortedExpected = [...expectedV3].sort((a, b) => a - b)
if (JSON.stringify(sortedUsed) !== JSON.stringify(sortedExpected)) {
  problems.push('content versions used do not match the expected V3 English set')
}

report.result = {
  house: { code: HOUSE_CODE, id: house.id },
  service: {
    code: SERVICE_CODE,
    id: service.id,
    priceMinor: PRICE_MINOR,
    currency: CURRENCY,
    durationMinutes: DURATION_MINUTES,
  },
  templateVersionId: TEMPLATE_VERSION,
  visualBibleVersionId: VISUAL_BIBLE_VERSION,
  language: LANGUAGE,
  appointment: {
    id: reservation.appointmentId,
    publicId: reservation.publicId,
    status: confirmed.status,
    startsAtUtc: reservation.startsAtUtc,
  },
  payment: {
    attemptPublicId: initiated.attemptPublicId,
    provider: 'MOCK',
    webhookHttpStatus: webhookResult.httpStatus,
  },
  generationJob: { id: jobId, status: job.status },
  tasks: { audio: audioTasks.length, visualGeneration: visualTasks.length },
  contentVersionIds: { expected: sortedExpected, used: sortedUsed },
  governedMedia: bindings,
  renderer: {
    code: renderResult.rendererCode,
    version: renderResult.rendererVersion,
    isMock: renderResult.rendererIsMock,
  },
  mp4: {
    mimeType: renderResult.artifactMimeType,
    byteSize: upload.byteSize,
    measuredDurationMs: renderResult.artifactDurationMs,
    sha256: renderResult.artifactSha256,
  },
  objectStorage: {
    key: upload.objectKey,
    rowSha256: upload.artifactSha256,
    refetchedSha256: remoteSha,
    refetchedBytes: fetched.length,
    signedRetrieval: {
      httpStatus: signedResponse.status,
      bytes: signedBytes.length,
      sha256: signedSha,
      timeLimited: signed.url.includes('X-Amz-Expires'),
    },
    matches:
      remoteSha === upload.artifactSha256 &&
      remoteSha === renderResult.artifactSha256 &&
      signedSha === remoteSha,
  },
  problems,
}
report.passed = problems.length === 0
writeReport()

console.log(`\n  runId             ${runId}`)
console.log(`  audio tasks       ${audioTasks.length} (zero = no TTS was ever needed)`)
console.log(`  visual gen tasks  ${visualTasks.length}`)
console.log(
  `  renderer          ${renderResult.rendererCode} ${renderResult.rendererVersion} isMock=${renderResult.rendererIsMock}`,
)
console.log(`  mp4 mime          ${renderResult.artifactMimeType}`)
console.log(`  mp4 bytes         ${upload.byteSize}`)
console.log(`  mp4 duration      ${renderResult.artifactDurationMs} ms`)
console.log(`  mp4 sha256        ${renderResult.artifactSha256}`)
console.log(`  object key        ${upload.objectKey}`)
console.log(`  refetched sha256  ${remoteSha}`)
console.log(`  signed sha256     ${signedSha} (HTTP ${signedResponse.status})`)
console.log(`  content versions  ${JSON.stringify(sortedUsed)}`)
console.log(`\n  report written to ${OUT}`)

if (problems.length > 0) {
  console.error('\nPROBLEMS:')
  for (const problem of problems) console.error(`  - ${problem}`)
  await closeDb()
  process.exit(1)
}
console.log('\nGOVERNED PIPELINE QUALIFICATION PASSED.')
await closeDb()
process.exit(0)
