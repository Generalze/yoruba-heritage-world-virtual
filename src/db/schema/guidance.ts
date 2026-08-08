import {
  bigint,
  boolean,
  foreignKey,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import { appointments } from './appointments'
import { sacredHouses, services } from './catalogue'
import { users } from './users'

/**
 * Approved spiritual preparation & guidance content (Phase One, Step 7).
 *
 * Locked model:
 * - ALL spiritual content is HUMAN-AUTHORED. Nothing here is ever
 *   generated, rewritten, translated, summarized or inferred by AI.
 * - Content ITEMS are stable conceptual identities; the sacred text
 *   lives only on immutable VERSIONS that move through the established
 *   DRAFT → UNDER_REVIEW → APPROVED → PUBLISHED → ARCHIVED workflow.
 * - English and Yorùbá variants are separately authored and separately
 *   approved; fallback from yo → en happens ONLY when the English
 *   version explicitly allows it. Never the reverse, never silently.
 * - At appointment confirmation the applicable published versions are
 *   FROZEN for that appointment (references to immutable versions —
 *   never re-resolved later, never rewritten by later publication).
 * - Nothing is destructively deleted: archive/deactivate only.
 *
 * All constraint names are explicit and short (MariaDB 64-char cap).
 */

/**
 * The controlled Step 7 content types. Application constant over a
 * bounded VARCHAR (not a DB enum) so later approved stages can add
 * types (e.g. an approved prayer library) without a schema rewrite —
 * but the Step 7 authoring surface accepts exactly these seven.
 */
export const SPIRITUAL_CONTENT_TYPES = [
  'PREPARATION',
  'WHAT_TO_EXPECT',
  'ARRIVAL_GUIDANCE',
  'PRAYER_PREPARATION',
  'POST_SESSION_GUIDANCE',
  'THANKSGIVING_GUIDANCE',
  'GENERAL_SPIRITUAL_NOTICE',
] as const
export type SpiritualContentType = (typeof SPIRITUAL_CONTENT_TYPES)[number]

export const CONTENT_SCOPE_TYPES = [
  'PLATFORM',
  'SACRED_HOUSE',
  'SERVICE',
] as const
export type ContentScopeType = (typeof CONTENT_SCOPE_TYPES)[number]

/** Controlled human-authored languages. Bounded VARCHAR column with
 * application validation so later approved languages need no migration. */
export const GUIDANCE_LANGUAGES = ['en', 'yo'] as const
export type GuidanceLanguage = (typeof GUIDANCE_LANGUAGES)[number]

export const VISIBILITY_STAGES = [
  'AFTER_CONFIRMATION',
  'BEFORE_APPOINTMENT',
  'AFTER_APPOINTMENT',
] as const
export type VisibilityStage = (typeof VISIBILITY_STAGES)[number]

export const CONTENT_VERSION_STATUSES = [
  'DRAFT',
  'UNDER_REVIEW',
  'APPROVED',
  'PUBLISHED',
  'ARCHIVED',
] as const
export type ContentVersionStatus = (typeof CONTENT_VERSION_STATUSES)[number]

/**
 * Stable conceptual identity of one piece of guidance. Exactly one
 * applicability scope: PLATFORM (no House/Service), SACRED_HOUSE
 * (House only) or SERVICE (Service only — the House is derived from
 * the Service, never stored contradictorily). No spiritual body text
 * lives here — only on versions.
 */
export const spiritualContentItems = mysqlTable(
  'spiritual_content_items',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    publicId: varchar('public_id', { length: 36 }).notNull(),
    code: varchar('code', { length: 60 }).notNull(),
    contentType: varchar('content_type', { length: 40 }).notNull(),
    scopeType: mysqlEnum('scope_type', CONTENT_SCOPE_TYPES).notNull(),
    sacredHouseId: int('sacred_house_id', { unsigned: true }),
    serviceId: int('service_id', { unsigned: true }),
    sortOrder: int('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdBy: bigint('created_by', { mode: 'number', unsigned: true }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    uniqueIndex('sci_public_id_unique').on(table.publicId),
    uniqueIndex('sci_code_unique').on(table.code),
    index('sci_type_idx').on(table.contentType),
    index('sci_scope_idx').on(table.scopeType),
    index('sci_house_idx').on(table.sacredHouseId),
    index('sci_service_idx').on(table.serviceId),
    index('sci_active_idx').on(table.active),
    foreignKey({
      columns: [table.sacredHouseId],
      foreignColumns: [sacredHouses.id],
      name: 'sci_house_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [services.id],
      name: 'sci_service_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'sci_created_by_fk',
    }).onDelete('set null'),
  ],
)

/**
 * Immutable sacred text versions. Version numbers are scoped by
 * (item, language) and allocated under the item row lock. Only DRAFT
 * content is editable; everything after submission is immutable except
 * its workflow status. allow_english_fallback may only be true on an
 * English version (application-enforced). Plain text only — no HTML is
 * ever stored or rendered.
 */
export const spiritualContentVersions = mysqlTable(
  'spiritual_content_versions',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    contentItemId: int('content_item_id', { unsigned: true }).notNull(),
    language: varchar('language', { length: 10 }).notNull(),
    versionNumber: int('version_number', { unsigned: true }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    body: text('body').notNull(),
    visibilityStage: mysqlEnum('visibility_stage', VISIBILITY_STAGES)
      .notNull()
      .default('AFTER_CONFIRMATION'),
    acknowledgementRequired: boolean('acknowledgement_required')
      .notNull()
      .default(false),
    allowEnglishFallback: boolean('allow_english_fallback')
      .notNull()
      .default(false),
    status: mysqlEnum('status', CONTENT_VERSION_STATUSES)
      .notNull()
      .default('DRAFT'),
    createdBy: bigint('created_by', { mode: 'number', unsigned: true }),
    submittedAt: timestamp('submitted_at'),
    approvedBy: bigint('approved_by', { mode: 'number', unsigned: true }),
    approvedAt: timestamp('approved_at'),
    publishedBy: bigint('published_by', { mode: 'number', unsigned: true }),
    publishedAt: timestamp('published_at'),
    archivedAt: timestamp('archived_at'),
    reviewNote: varchar('review_note', { length: 500 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    uniqueIndex('scv_item_lang_ver_unique').on(
      table.contentItemId,
      table.language,
      table.versionNumber,
    ),
    index('scv_item_lang_status_idx').on(
      table.contentItemId,
      table.language,
      table.status,
    ),
    // Composite target for the assignment integrity FK below.
    uniqueIndex('scv_id_item_unique').on(table.id, table.contentItemId),
    foreignKey({
      columns: [table.contentItemId],
      foreignColumns: [spiritualContentItems.id],
      name: 'scv_item_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'scv_created_by_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.approvedBy],
      foreignColumns: [users.id],
      name: 'scv_approved_by_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.publishedBy],
      foreignColumns: [users.id],
      name: 'scv_published_by_fk',
    }).onDelete('set null'),
  ],
)

export const GUIDANCE_SELECTION_RESULTS = [
  'ASSIGNED',
  'NO_APPLICABLE_CONTENT',
  'MISSING_LANGUAGE',
] as const
export type GuidanceSelectionResult =
  (typeof GUIDANCE_SELECTION_RESULTS)[number]

/**
 * Exactly-once selection marker: one row per appointment, created in
 * the SAME transaction as the CONFIRMED transition — even when zero
 * items were assignable. Once this row exists, selection is never
 * automatically re-run; an appointment confirmed with zero assignments
 * can never accidentally acquire newly published guidance later.
 */
export const appointmentGuidanceSets = mysqlTable(
  'appointment_guidance_sets',
  {
    appointmentId: bigint('appointment_id', {
      mode: 'number',
      unsigned: true,
    }).primaryKey(),
    preferredLanguageSnapshot: varchar('preferred_language_snapshot', {
      length: 10,
    }),
    selectionResult: mysqlEnum(
      'selection_result',
      GUIDANCE_SELECTION_RESULTS,
    ).notNull(),
    assignmentCount: int('assignment_count', { unsigned: true })
      .notNull()
      .default(0),
    assignedAt: timestamp('assigned_at').notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.appointmentId],
      foreignColumns: [appointments.id],
      name: 'ags_appt_fk',
    }).onDelete('restrict'),
  ],
)

/**
 * Frozen version references — the historical authority for what a
 * user sees. References immutable versions (never copies of sacred
 * text). The composite FK guarantees the referenced version actually
 * belongs to the referenced item; RESTRICT everywhere so history can
 * never be destroyed.
 */
export const appointmentGuidanceAssignments = mysqlTable(
  'appointment_guidance_assignments',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    appointmentId: bigint('appointment_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    contentItemId: int('content_item_id', { unsigned: true }).notNull(),
    contentVersionId: bigint('content_version_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    selectedScope: mysqlEnum('selected_scope', CONTENT_SCOPE_TYPES).notNull(),
    fallbackUsed: boolean('fallback_used').notNull().default(false),
    sortOrderSnapshot: int('sort_order_snapshot').notNull().default(0),
    assignedAt: timestamp('assigned_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('aga_appt_item_unique').on(
      table.appointmentId,
      table.contentItemId,
    ),
    uniqueIndex('aga_appt_ver_unique').on(
      table.appointmentId,
      table.contentVersionId,
    ),
    index('aga_version_idx').on(table.contentVersionId),
    foreignKey({
      columns: [table.appointmentId],
      foreignColumns: [appointments.id],
      name: 'aga_appt_fk',
    }).onDelete('restrict'),
    // Composite integrity: the version row must belong to the item row.
    foreignKey({
      columns: [table.contentVersionId, table.contentItemId],
      foreignColumns: [
        spiritualContentVersions.id,
        spiritualContentVersions.contentItemId,
      ],
      name: 'aga_ver_item_fk',
    }).onDelete('restrict'),
  ],
)

/**
 * "I have read this guidance" records — nothing more (never compliance
 * certification). Idempotent per (appointment, version); no
 * un-acknowledge; survives version archival.
 */
export const appointmentGuidanceAcknowledgements = mysqlTable(
  'appointment_guidance_acknowledgements',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    appointmentId: bigint('appointment_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    contentVersionId: bigint('content_version_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    acknowledgedAt: timestamp('acknowledged_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('agk_appt_ver_unique').on(
      table.appointmentId,
      table.contentVersionId,
    ),
    foreignKey({
      columns: [table.appointmentId],
      foreignColumns: [appointments.id],
      name: 'agk_appt_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.contentVersionId],
      foreignColumns: [spiritualContentVersions.id],
      name: 'agk_version_fk',
    }).onDelete('restrict'),
  ],
)
