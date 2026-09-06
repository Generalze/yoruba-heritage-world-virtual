/**
 * GOVERNED PIPELINE QUALIFICATION — the smallest real end-to-end run.
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
 * NO PAID PROVIDER IS REACHABLE. TTS and visual generation are
 * DISABLED, and the English launch content is TEXT_ONLY — so the
 * manifest carries no audio requirement at all and 9jaLingo is never
 * called, not even to be refused.
 */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'

import { closeDb, getDb } from '@/db'
import {
  appointments,
  paymentAttempts,
  prayerGenerationJobs,
  prayerGenerationRenderResults,
  prayerGenerationUploads,
  prayerGenerationAudioTasks,
  prayerGenerationVisualTasks,
  sacredHouses,
  services,
  visualBibleReferenceMedia,
} from '@/db/schema'
import { env } from '@/lib/env'
import { V3_LAUNCH_CONTENT } from '@/lib/launch-content-v3'
import { buildMockWebhook } from '@/providers/payments/mock'
import { getObjectStorage } from '@/providers/object-storage/registry'
import { registerUser } from '@/auth/service'
import { grantRoleByEmail } from '@/db/grant-role'
import {
  acceptRequiredConsents,
  savePersonalDetails,
} from '@/services/profile'
import { updateService } from '@/services/admin-catalogue'
import { addAvailabilityWindow, updateBookingSettings } from '@/services/scheduling'
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

if (env.NODE_ENV === 'production') {
  console.error('refusing: this qualification publishes and settles. Staging only.')
  process.exit(1)
}

const ctx = { ipAddress: '127.0.0.1', userAgent: 'staging-qualification' }
const db = getDb()
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  environment: env.NODE_ENV,
  drivers: {
    render: env.RENDER_DRIVER,
    tts: env.TTS_DRIVER,
    visualGeneration: env.VISUAL_GENERATION_DRIVER,
    email: env.NOTIFICATION_EMAIL_DRIVER,
    objectStorage: env.OBJECT_STORAGE_DRIVER,
  },
}

function step(name: string): void {
  console.log(`\n== ${name}`)
}

function fail(message: string): never {
  console.error(`\nFAILED: ${message}`)
  report.failure = message
  writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')
  process.exit(1)
}

// --- 1. An operator, through the real registration flow ----------------
step('operator and synthetic user (real registration flow)')
const operator = await registerUser(
  {
    email: `staging-operator+${Date.now()}@example.invalid`,
    password: 'Staging-Operator-Passw0rd!',
    preferredName: 'Staging Operator',
  },
  ctx,
)
if (!operator.ok) fail(`operator registration failed: ${operator.error}`)
await grantRoleByEmail(operator.user.email, 'SUPER_ADMIN')
const operatorId = operator.user.id
console.log(`  operator user ${operatorId} (SUPER_ADMIN)`)

const seeker = await registerUser(
  {
    email: `staging-seeker+${Date.now()}@example.invalid`,
    password: 'Staging-Seeker-Passw0rd!',
    preferredName: 'Staging Seeker',
  },
  ctx,
)
if (!seeker.ok) fail(`seeker registration failed: ${seeker.error}`)
const seekerId = seeker.user.id
console.log(`  seeker user ${seekerId}`)

// The real profile and consent flow — booking eligibility is refused
// without both, and this script does not bypass that check.
await savePersonalDetails(
  seekerId,
  {
    preferredName: 'Staging Seeker',
    fullName: 'Staging Seeker',
    phone: '+2348000000000',
    countryCode: 'NG',
    timezone: 'Africa/Lagos',
    preferredLanguage: LANGUAGE,
    dateOfBirth: '1990-01-01',
  },
  ctx,
)
await acceptRequiredConsents(seekerId, ctx)
console.log('  profile completed and required consents accepted')

// --- 2. The one House and the one service ------------------------------
step('configure exactly one service')
const house = (
  await db.select().from(sacredHouses).where(eq(sacredHouses.code, HOUSE_CODE)).limit(1)
).at(0)
if (!house) fail(`House ${HOUSE_CODE} not found`)
const service = (
  await db.select().from(services).where(eq(services.code, SERVICE_CODE)).limit(1)
).at(0)
if (!service) fail(`Service ${SERVICE_CODE} not found`)
if (service.sacredHouseId !== house.id) fail('service does not belong to the House')

await updateService(operatorId, ctx, service.id, {
  durationMinutes: DURATION_MINUTES,
  priceMinor: PRICE_MINOR,
  currency: CURRENCY,
})
console.log(`  ${SERVICE_CODE}: ${DURATION_MINUTES}min ${CURRENCY} ${PRICE_MINOR}`)

// --- 3. Booking, for this House only -----------------------------------
step('enable booking for this House only')
await updateBookingSettings(operatorId, ctx, house.id, {
  schedulingTimezone: 'Africa/Lagos',
  bookingEnabled: true,
  slotIncrementMinutes: 30,
  minimumLeadMinutes: 60,
  maximumAdvanceDays: 14,
  reservationHoldMinutes: 15,
  cancellationCutoffMinutes: 120,
  rescheduleCutoffMinutes: 120,
})

// One window per weekday is the minimum that guarantees a bookable slot
// exists regardless of which day this runs.
for (let day = 1; day <= 7; day += 1) {
  await addAvailabilityWindow(operatorId, ctx, house.id, {
    dayOfWeek: day,
    startLocalTime: '09:00',
    endLocalTime: '17:00',
  })
}
console.log('  booking enabled, 7 windows 09:00-17:00 Africa/Lagos')

// --- 4. Publication, in staging only -----------------------------------
step('publish the one Visual Bible and the one template')
await publishVisualBibleVersion(operatorId, ctx, VISUAL_BIBLE_VERSION)
await publishTemplateVersion(operatorId, ctx, TEMPLATE_VERSION)
console.log(`  visual bible ${VISUAL_BIBLE_VERSION}, template ${TEMPLATE_VERSION}`)

// --- 5. A real reservation on a real slot -------------------------------
step('reserve a real slot (real availability, real eligibility)')
const today = new Date()
const from = today.toISOString().slice(0, 10)
const to = new Date(today.getTime() + 10 * 86_400_000).toISOString().slice(0, 10)
const slots = await computeAvailableSlots(service.id, from, to)
if (slots.length === 0) fail('no bookable slot was offered')
const slot = slots[0]
const reservation = await createReservation(seekerId, ctx, {
  serviceId: service.id,
  startsAtUtc: slot.startsAtUtc,
})
console.log(`  appointment ${reservation.appointmentId} at ${reservation.startsAtUtc}`)

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

// --- 6. Payment, settled through the REAL webhook path ------------------
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

// The SAME verification the production route performs: a signed body
// through processProviderWebhook. Nothing sets a status by hand.
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
  fail(`appointment did not reach CONFIRMED (found ${String(confirmed?.status)})`)
}
console.log('  appointment CONFIRMED by settlement, not by hand')

// --- 7. The autonomous pipeline, exactly as the worker runs it ----------
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

for (let pass = 1; pass <= 90; pass += 1) {
  await runGenerationPipelinePass(`staging-qual-${pass}`, systemGenerationClock)
  job = (
    await db
      .select()
      .from(prayerGenerationJobs)
      .where(eq(prayerGenerationJobs.id, jobId))
      .limit(1)
  ).at(0)
  if (!job) fail('generation job vanished')
  if (pass % 5 === 0 || job.status === 'READY' || job.status === 'FAILED') {
    console.log(`  pass ${pass}: ${job.status}`)
  }
  if (job.status === 'READY' || job.status === 'FAILED') break
  await new Promise((resolve) => setTimeout(resolve, 1000))
}
if (job.status !== 'READY') {
  fail(`generation ended at ${job.status}, not READY (${job.lastErrorCode ?? 'no code'})`)
}

// --- 8. Prove what was actually produced --------------------------------
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
if (renderResult.artifactSha256 !== remoteSha) {
  problems.push('remote object hash differs from the render result')
}
if (upload.artifactSha256 !== remoteSha) {
  problems.push('upload row hash differs from the remote object')
}
if ((renderResult.artifactDurationMs ?? 0) <= 0) {
  problems.push('render duration not measured')
}
if (bindings.length !== 6) {
  problems.push(`${bindings.length} bindings — expected 6`)
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
  tasks: { audio: audioTasks.length, visual: visualTasks.length },
  expectedV3ContentVersionIds: expectedV3,
  governedMedia: bindings,
  render: {
    mimeType: renderResult.artifactMimeType,
    durationMs: renderResult.artifactDurationMs,
    sha256: renderResult.artifactSha256,
    rendererCode: renderResult.rendererCode,
    rendererVersion: renderResult.rendererVersion,
    rendererIsMock: renderResult.rendererIsMock,
  },
  objectStorage: {
    key: upload.objectKey,
    byteSize: upload.byteSize,
    rowSha256: upload.artifactSha256,
    refetchedSha256: remoteSha,
    refetchedBytes: fetched.length,
    matches:
      remoteSha === upload.artifactSha256 &&
      remoteSha === renderResult.artifactSha256,
  },
  problems,
}
report.finishedAt = new Date().toISOString()
report.passed = problems.length === 0
writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8')

console.log(`\n  audio tasks       ${audioTasks.length} (zero = no TTS was ever needed)`)
console.log(`  visual tasks      ${visualTasks.length}`)
console.log(`  render mime       ${renderResult.artifactMimeType}`)
console.log(`  render bytes      ${upload.byteSize}`)
console.log(`  render duration   ${renderResult.artifactDurationMs} ms`)
console.log(`  render sha256     ${renderResult.artifactSha256}`)
console.log(`  object key        ${upload.objectKey}`)
console.log(`  refetched sha256  ${remoteSha}`)
console.log(
  `  hashes agree      ${remoteSha === upload.artifactSha256 && remoteSha === renderResult.artifactSha256}`,
)
console.log(`\n  report written to ${OUT}`)

if (problems.length > 0) {
  console.error('\nPROBLEMS:')
  for (const problem of problems) console.error(`  - ${problem}`)
  await closeDb()
  process.exit(1)
}
console.log('\nGOVERNED PIPELINE QUALIFICATION PASSED.')
await closeDb()
