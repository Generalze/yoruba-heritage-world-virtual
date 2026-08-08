import { and, asc, eq } from 'drizzle-orm'

import { getDb } from '@/db'
import {
  deities,
  deitySacredHouses,
  deityServices,
  sacredHouseFocusAreas,
  sacredHouseMembers,
  sacredHouses,
  services,
} from '@/db/schema'
import { recordAuditEvent } from '@/auth/audit'
import { requirePermission } from '@/auth/guards'
import type { RequestContext } from '@/auth/service'
import type { CatalogueStatus, MemberType } from '@/db/schema'
import type { PermissionCode } from '@/auth/rbac'

/**
 * Admin catalogue mutations (Phase One, Step 3.5).
 *
 * Locked access model — two day-to-day staff types:
 * - CONTENT_MANAGER (<entity>.manage): create, edit DRAFT content,
 *   submit for review, correct and resubmit returned records
 * - ADMIN / SUPER_ADMIN (catalogue.approve + catalogue.publish): review,
 *   return with a required reason, approve, publish, unpublish,
 *   archive, restore
 *
 * The status machine below enforces, independently of any role, that
 * publication is only possible from APPROVED — there is no bypass role.
 * Every mutation is audited (canon §31).
 *
 * This module writes structure and operator-entered text only. It
 * never generates cultural or spiritual content itself, and it never
 * infers deity relationships — staff select them explicitly.
 */

export type WorkflowEvent =
  | 'submit'
  | 'approve'
  | 'reject'
  | 'publish'
  | 'unpublish'
  | 'archive'
  | 'restore'

type WorkflowAuthority = 'manage' | 'approve' | 'publish'

const TRANSITIONS: Record<
  WorkflowEvent,
  {
    from: Array<CatalogueStatus>
    to: CatalogueStatus
    authority: WorkflowAuthority
  }
> = {
  submit: { from: ['DRAFT'], to: 'UNDER_REVIEW', authority: 'manage' },
  approve: { from: ['UNDER_REVIEW'], to: 'APPROVED', authority: 'approve' },
  reject: { from: ['UNDER_REVIEW'], to: 'DRAFT', authority: 'approve' },
  // Publishing is possible ONLY from APPROVED — this is the structural
  // guarantee that approval cannot be bypassed (DRAFT → PUBLISHED and
  // UNDER_REVIEW → PUBLISHED do not exist for any actor).
  publish: { from: ['APPROVED'], to: 'PUBLISHED', authority: 'publish' },
  unpublish: { from: ['PUBLISHED'], to: 'APPROVED', authority: 'publish' },
  archive: {
    from: ['DRAFT', 'UNDER_REVIEW', 'APPROVED', 'PUBLISHED'],
    to: 'ARCHIVED',
    authority: 'publish',
  },
  restore: { from: ['ARCHIVED'], to: 'DRAFT', authority: 'publish' },
}

const EVENT_AUDIT_VERB: Record<WorkflowEvent, string> = {
  submit: 'submitted_for_review',
  approve: 'approved',
  reject: 'returned_to_draft',
  publish: 'published',
  unpublish: 'unpublished',
  archive: 'archived',
  restore: 'restored',
}

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowError'
  }
}

type EntityKind = 'deity' | 'sacred_house' | 'service'

const MANAGE_PERMISSION: Record<EntityKind, PermissionCode> = {
  deity: 'deities.manage',
  sacred_house: 'sacred_houses.manage',
  service: 'services.manage',
}

const VIEW_PERMISSION: Record<EntityKind, PermissionCode> = {
  deity: 'deities.view',
  sacred_house: 'sacred_houses.view',
  service: 'services.view',
}

async function requireAuthority(
  actorId: number,
  kind: EntityKind,
  authority: WorkflowAuthority,
): Promise<void> {
  if (authority === 'manage') {
    await requirePermission(actorId, MANAGE_PERMISSION[kind])
  } else if (authority === 'approve') {
    await requirePermission(actorId, 'catalogue.approve')
  } else {
    await requirePermission(actorId, 'catalogue.publish')
  }
}

function assertTransition(
  event: WorkflowEvent,
  current: CatalogueStatus,
): CatalogueStatus {
  const transition = TRANSITIONS[event]
  if (!transition.from.includes(current)) {
    throw new WorkflowError(
      `Cannot ${event} a record in ${current} status. Allowed from: ${transition.from.join(', ')}.`,
    )
  }
  return transition.to
}

/**
 * Column patch shared by all entities for a workflow event. Approval
 * metadata is set only by approve; cleared when content returns to
 * DRAFT for re-review after archive/restore. Review notes exist only
 * between reject and the next submission.
 */
function workflowPatch(
  event: WorkflowEvent,
  to: CatalogueStatus,
  actorId: number,
  note: string | null,
): {
  status: CatalogueStatus
  approvedBy?: number | null
  approvedAt?: Date | null
  reviewNote?: string | null
} {
  switch (event) {
    case 'submit':
      return { status: to, reviewNote: null }
    case 'approve':
      return { status: to, approvedBy: actorId, approvedAt: new Date() }
    case 'reject':
      return { status: to, reviewNote: note }
    case 'restore':
      return { status: to, approvedBy: null, approvedAt: null }
    default:
      return { status: to }
  }
}

/** UI helper: which events the given permissions allow from a status. */
export function availableEvents(
  status: CatalogueStatus,
  permissions: ReadonlyArray<string>,
  kind: EntityKind,
): Array<WorkflowEvent> {
  const events: Array<WorkflowEvent> = []
  for (const [event, transition] of Object.entries(TRANSITIONS) as Array<
    [WorkflowEvent, (typeof TRANSITIONS)[WorkflowEvent]]
  >) {
    if (!transition.from.includes(status)) continue
    const needed =
      transition.authority === 'manage'
        ? MANAGE_PERMISSION[kind]
        : transition.authority === 'approve'
          ? 'catalogue.approve'
          : 'catalogue.publish'
    if (permissions.includes(needed)) events.push(event)
  }
  return events
}

async function audit(
  actorId: number,
  ctx: RequestContext,
  action: string,
  entityType: EntityKind,
  entityId: number,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await recordAuditEvent({
    actorUserId: actorId,
    action,
    entityType,
    entityId: String(entityId),
    metadata,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

// ---------------------------------------------------------------------------
// Deities
// ---------------------------------------------------------------------------

export interface CreateProfileInput {
  code: string
  name: string
  slug: string
  shortDescription?: string | null
}

export interface UpdateProfileInput {
  name?: string
  slug?: string
  shortDescription?: string | null
  sortOrder?: number
}

export async function listDeitiesAdmin(actorId: number) {
  await requirePermission(actorId, VIEW_PERMISSION.deity)
  return getDb()
    .select()
    .from(deities)
    .orderBy(asc(deities.sortOrder), asc(deities.name))
}

export async function getDeityAdmin(actorId: number, id: number) {
  await requirePermission(actorId, VIEW_PERMISSION.deity)
  return (
    (
      await getDb().select().from(deities).where(eq(deities.id, id)).limit(1)
    ).at(0) ?? null
  )
}

export async function createDeity(
  actorId: number,
  ctx: RequestContext,
  input: CreateProfileInput,
): Promise<number> {
  await requireAuthority(actorId, 'deity', 'manage')
  const result = await getDb()
    .insert(deities)
    .values({
      code: input.code,
      name: input.name,
      slug: input.slug,
      shortDescription: input.shortDescription ?? null,
      // New records ALWAYS start as DRAFT (schema default) — creation
      // never implies approval or publication.
    })
  const id = result[0].insertId
  await audit(actorId, ctx, 'deity.created', 'deity', id, {
    code: input.code,
  })
  return id
}

export async function updateDeity(
  actorId: number,
  ctx: RequestContext,
  id: number,
  input: UpdateProfileInput,
): Promise<void> {
  await requireAuthority(actorId, 'deity', 'manage')
  const row = (
    await getDb().select().from(deities).where(eq(deities.id, id)).limit(1)
  ).at(0)
  if (!row) throw new WorkflowError('Record not found.')

  const contentChanged =
    (input.name !== undefined && input.name !== row.name) ||
    (input.slug !== undefined && input.slug !== row.slug) ||
    (input.shortDescription !== undefined &&
      input.shortDescription !== row.shortDescription)
  const operationalChanged =
    input.sortOrder !== undefined && input.sortOrder !== row.sortOrder

  assertEditable(row.profileStatus, contentChanged)
  // Operational fields on APPROVED/PUBLISHED records are ADMIN-only:
  // a Content Manager can only affect them by returning the record to
  // DRAFT via a substantive edit (which strips the approval).
  if (row.profileStatus === 'PUBLISHED') {
    await requirePermission(actorId, 'catalogue.publish')
  } else if (
    row.profileStatus === 'APPROVED' &&
    !contentChanged &&
    operationalChanged
  ) {
    await requirePermission(actorId, 'catalogue.publish')
  }

  const revertApproval = row.profileStatus === 'APPROVED' && contentChanged
  await getDb()
    .update(deities)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      ...(input.shortDescription !== undefined
        ? { shortDescription: input.shortDescription }
        : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(revertApproval
        ? {
            profileStatus: 'DRAFT' as const,
            approvedBy: null,
            approvedAt: null,
          }
        : {}),
    })
    .where(eq(deities.id, id))

  await audit(actorId, ctx, 'deity.updated', 'deity', id, {
    contentChanged,
    approvalReverted: revertApproval,
    fields: Object.keys(input),
  })
}

export async function deityWorkflow(
  actorId: number,
  ctx: RequestContext,
  id: number,
  event: WorkflowEvent,
  note?: string,
): Promise<void> {
  const row = (
    await getDb().select().from(deities).where(eq(deities.id, id)).limit(1)
  ).at(0)
  if (!row) throw new WorkflowError('Record not found.')

  await requireAuthority(actorId, 'deity', TRANSITIONS[event].authority)
  const to = assertTransition(event, row.profileStatus)
  const cleanNote = requireNoteForReject(event, note)

  const patch = workflowPatch(event, to, actorId, cleanNote)
  await getDb()
    .update(deities)
    .set({
      profileStatus: patch.status,
      ...('approvedBy' in patch ? { approvedBy: patch.approvedBy } : {}),
      ...('approvedAt' in patch ? { approvedAt: patch.approvedAt } : {}),
      ...('reviewNote' in patch ? { reviewNote: patch.reviewNote } : {}),
    })
    .where(eq(deities.id, id))

  await audit(actorId, ctx, `deity.${EVENT_AUDIT_VERB[event]}`, 'deity', id, {
    from: row.profileStatus,
    to,
    ...(cleanNote ? { note: cleanNote } : {}),
  })
}

// ---------------------------------------------------------------------------
// Sacred Houses (+ focus areas, members)
// ---------------------------------------------------------------------------

export async function listSacredHousesAdmin(actorId: number) {
  await requirePermission(actorId, VIEW_PERMISSION.sacred_house)
  return getDb()
    .select()
    .from(sacredHouses)
    .orderBy(asc(sacredHouses.sortOrder), asc(sacredHouses.name))
}

export async function getSacredHouseAdmin(actorId: number, id: number) {
  await requirePermission(actorId, VIEW_PERMISSION.sacred_house)
  const house = (
    await getDb()
      .select()
      .from(sacredHouses)
      .where(eq(sacredHouses.id, id))
      .limit(1)
  ).at(0)
  if (!house) return null
  const focusAreas = await getDb()
    .select()
    .from(sacredHouseFocusAreas)
    .where(eq(sacredHouseFocusAreas.sacredHouseId, id))
    .orderBy(asc(sacredHouseFocusAreas.sortOrder))
  const members = await getDb()
    .select()
    .from(sacredHouseMembers)
    .where(eq(sacredHouseMembers.sacredHouseId, id))
    .orderBy(asc(sacredHouseMembers.sortOrder))
  return { ...house, focusAreas, members }
}

export async function createSacredHouse(
  actorId: number,
  ctx: RequestContext,
  input: CreateProfileInput,
): Promise<number> {
  await requireAuthority(actorId, 'sacred_house', 'manage')
  const result = await getDb()
    .insert(sacredHouses)
    .values({
      code: input.code,
      name: input.name,
      slug: input.slug,
      shortDescription: input.shortDescription ?? null,
    })
  const id = result[0].insertId
  await audit(actorId, ctx, 'sacred_house.created', 'sacred_house', id, {
    code: input.code,
  })
  return id
}

export async function updateSacredHouse(
  actorId: number,
  ctx: RequestContext,
  id: number,
  input: UpdateProfileInput,
): Promise<void> {
  await requireAuthority(actorId, 'sacred_house', 'manage')
  const row = (
    await getDb()
      .select()
      .from(sacredHouses)
      .where(eq(sacredHouses.id, id))
      .limit(1)
  ).at(0)
  if (!row) throw new WorkflowError('Record not found.')

  const contentChanged =
    (input.name !== undefined && input.name !== row.name) ||
    (input.slug !== undefined && input.slug !== row.slug) ||
    (input.shortDescription !== undefined &&
      input.shortDescription !== row.shortDescription)
  const operationalChanged =
    input.sortOrder !== undefined && input.sortOrder !== row.sortOrder

  assertEditable(row.status, contentChanged)
  if (row.status === 'PUBLISHED') {
    await requirePermission(actorId, 'catalogue.publish')
  } else if (
    row.status === 'APPROVED' &&
    !contentChanged &&
    operationalChanged
  ) {
    await requirePermission(actorId, 'catalogue.publish')
  }

  const revertApproval = row.status === 'APPROVED' && contentChanged
  await getDb()
    .update(sacredHouses)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      ...(input.shortDescription !== undefined
        ? { shortDescription: input.shortDescription }
        : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(revertApproval
        ? { status: 'DRAFT' as const, approvedBy: null, approvedAt: null }
        : {}),
    })
    .where(eq(sacredHouses.id, id))

  await audit(actorId, ctx, 'sacred_house.updated', 'sacred_house', id, {
    contentChanged,
    approvalReverted: revertApproval,
    fields: Object.keys(input),
  })
}

export async function sacredHouseWorkflow(
  actorId: number,
  ctx: RequestContext,
  id: number,
  event: WorkflowEvent,
  note?: string,
): Promise<void> {
  const row = (
    await getDb()
      .select()
      .from(sacredHouses)
      .where(eq(sacredHouses.id, id))
      .limit(1)
  ).at(0)
  if (!row) throw new WorkflowError('Record not found.')

  await requireAuthority(actorId, 'sacred_house', TRANSITIONS[event].authority)
  const to = assertTransition(event, row.status)
  const cleanNote = requireNoteForReject(event, note)

  const patch = workflowPatch(event, to, actorId, cleanNote)
  await getDb()
    .update(sacredHouses)
    .set({
      status: patch.status,
      ...('approvedBy' in patch ? { approvedBy: patch.approvedBy } : {}),
      ...('approvedAt' in patch ? { approvedAt: patch.approvedAt } : {}),
      ...('reviewNote' in patch ? { reviewNote: patch.reviewNote } : {}),
    })
    .where(eq(sacredHouses.id, id))

  await audit(
    actorId,
    ctx,
    `sacred_house.${EVENT_AUDIT_VERB[event]}`,
    'sacred_house',
    id,
    { from: row.status, to, ...(cleanNote ? { note: cleanNote } : {}) },
  )
}

/**
 * Focus areas and the public member list are SUBSTANTIVE Sacred House
 * content (spec §12–§13): mutations are blocked while the House is
 * UNDER_REVIEW or PUBLISHED (unpublish first), and modifying them on
 * an APPROVED House invalidates the approval and returns the House to
 * DRAFT. Returns whether that demotion happened, for auditing.
 */
async function guardHouseSubcontent(houseId: number): Promise<boolean> {
  const house = (
    await getDb()
      .select()
      .from(sacredHouses)
      .where(eq(sacredHouses.id, houseId))
      .limit(1)
  ).at(0)
  if (!house) throw new WorkflowError('Sacred House not found.')
  assertEditable(house.status, true)
  if (house.status === 'APPROVED') {
    await getDb()
      .update(sacredHouses)
      .set({ status: 'DRAFT', approvedBy: null, approvedAt: null })
      .where(eq(sacredHouses.id, houseId))
    return true
  }
  return false
}

export async function addFocusArea(
  actorId: number,
  ctx: RequestContext,
  sacredHouseId: number,
  label: string,
): Promise<number> {
  await requireAuthority(actorId, 'sacred_house', 'manage')
  const approvalReverted = await guardHouseSubcontent(sacredHouseId)
  const result = await getDb()
    .insert(sacredHouseFocusAreas)
    .values({ sacredHouseId, label })
  const id = result[0].insertId
  await audit(
    actorId,
    ctx,
    'sacred_house.focus_area.created',
    'sacred_house',
    sacredHouseId,
    { focusAreaId: id, label, approvalReverted },
  )
  return id
}

export async function updateFocusArea(
  actorId: number,
  ctx: RequestContext,
  id: number,
  input: { label?: string; sortOrder?: number; active?: boolean },
): Promise<void> {
  await requireAuthority(actorId, 'sacred_house', 'manage')
  const row = (
    await getDb()
      .select()
      .from(sacredHouseFocusAreas)
      .where(eq(sacredHouseFocusAreas.id, id))
      .limit(1)
  ).at(0)
  if (!row) throw new WorkflowError('Record not found.')
  const approvalReverted = await guardHouseSubcontent(row.sacredHouseId)
  await getDb()
    .update(sacredHouseFocusAreas)
    .set(input)
    .where(eq(sacredHouseFocusAreas.id, id))
  await audit(
    actorId,
    ctx,
    'sacred_house.focus_area.updated',
    'sacred_house',
    row.sacredHouseId,
    { focusAreaId: id, fields: Object.keys(input), approvalReverted },
  )
}

export async function addMember(
  actorId: number,
  ctx: RequestContext,
  sacredHouseId: number,
  input: { displayName: string; memberType: MemberType },
): Promise<number> {
  await requireAuthority(actorId, 'sacred_house', 'manage')
  const approvalReverted = await guardHouseSubcontent(sacredHouseId)
  const result = await getDb().insert(sacredHouseMembers).values({
    sacredHouseId,
    displayName: input.displayName,
    memberType: input.memberType,
  })
  const id = result[0].insertId
  await audit(
    actorId,
    ctx,
    'sacred_house.member.created',
    'sacred_house',
    sacredHouseId,
    { memberId: id, memberType: input.memberType, approvalReverted },
  )
  return id
}

export async function updateMember(
  actorId: number,
  ctx: RequestContext,
  id: number,
  input: {
    displayName?: string
    memberType?: MemberType
    sortOrder?: number
    active?: boolean
  },
): Promise<void> {
  await requireAuthority(actorId, 'sacred_house', 'manage')
  const row = (
    await getDb()
      .select()
      .from(sacredHouseMembers)
      .where(eq(sacredHouseMembers.id, id))
      .limit(1)
  ).at(0)
  if (!row) throw new WorkflowError('Record not found.')
  const approvalReverted = await guardHouseSubcontent(row.sacredHouseId)
  await getDb()
    .update(sacredHouseMembers)
    .set(input)
    .where(eq(sacredHouseMembers.id, id))
  await audit(
    actorId,
    ctx,
    'sacred_house.member.updated',
    'sacred_house',
    row.sacredHouseId,
    { memberId: id, fields: Object.keys(input), approvalReverted },
  )
}

// ---------------------------------------------------------------------------
// Deity relationships (explicitly selected by staff — never inferred)
// ---------------------------------------------------------------------------

/**
 * Deity ↔ Sacred House and deity ↔ service links are substantive deity
 * content (spec §14): blocked while the deity is UNDER_REVIEW or
 * PUBLISHED, and changing them on an APPROVED deity invalidates the
 * deity approval (→ DRAFT).
 */
async function guardDeityRelationships(deityId: number): Promise<boolean> {
  const deity = (
    await getDb().select().from(deities).where(eq(deities.id, deityId)).limit(1)
  ).at(0)
  if (!deity) throw new WorkflowError('Deity profile not found.')
  assertEditable(deity.profileStatus, true)
  if (deity.profileStatus === 'APPROVED') {
    await getDb()
      .update(deities)
      .set({ profileStatus: 'DRAFT', approvedBy: null, approvedAt: null })
      .where(eq(deities.id, deityId))
    return true
  }
  return false
}

export async function setDeityHouseLink(
  actorId: number,
  ctx: RequestContext,
  deityId: number,
  sacredHouseId: number,
  linked: boolean,
): Promise<void> {
  await requireAuthority(actorId, 'deity', 'manage')
  const approvalReverted = await guardDeityRelationships(deityId)
  const house = (
    await getDb()
      .select({ id: sacredHouses.id })
      .from(sacredHouses)
      .where(eq(sacredHouses.id, sacredHouseId))
      .limit(1)
  ).at(0)
  if (!house) throw new WorkflowError('Sacred House not found.')

  if (linked) {
    await getDb()
      .insert(deitySacredHouses)
      .values({ deityId, sacredHouseId })
      .onDuplicateKeyUpdate({ set: { deityId } })
  } else {
    await getDb()
      .delete(deitySacredHouses)
      .where(
        and(
          eq(deitySacredHouses.deityId, deityId),
          eq(deitySacredHouses.sacredHouseId, sacredHouseId),
        ),
      )
  }
  await audit(
    actorId,
    ctx,
    linked ? 'deity.relationship.added' : 'deity.relationship.removed',
    'deity',
    deityId,
    { relationship: 'sacred_house', targetId: sacredHouseId, approvalReverted },
  )
}

export async function setDeityServiceLink(
  actorId: number,
  ctx: RequestContext,
  deityId: number,
  serviceId: number,
  linked: boolean,
): Promise<void> {
  await requireAuthority(actorId, 'deity', 'manage')
  const approvalReverted = await guardDeityRelationships(deityId)
  const service = (
    await getDb()
      .select({ id: services.id })
      .from(services)
      .where(eq(services.id, serviceId))
      .limit(1)
  ).at(0)
  if (!service) throw new WorkflowError('Service not found.')

  if (linked) {
    await getDb()
      .insert(deityServices)
      .values({ deityId, serviceId })
      .onDuplicateKeyUpdate({ set: { deityId } })
  } else {
    await getDb()
      .delete(deityServices)
      .where(
        and(
          eq(deityServices.deityId, deityId),
          eq(deityServices.serviceId, serviceId),
        ),
      )
  }
  await audit(
    actorId,
    ctx,
    linked ? 'deity.relationship.added' : 'deity.relationship.removed',
    'deity',
    deityId,
    { relationship: 'service', targetId: serviceId, approvalReverted },
  )
}

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

export interface CreateServiceInput extends CreateProfileInput {
  sacredHouseId: number
}

export interface UpdateServiceInput extends UpdateProfileInput {
  sacredHouseId?: number
  durationMinutes?: number | null
  priceMinor?: number | null
  currency?: string | null
}

export async function listServicesAdmin(actorId: number) {
  await requirePermission(actorId, VIEW_PERMISSION.service)
  return getDb()
    .select({
      service: services,
      houseName: sacredHouses.name,
    })
    .from(services)
    .innerJoin(sacredHouses, eq(services.sacredHouseId, sacredHouses.id))
    .orderBy(asc(sacredHouses.sortOrder), asc(services.sortOrder))
}

export async function getServiceAdmin(actorId: number, id: number) {
  await requirePermission(actorId, VIEW_PERMISSION.service)
  return (
    (
      await getDb().select().from(services).where(eq(services.id, id)).limit(1)
    ).at(0) ?? null
  )
}

export async function createService(
  actorId: number,
  ctx: RequestContext,
  input: CreateServiceInput,
): Promise<number> {
  await requireAuthority(actorId, 'service', 'manage')
  const house = (
    await getDb()
      .select({ id: sacredHouses.id })
      .from(sacredHouses)
      .where(eq(sacredHouses.id, input.sacredHouseId))
      .limit(1)
  ).at(0)
  if (!house) throw new WorkflowError('Sacred House not found.')

  const result = await getDb()
    .insert(services)
    .values({
      sacredHouseId: input.sacredHouseId,
      code: input.code,
      name: input.name,
      slug: input.slug,
      shortDescription: input.shortDescription ?? null,
      // No price/duration at creation — operational fields are set later
      // by authorised operators; nothing is invented.
    })
  const id = result[0].insertId
  await audit(actorId, ctx, 'service.created', 'service', id, {
    code: input.code,
    sacredHouseId: input.sacredHouseId,
  })
  return id
}

export async function updateService(
  actorId: number,
  ctx: RequestContext,
  id: number,
  input: UpdateServiceInput,
): Promise<void> {
  await requireAuthority(actorId, 'service', 'manage')
  const row = (
    await getDb().select().from(services).where(eq(services.id, id)).limit(1)
  ).at(0)
  if (!row) throw new WorkflowError('Record not found.')

  const contentChanged =
    (input.name !== undefined && input.name !== row.name) ||
    (input.slug !== undefined && input.slug !== row.slug) ||
    (input.shortDescription !== undefined &&
      input.shortDescription !== row.shortDescription)
  const operationalChanged =
    (input.sortOrder !== undefined && input.sortOrder !== row.sortOrder) ||
    (input.durationMinutes !== undefined &&
      input.durationMinutes !== row.durationMinutes) ||
    (input.priceMinor !== undefined && input.priceMinor !== row.priceMinor) ||
    (input.currency !== undefined && input.currency !== row.currency)

  // Reconnecting a service to a different Sacred House is structural
  // and only permitted while the record is a DRAFT.
  if (
    input.sacredHouseId !== undefined &&
    input.sacredHouseId !== row.sacredHouseId
  ) {
    if (row.serviceStatus !== 'DRAFT') {
      throw new WorkflowError(
        'A service can only be connected to a different Sacred House while in DRAFT status.',
      )
    }
    const house = (
      await getDb()
        .select({ id: sacredHouses.id })
        .from(sacredHouses)
        .where(eq(sacredHouses.id, input.sacredHouseId))
        .limit(1)
    ).at(0)
    if (!house) throw new WorkflowError('Sacred House not found.')
  }

  assertEditable(row.serviceStatus, contentChanged)
  if (row.serviceStatus === 'PUBLISHED') {
    await requirePermission(actorId, 'catalogue.publish')
  } else if (
    row.serviceStatus === 'APPROVED' &&
    !contentChanged &&
    operationalChanged
  ) {
    await requirePermission(actorId, 'catalogue.publish')
  }

  const revertApproval = row.serviceStatus === 'APPROVED' && contentChanged
  await getDb()
    .update(services)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      ...(input.shortDescription !== undefined
        ? { shortDescription: input.shortDescription }
        : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.sacredHouseId !== undefined
        ? { sacredHouseId: input.sacredHouseId }
        : {}),
      ...(input.durationMinutes !== undefined
        ? { durationMinutes: input.durationMinutes }
        : {}),
      ...(input.priceMinor !== undefined
        ? { priceMinor: input.priceMinor }
        : {}),
      ...(input.currency !== undefined ? { currency: input.currency } : {}),
      ...(revertApproval
        ? {
            serviceStatus: 'DRAFT' as const,
            approvedBy: null,
            approvedAt: null,
          }
        : {}),
    })
    .where(eq(services.id, id))

  await audit(actorId, ctx, 'service.updated', 'service', id, {
    contentChanged,
    approvalReverted: revertApproval,
    fields: Object.keys(input),
  })
}

export async function serviceWorkflow(
  actorId: number,
  ctx: RequestContext,
  id: number,
  event: WorkflowEvent,
  note?: string,
): Promise<void> {
  const row = (
    await getDb().select().from(services).where(eq(services.id, id)).limit(1)
  ).at(0)
  if (!row) throw new WorkflowError('Record not found.')

  await requireAuthority(actorId, 'service', TRANSITIONS[event].authority)
  const to = assertTransition(event, row.serviceStatus)
  const cleanNote = requireNoteForReject(event, note)

  const patch = workflowPatch(event, to, actorId, cleanNote)
  await getDb()
    .update(services)
    .set({
      serviceStatus: patch.status,
      ...('approvedBy' in patch ? { approvedBy: patch.approvedBy } : {}),
      ...('approvedAt' in patch ? { approvedAt: patch.approvedAt } : {}),
      ...('reviewNote' in patch ? { reviewNote: patch.reviewNote } : {}),
    })
    .where(eq(services.id, id))

  await audit(
    actorId,
    ctx,
    `service.${EVENT_AUDIT_VERB[event]}`,
    'service',
    id,
    { from: row.serviceStatus, to, ...(cleanNote ? { note: cleanNote } : {}) },
  )
}

// ---------------------------------------------------------------------------
// Shared edit rules
// ---------------------------------------------------------------------------

/**
 * Editing rules:
 * - ARCHIVED: no edits (restore first)
 * - UNDER_REVIEW: no edits (withdraw or await review — content under
 *   review must be exactly what the reviewer sees)
 * - PUBLISHED: operational fields only; content edits require
 *   unpublishing first
 * - APPROVED: content edits allowed but revert the record to DRAFT and
 *   clear the approval trail (changed content must be re-approved)
 */
function assertEditable(
  status: CatalogueStatus,
  contentChanged: boolean,
): void {
  if (status === 'ARCHIVED') {
    throw new WorkflowError('Archived records cannot be edited. Restore first.')
  }
  if (status === 'UNDER_REVIEW') {
    throw new WorkflowError(
      'Records under review cannot be edited. Withdraw the submission first.',
    )
  }
  if (status === 'PUBLISHED' && contentChanged) {
    throw new WorkflowError(
      'Published content cannot be edited directly. Unpublish first so changes go through review.',
    )
  }
}

function requireNoteForReject(
  event: WorkflowEvent,
  note: string | undefined,
): string | null {
  if (event !== 'reject') return null
  const clean = note?.trim()
  if (!clean) {
    throw new WorkflowError(
      'Returning a submission requires a review note explaining the reason.',
    )
  }
  return clean.slice(0, 500)
}
