import {
  bigint,
  boolean,
  foreignKey,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import { sacredHouses, services } from './catalogue'
import {
  CONTENT_SCOPE_TYPES,
  CONTENT_VERSION_STATUSES,
  GUIDANCE_LANGUAGES,
  VARIANT_KINDS,
  spiritualContentItems,
  spiritualContentVersions,
} from './guidance'
import { SHOT_ROLES } from './shot-roles'
import type { ShotRole } from './shot-roles'
import { users } from './users'

/**
 * Approved prayer session templates & selection rules (Phase One,
 * Step 9; canon §10.2).
 *
 * Human leadership approves — ONCE, upstream — the session structure
 * (ordered slots), the allowed sacred content (pinned versions or
 * eligibility filters), forbidden combinations and duration/language
 * boundaries. The autonomous resolver then executes those approved
 * rules per appointment context with NO per-appointment human
 * approval. Templates never contain sacred text themselves — every
 * selected block must independently pass the Step 8 runtime
 * eligibility authority at selection time.
 *
 * The authoritative definition is fully NORMALIZED (versions + slots +
 * scope/pin/pair child tables) — no JSON blob. definition_sha256 is a
 * transactionally computed digest of the canonical representation so
 * later recipe systems can prove which approved definition they used.
 */

export const SLOT_KINDS = ['CONTENT', 'SILENCE'] as const
export type SlotKind = (typeof SLOT_KINDS)[number]

/**
 * The human-authored camera decision for a CONTENT slot (Step 24).
 *
 * Names match VISUAL_BIBLE_REFERENCE_ROLES one-for-one: a slot's shot
 * family selects which approved reference the Visual Bible must supply
 * if that slot ever reaches generation.
 *
 * AUTHORED, NEVER INFERRED. The recipe's visualMode is derived at
 * runtime from whichever media happens to be eligible, so it must not
 * decide whether an approved template carries shot authority — a media
 * withdrawal could otherwise turn an already-approved CONTENT slot into
 * generation with no approved camera or reference decision behind it.
 * CONTENT slots therefore carry these fields even when a given recipe
 * resolves them to LINKED_REFERENCE or LIBRARY_MEDIA, where they stay
 * dormant.
 */
export const SLOT_SHOT_FAMILIES = SHOT_ROLES
export type SlotShotFamily = ShotRole

/** Whether generation for this slot may proceed without an approved
 * reference. REQUIRED fails closed; OPTIONAL is an explicit human
 * allowance and is never a default or an inference. */
export const SLOT_REFERENCE_REQUIREMENTS = ['REQUIRED', 'OPTIONAL'] as const
export type SlotReferenceRequirement =
  (typeof SLOT_REFERENCE_REQUIREMENTS)[number]

export const SLOT_SELECTOR_MODES = [
  'PINNED_VERSIONS',
  'ELIGIBLE_FILTER',
] as const
export type SlotSelectorMode = (typeof SLOT_SELECTOR_MODES)[number]

export const prayerSessionTemplates = mysqlTable(
  'prayer_session_templates',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    publicId: varchar('public_id', { length: 36 }).notNull(),
    code: varchar('code', { length: 60 }).notNull(),
    scopeType: mysqlEnum('scope_type', CONTENT_SCOPE_TYPES).notNull(),
    sacredHouseId: int('sacred_house_id', { unsigned: true }),
    serviceId: int('service_id', { unsigned: true }),
    active: boolean('active').notNull().default(true),
    createdBy: bigint('created_by', { mode: 'number', unsigned: true }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    uniqueIndex('pst_public_id_unique').on(table.publicId),
    uniqueIndex('pst_code_unique').on(table.code),
    index('pst_scope_idx').on(table.scopeType),
    index('pst_house_idx').on(table.sacredHouseId),
    index('pst_service_idx').on(table.serviceId),
    index('pst_active_idx').on(table.active),
    foreignKey({
      columns: [table.sacredHouseId],
      foreignColumns: [sacredHouses.id],
      name: 'pst_house_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [services.id],
      name: 'pst_service_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'pst_created_by_fk',
    }).onDelete('set null'),
  ],
)

export const prayerSessionTemplateVersions = mysqlTable(
  'prayer_session_template_versions',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    templateId: int('template_id', { unsigned: true }).notNull(),
    language: mysqlEnum('language', GUIDANCE_LANGUAGES).notNull(),
    versionNumber: int('version_number', { unsigned: true }).notNull(),
    status: mysqlEnum('status', CONTENT_VERSION_STATUSES)
      .notNull()
      .default('DRAFT'),
    priority: int('priority').notNull().default(0),
    selectionWeight: int('selection_weight', { unsigned: true })
      .notNull()
      .default(1),
    targetMinSeconds: int('target_min_seconds', { unsigned: true }).notNull(),
    targetMaxSeconds: int('target_max_seconds', { unsigned: true }).notNull(),
    definitionSha256: varchar('definition_sha256', { length: 64 }),
    createdBy: bigint('created_by', { mode: 'number', unsigned: true }),
    submittedAt: timestamp('submitted_at'),
    reviewNote: varchar('review_note', { length: 500 }),
    approvedBy: bigint('approved_by', { mode: 'number', unsigned: true }),
    approvedAt: timestamp('approved_at'),
    publishedBy: bigint('published_by', { mode: 'number', unsigned: true }),
    publishedAt: timestamp('published_at'),
    archivedAt: timestamp('archived_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    uniqueIndex('pstv_tpl_lang_ver_unique').on(
      table.templateId,
      table.language,
      table.versionNumber,
    ),
    index('pstv_tpl_lang_status_idx').on(
      table.templateId,
      table.language,
      table.status,
    ),
    foreignKey({
      columns: [table.templateId],
      foreignColumns: [prayerSessionTemplates.id],
      name: 'pstv_template_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'pstv_created_by_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.approvedBy],
      foreignColumns: [users.id],
      name: 'pstv_approved_by_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.publishedBy],
      foreignColumns: [users.id],
      name: 'pstv_published_by_fk',
    }).onDelete('set null'),
  ],
)

export const prayerSessionTemplateSlots = mysqlTable(
  'prayer_session_template_slots',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    templateVersionId: bigint('template_version_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    slotKey: varchar('slot_key', { length: 60 }).notNull(),
    position: int('position', { unsigned: true }).notNull(),
    slotKind: mysqlEnum('slot_kind', SLOT_KINDS).notNull(),
    minSelect: int('min_select', { unsigned: true }).notNull().default(1),
    maxSelect: int('max_select', { unsigned: true }).notNull().default(1),
    contentType: varchar('content_type', { length: 40 }),
    selectorMode: mysqlEnum('selector_mode', SLOT_SELECTOR_MODES),
    themeCode: varchar('theme_code', { length: 60 }),
    variantKind: mysqlEnum('variant_kind', VARIANT_KINDS),
    silenceDurationSeconds: int('silence_duration_seconds', {
      unsigned: true,
    }),
    /** CONTENT slots: required. SILENCE slots: MUST be null — a shot
     * family that could never be honoured would be dead authority
     * inside the definition hash. */
    shotFamily: mysqlEnum('shot_family', SLOT_SHOT_FAMILIES),
    referenceRequirement: mysqlEnum(
      'reference_requirement',
      SLOT_REFERENCE_REQUIREMENTS,
    ),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('psts_ver_key_unique').on(
      table.templateVersionId,
      table.slotKey,
    ),
    uniqueIndex('psts_ver_pos_unique').on(
      table.templateVersionId,
      table.position,
    ),
    foreignKey({
      columns: [table.templateVersionId],
      foreignColumns: [prayerSessionTemplateVersions.id],
      name: 'psts_version_fk',
    }).onDelete('restrict'),
  ],
)

/** Explicit allowed content scopes per CONTENT slot (leadership
 * decides whether PLATFORM/SACRED_HOUSE/SERVICE candidates may fill
 * the slot — Step 9 never reuses Step 7's specificity algorithm). */
export const prayerTemplateSlotScopes = mysqlTable(
  'prayer_template_slot_scopes',
  {
    slotId: bigint('slot_id', { mode: 'number', unsigned: true }).notNull(),
    scopeType: mysqlEnum('scope_type', CONTENT_SCOPE_TYPES).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.slotId, table.scopeType],
      name: 'ptss_pk',
    }),
    foreignKey({
      columns: [table.slotId],
      foreignColumns: [prayerSessionTemplateSlots.id],
      name: 'ptss_slot_fk',
    }).onDelete('restrict'),
  ],
)

/** Exact human-pinned Step 8 sacred content versions for
 * PINNED_VERSIONS slots. */
export const prayerTemplateSlotPins = mysqlTable(
  'prayer_template_slot_pins',
  {
    slotId: bigint('slot_id', { mode: 'number', unsigned: true }).notNull(),
    contentVersionId: bigint('content_version_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    pinOrder: int('pin_order', { unsigned: true }).notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [table.slotId, table.contentVersionId],
      name: 'ptsp_pk',
    }),
    index('ptsp_version_idx').on(table.contentVersionId),
    foreignKey({
      columns: [table.slotId],
      foreignColumns: [prayerSessionTemplateSlots.id],
      name: 'ptsp_slot_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.contentVersionId],
      foreignColumns: [spiritualContentVersions.id],
      name: 'ptsp_content_fk',
    }).onDelete('restrict'),
  ],
)

/** Leadership-approved forbidden content-item pairs per template
 * version: the two items may never co-occur in one resolved session.
 * Application stores each pair normalized (item_a_id < item_b_id). */
export const prayerTemplateForbiddenPairs = mysqlTable(
  'prayer_template_forbidden_pairs',
  {
    templateVersionId: bigint('template_version_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    contentItemIdA: int('content_item_id_a', { unsigned: true }).notNull(),
    contentItemIdB: int('content_item_id_b', { unsigned: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.templateVersionId,
        table.contentItemIdA,
        table.contentItemIdB,
      ],
      name: 'ptfp_pk',
    }),
    foreignKey({
      columns: [table.templateVersionId],
      foreignColumns: [prayerSessionTemplateVersions.id],
      name: 'ptfp_version_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.contentItemIdA],
      foreignColumns: [spiritualContentItems.id],
      name: 'ptfp_item_a_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.contentItemIdB],
      foreignColumns: [spiritualContentItems.id],
      name: 'ptfp_item_b_fk',
    }).onDelete('restrict'),
  ],
)
