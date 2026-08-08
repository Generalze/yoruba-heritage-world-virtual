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
 * Content domains (Step 8): GUIDANCE is the Step 7 appointment
 * preparation/guidance system; SACRED_RUNTIME is the approved sacred
 * library the future autonomous Prayer Room engine consumes. The two
 * domains share the workflow architecture but never mix: guidance
 * assignment considers only GUIDANCE, runtime candidates only
 * SACRED_RUNTIME. The domain is established server-side by the route/
 * service used — never by browser input.
 */
export const CONTENT_DOMAINS = ['GUIDANCE', 'SACRED_RUNTIME'] as const
export type ContentDomain = (typeof CONTENT_DOMAINS)[number]

/**
 * The controlled Step 7 GUIDANCE content types. Application constant
 * over a bounded VARCHAR (not a DB enum); the Step 7 authoring surface
 * accepts exactly these seven — sacred runtime types are never offered
 * there.
 */
export const GUIDANCE_CONTENT_TYPES = [
  'PREPARATION',
  'WHAT_TO_EXPECT',
  'ARRIVAL_GUIDANCE',
  'PRAYER_PREPARATION',
  'POST_SESSION_GUIDANCE',
  'THANKSGIVING_GUIDANCE',
  'GENERAL_SPIRITUAL_NOTICE',
] as const
export type GuidanceContentType = (typeof GUIDANCE_CONTENT_TYPES)[number]

/**
 * The controlled Step 8 SACRED_RUNTIME content types. Deliberately no
 * SILENCE (a future template/timeline construct, not sacred text) and
 * no INSTRUCTION/FOLLOW_UP (Step 7 guidance territory).
 */
export const SACRED_RUNTIME_CONTENT_TYPES = [
  'OPENING',
  'GREETING',
  'HOUSE_INTRO',
  'INVOCATION',
  'PRAYER',
  'CALL_RESPONSE',
  'REFLECTION',
  'CHANT',
  'BLESSING',
  'CLOSING',
] as const
export type SacredRuntimeContentType =
  (typeof SACRED_RUNTIME_CONTENT_TYPES)[number]

export const ALL_SPIRITUAL_CONTENT_TYPES = [
  ...GUIDANCE_CONTENT_TYPES,
  ...SACRED_RUNTIME_CONTENT_TYPES,
] as const
export type SpiritualContentType = (typeof ALL_SPIRITUAL_CONTENT_TYPES)[number]

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
    // GUIDANCE default so the Step 8 migration safely backfills every
    // pre-existing Step 7 row.
    contentDomain: mysqlEnum('content_domain', CONTENT_DOMAINS)
      .notNull()
      .default('GUIDANCE'),
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
    index('sci_domain_idx').on(table.contentDomain),
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

// --- Step 8: sacred runtime profiles ---------------------------------------

export const VARIANT_KINDS = [
  'ORIGINAL',
  'AUTHORIZED_ALTERNATE',
  'TRANSLATION',
  'TRANSLITERATION',
  'GLOSS',
] as const
export type VariantKind = (typeof VARIANT_KINDS)[number]

export const PROVENANCE_TYPES = [
  'ORIGINAL_AUTHORED',
  'COMMISSIONED',
  'TRADITIONAL_ORAL',
  'LICENSED_SOURCE',
  'DOCUMENTED_SOURCE',
] as const
export type ProvenanceType = (typeof PROVENANCE_TYPES)[number]

export const VOICE_POLICIES = [
  'HUMAN_RECORDED_REQUIRED',
  'APPROVED_TTS_ALLOWED',
  'TEXT_ONLY',
] as const
export type VoicePolicy = (typeof VOICE_POLICIES)[number]

export const EXTERNAL_AI_POLICIES = [
  'NO_EXTERNAL_AI',
  'METADATA_ONLY',
  'APPROVED_TEXT_CONTEXT',
] as const
export type ExternalAiPolicy = (typeof EXTERNAL_AI_POLICIES)[number]

export const ACCESS_POLICIES = [
  'STAFF_ONLY',
  'PRAYER_ROOM_PRIVATE',
  'ARCHIVAL_RESTRICTED',
] as const
export type AccessPolicy = (typeof ACCESS_POLICIES)[number]

export const RIGHTS_STATUSES = [
  'UNREVIEWED',
  'PENDING_REVIEW',
  'CLEARED',
  'RESTRICTED',
  'WITHDRAWN',
] as const
export type RightsStatus = (typeof RIGHTS_STATUSES)[number]

/**
 * One-to-one runtime/provenance/rights profile for every SACRED_RUNTIME
 * content version (Step 8). Created ATOMICALLY with its version — a
 * sacred version never exists without a profile, and a GUIDANCE version
 * never has one (application-enforced; the composite FK guarantees the
 * version/item pairing at the database level).
 *
 * Governance model: humans approve upstream ONCE — cultural publication
 * (the Step 7 workflow), rights clearance (independent gate, only on
 * immutable APPROVED/PUBLISHED text), and the runtime_enabled switch.
 * Runtime eligibility is COMPUTED from these gates plus the SHA-256
 * integrity hash; no per-appointment human approval ever exists.
 * external_ai_policy is a FUTURE permission boundary only — nothing in
 * Step 8 calls any AI regardless of its value.
 */
export const sacredContentVersionProfiles = mysqlTable(
  'sacred_content_version_profiles',
  {
    contentVersionId: bigint('content_version_id', {
      mode: 'number',
      unsigned: true,
    }).primaryKey(),
    contentItemId: int('content_item_id', { unsigned: true }).notNull(),
    variantKind: mysqlEnum('variant_kind', VARIANT_KINDS)
      .notNull()
      .default('ORIGINAL'),
    provenanceType: mysqlEnum('provenance_type', PROVENANCE_TYPES).notNull(),
    sourceCommunity: varchar('source_community', { length: 255 }),
    sourcePlace: varchar('source_place', { length: 255 }),
    sourceReference: varchar('source_reference', { length: 1000 }),
    publicAttributionText: varchar('public_attribution_text', { length: 500 }),
    internalProvenanceNote: varchar('internal_provenance_note', {
      length: 2000,
    }),
    digitalStorageAuthorized: boolean('digital_storage_authorized')
      .notNull()
      .default(false),
    themeCode: varchar('theme_code', { length: 60 }),
    durationHintSeconds: int('duration_hint_seconds', { unsigned: true }),
    repeatable: boolean('repeatable').notNull().default(false),
    voicePolicy: mysqlEnum('voice_policy', VOICE_POLICIES).notNull(),
    externalAiPolicy: mysqlEnum('external_ai_policy', EXTERNAL_AI_POLICIES)
      .notNull()
      .default('METADATA_ONLY'),
    accessPolicy: mysqlEnum('access_policy', ACCESS_POLICIES)
      .notNull()
      .default('STAFF_ONLY'),
    rightsStatus: mysqlEnum('rights_status', RIGHTS_STATUSES)
      .notNull()
      .default('UNREVIEWED'),
    rightsReviewedBy: bigint('rights_reviewed_by', {
      mode: 'number',
      unsigned: true,
    }),
    rightsReviewedAt: timestamp('rights_reviewed_at'),
    rightsNote: varchar('rights_note', { length: 1000 }),
    runtimeEnabled: boolean('runtime_enabled').notNull().default(false),
    contentSha256: varchar('content_sha256', { length: 64 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    index('scvp_item_idx').on(table.contentItemId),
    index('scvp_rights_idx').on(table.rightsStatus),
    index('scvp_runtime_idx').on(table.runtimeEnabled),
    index('scvp_access_idx').on(table.accessPolicy),
    index('scvp_theme_idx').on(table.themeCode),
    index('scvp_variant_idx').on(table.variantKind),
    // The profile's version must actually belong to the profile's item.
    foreignKey({
      columns: [table.contentVersionId, table.contentItemId],
      foreignColumns: [
        spiritualContentVersions.id,
        spiritualContentVersions.contentItemId,
      ],
      name: 'scvp_ver_item_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.rightsReviewedBy],
      foreignColumns: [users.id],
      name: 'scvp_rights_by_fk',
    }).onDelete('set null'),
  ],
)
