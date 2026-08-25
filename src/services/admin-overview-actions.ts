import { createServerFn } from '@tanstack/react-start'
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm'

import { getDb } from '@/db'
import {
  appointments,
  deities,
  mediaAssetVersions,
  prayerGenerationJobs,
  prayerSessionTemplateVersions,
  sacredHouses,
  services,
  spiritualContentItems,
  spiritualContentVersions,
  visualBibleVersions,
} from '@/db/schema'
import { ForbiddenError, getAuthenticatedUser } from '@/auth/guards'
import { getUserPermissionCodes } from '@/auth/rbac'
import { utcMsToSql } from '@/lib/schedule-time'
import type { GenerationJobStatus } from '@/db/schema'

/**
 * Admin landing overview (Step 21A.7): status summaries for operators.
 *
 * Every count is computed server-side against the same tables the
 * existing admin surfaces use. Payloads are intentionally operational:
 * counts, statuses, public ids, timestamps and bounded machine error
 * codes only. No private request notes, payment details, sacred bodies,
 * media storage keys or provider payloads leave this contract.
 */

class UnauthenticatedError extends Error {
  constructor() {
    super('Authentication required')
    this.name = 'UnauthenticatedError'
  }
}

const STAFF_RELEVANT_PREFIXES = [
  'deities.',
  'sacred_houses.',
  'services.',
  'catalogue.',
  'spiritual_content.',
  'media.',
] as const

function hasAnyPermission(
  permissions: ReadonlyArray<string>,
  required: ReadonlyArray<string>,
): boolean {
  return required.some((permission) => permissions.includes(permission))
}

function hasAdminContext(permissions: ReadonlyArray<string>): boolean {
  return (
    permissions.includes('admin.access') ||
    permissions.includes('appointments.view') ||
    permissions.includes('payments.view') ||
    permissions.includes('availability.manage') ||
    permissions.some((permission) =>
      STAFF_RELEVANT_PREFIXES.some((prefix) => permission.startsWith(prefix)),
    )
  )
}

function asCount(value: unknown): number {
  return Number(value ?? 0)
}

async function countCatalogueReviewQueue(): Promise<number> {
  const db = getDb()
  const [deityRows, houseRows, serviceRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(deities)
      .where(eq(deities.profileStatus, 'UNDER_REVIEW')),
    db
      .select({ count: sql<number>`count(*)` })
      .from(sacredHouses)
      .where(eq(sacredHouses.status, 'UNDER_REVIEW')),
    db
      .select({ count: sql<number>`count(*)` })
      .from(services)
      .where(eq(services.serviceStatus, 'UNDER_REVIEW')),
  ])
  return (
    asCount(deityRows[0]?.count) +
    asCount(houseRows[0]?.count) +
    asCount(serviceRows[0]?.count)
  )
}

async function countSpiritualReviewQueue(
  domain: 'GUIDANCE' | 'SACRED_RUNTIME',
): Promise<number> {
  const rows = await getDb()
    .select({ count: sql<number>`count(*)` })
    .from(spiritualContentVersions)
    .innerJoin(
      spiritualContentItems,
      eq(spiritualContentVersions.contentItemId, spiritualContentItems.id),
    )
    .where(
      and(
        eq(spiritualContentVersions.status, 'UNDER_REVIEW'),
        eq(spiritualContentItems.contentDomain, domain),
      ),
    )
  return asCount(rows[0]?.count)
}

async function countSimpleReviewQueue(
  table:
    | typeof prayerSessionTemplateVersions
    | typeof mediaAssetVersions
    | typeof visualBibleVersions,
): Promise<number> {
  const rows = await getDb()
    .select({ count: sql<number>`count(*)` })
    .from(table)
    .where(eq(table.status, 'UNDER_REVIEW'))
  return asCount(rows[0]?.count)
}

export interface AdminOverview {
  reviewQueues: Array<{
    label: string
    count: number
    to: string
  }>
  generation:
    | {
        total: number
        failed: number
        active: number
        ready: number
        statusCounts: Array<{ status: GenerationJobStatus; count: number }>
        recentFailures: Array<{
          publicId: string
          serviceName: string
          houseName: string
          lastErrorCode: string | null
          updatedAt: Date
        }>
      }
    | null
  upcomingAppointments:
    | {
        count: number
        next: Array<{
          publicId: string
          startsAtUtc: string
          serviceName: string
          houseName: string
        }>
      }
    | null
}

async function getReviewQueues(
  permissions: ReadonlyArray<string>,
): Promise<AdminOverview['reviewQueues']> {
  const queues: AdminOverview['reviewQueues'] = []

  if (permissions.includes('catalogue.approve')) {
    queues.push({
      label: 'Catalogue',
      count: await countCatalogueReviewQueue(),
      to: '/admin/catalogue/review',
    })
  }
  if (permissions.includes('spiritual_content.approve')) {
    const [guidance, sacred, templates] = await Promise.all([
      countSpiritualReviewQueue('GUIDANCE'),
      countSpiritualReviewQueue('SACRED_RUNTIME'),
      countSimpleReviewQueue(prayerSessionTemplateVersions),
    ])
    queues.push(
      {
        label: 'Guidance',
        count: guidance,
        to: '/admin/spiritual-content/review',
      },
      {
        label: 'Sacred content',
        count: sacred,
        to: '/admin/sacred-content/review',
      },
      {
        label: 'Prayer templates',
        count: templates,
        to: '/admin/prayer-templates/review',
      },
    )
  }
  if (permissions.includes('media.approve')) {
    const [media, visualBibles] = await Promise.all([
      countSimpleReviewQueue(mediaAssetVersions),
      countSimpleReviewQueue(visualBibleVersions),
    ])
    queues.push(
      { label: 'Media', count: media, to: '/admin/media-assets' },
      {
        label: 'Visual Bibles',
        count: visualBibles,
        to: '/admin/visual-bibles',
      },
    )
  }

  return queues
}

async function getGenerationOverview(): Promise<
  NonNullable<AdminOverview['generation']>
> {
  const db = getDb()
  const statusCounts = await db
    .select({
      status: prayerGenerationJobs.status,
      count: sql<number>`count(*)`,
    })
    .from(prayerGenerationJobs)
    .groupBy(prayerGenerationJobs.status)

  const counts = statusCounts.map((row) => ({
    status: row.status,
    count: asCount(row.count),
  }))
  const total = counts.reduce((sum, row) => sum + row.count, 0)
  const failed = counts.find((row) => row.status === 'FAILED')?.count ?? 0
  const ready = counts.find((row) => row.status === 'READY')?.count ?? 0
  const active = counts
    .filter((row) => !['READY', 'FAILED', 'CANCELLED'].includes(row.status))
    .reduce((sum, row) => sum + row.count, 0)

  const recentFailures = await db
    .select({
      publicId: prayerGenerationJobs.publicId,
      serviceName: appointments.serviceNameSnapshot,
      houseName: appointments.houseNameSnapshot,
      lastErrorCode: prayerGenerationJobs.lastErrorCode,
      updatedAt: prayerGenerationJobs.updatedAt,
    })
    .from(prayerGenerationJobs)
    .innerJoin(
      appointments,
      eq(prayerGenerationJobs.appointmentId, appointments.id),
    )
    .where(eq(prayerGenerationJobs.status, 'FAILED'))
    .orderBy(desc(prayerGenerationJobs.updatedAt))
    .limit(5)

  return { total, failed, active, ready, statusCounts: counts, recentFailures }
}

async function getUpcomingAppointments(): Promise<
  NonNullable<AdminOverview['upcomingAppointments']>
> {
  const nowSql = utcMsToSql(Date.now())
  const countRows = await getDb()
    .select({ count: sql<number>`count(*)` })
    .from(appointments)
    .where(
      and(
        eq(appointments.status, 'CONFIRMED'),
        gte(appointments.startsAtUtc, nowSql),
      ),
    )
  const next = await getDb()
    .select({
      publicId: appointments.publicId,
      startsAtUtc: appointments.startsAtUtc,
      serviceName: appointments.serviceNameSnapshot,
      houseName: appointments.houseNameSnapshot,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.status, 'CONFIRMED'),
        gte(appointments.startsAtUtc, nowSql),
      ),
    )
    .orderBy(asc(appointments.startsAtUtc))
    .limit(5)

  return { count: asCount(countRows[0]?.count), next }
}

export const getAdminOverviewFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AdminOverview> => {
    const actor = await getAuthenticatedUser()
    if (!actor) throw new UnauthenticatedError()

    const permissions = await getUserPermissionCodes(actor.id)
    if (!hasAdminContext(permissions)) throw new ForbiddenError()

    const canViewAppointments = permissions.includes('appointments.view')
    const canSeeReviewQueues = hasAnyPermission(permissions, [
      'catalogue.approve',
      'spiritual_content.approve',
      'media.approve',
    ])

    const [reviewQueues, generation, upcomingAppointments] = await Promise.all([
      canSeeReviewQueues ? getReviewQueues(permissions) : [],
      canViewAppointments ? getGenerationOverview() : null,
      canViewAppointments ? getUpcomingAppointments() : null,
    ])

    return { reviewQueues, generation, upcomingAppointments }
  },
)
