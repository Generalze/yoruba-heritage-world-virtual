import {
  bigint,
  boolean,
  foreignKey,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import { sacredHouses, services } from './catalogue'
import {
  CONTENT_SCOPE_TYPES,
  CONTENT_VERSION_STATUSES,
  GUIDANCE_LANGUAGES,
  RIGHTS_STATUSES,
  spiritualContentVersions,
} from './guidance'
import { users } from './users'

/**
 * Approved audio/visual media asset library + Visual Bibles (Phase
 * One, Step 10; canon §10.3/§11/§12).
 *
 * Governance model mirrors Steps 7–9: humans approve UPSTREAM once
 * (editorial publication, rights clearance, consent confirmation,
 * runtime enablement); runtime eligibility is COMPUTED from those
 * gates plus storage/hash integrity. NO per-appointment media approval
 * exists. Step 10 stores and governs media only — no Kling, OpenArt,
 * TTS, Remotion, FFmpeg or Prayer Room work.
 *
 * Media binaries live in PRIVATE storage (never public web root,
 * never Git); the database stores server-generated object keys and a
 * server-computed SHA-256 of the exact stored bytes.
 */

export const MEDIA_ASSET_KINDS = ['AUDIO', 'IMAGE', 'VIDEO'] as const
export type MediaAssetKind = (typeof MEDIA_ASSET_KINDS)[number]

export const MEDIA_SOURCE_TYPES = [
  'HUMAN_RECORDED',
  'IN_HOUSE',
  'LICENSED',
  'AI_GENERATED',
  'OPENART_CREATED',
  'KLING_GENERATED',
] as const
export type MediaSourceType = (typeof MEDIA_SOURCE_TYPES)[number]

export const MEDIA_CONSENT_STATUSES = [
  'NOT_APPLICABLE',
  'PENDING',
  'GRANTED',
  'WITHDRAWN',
] as const
export type MediaConsentStatus = (typeof MEDIA_CONSENT_STATUSES)[number]

export const MEDIA_EXTERNAL_AI_POLICIES = [
  'NO_EXTERNAL_AI',
  'REFERENCE_ONLY',
  'DERIVATIVE_GENERATION_ALLOWED',
] as const
export type MediaExternalAiPolicy = (typeof MEDIA_EXTERNAL_AI_POLICIES)[number]

/**
 * The canonical shot families a Visual Bible may bind an approved
 * reference image to (Step 24). Roles, never filenames: which file
 * plays WIDE_MASTER is a binding decision recorded per version, so a
 * replaced image is a new media version and therefore a new Visual
 * Bible version.
 */
export const VISUAL_BIBLE_REFERENCE_ROLES = [
  'WIDE_MASTER',
  'MEDIUM_PRAYER',
  'DIRECT_CAMERA',
  'SIDE_PRAYER',
  'WORKING_DETAIL',
  'ENVIRONMENT_INSERT',
] as const
export type VisualBibleReferenceRole =
  (typeof VISUAL_BIBLE_REFERENCE_ROLES)[number]

/**
 * Whether a Visual Bible version governs generation by written rules
 * alone, or additionally requires the complete approved reference pack.
 *
 * TEXT_ONLY is the default so every pre-existing version keeps its
 * exact meaning. IMAGE_REFERENCE_REQUIRED is an explicit human choice
 * that makes the six-role pack a publication precondition — merely
 * validating "whatever references happen to exist" would let a version
 * publish with none at all.
 */
export const VISUAL_BIBLE_REFERENCE_MODES = [
  'TEXT_ONLY',
  'IMAGE_REFERENCE_REQUIRED',
] as const
export type VisualBibleReferenceMode =
  (typeof VISUAL_BIBLE_REFERENCE_MODES)[number]

export const SACRED_MEDIA_LINK_ROLES = [
  'PRIMARY_AUDIO',
  'ALTERNATE_AUDIO',
  'VISUAL_REFERENCE',
] as const
export type SacredMediaLinkRole = (typeof SACRED_MEDIA_LINK_ROLES)[number]

export const mediaAssets = mysqlTable(
  'media_assets',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    publicId: varchar('public_id', { length: 36 }).notNull(),
    code: varchar('code', { length: 60 }).notNull(),
    assetKind: mysqlEnum('asset_kind', MEDIA_ASSET_KINDS).notNull(),
    scopeType: mysqlEnum('scope_type', CONTENT_SCOPE_TYPES).notNull(),
    sacredHouseId: int('sacred_house_id', { unsigned: true }),
    serviceId: int('service_id', { unsigned: true }),
    contentType: varchar('content_type', { length: 40 }),
    themeCode: varchar('theme_code', { length: 60 }),
    active: boolean('active').notNull().default(true),
    createdBy: bigint('created_by', { mode: 'number', unsigned: true }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    uniqueIndex('ma_public_id_unique').on(table.publicId),
    uniqueIndex('ma_code_unique').on(table.code),
    index('ma_kind_idx').on(table.assetKind),
    index('ma_scope_idx').on(table.scopeType),
    index('ma_house_idx').on(table.sacredHouseId),
    index('ma_service_idx').on(table.serviceId),
    index('ma_type_idx').on(table.contentType),
    index('ma_theme_idx').on(table.themeCode),
    index('ma_active_idx').on(table.active),
    foreignKey({
      columns: [table.sacredHouseId],
      foreignColumns: [sacredHouses.id],
      name: 'ma_house_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [services.id],
      name: 'ma_service_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'ma_created_by_fk',
    }).onDelete('set null'),
  ],
)

export const mediaAssetVersions = mysqlTable(
  'media_asset_versions',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    assetId: int('asset_id', { unsigned: true }).notNull(),
    versionNumber: int('version_number', { unsigned: true }).notNull(),
    status: mysqlEnum('status', CONTENT_VERSION_STATUSES)
      .notNull()
      .default('DRAFT'),
    sourceType: mysqlEnum('source_type', MEDIA_SOURCE_TYPES).notNull(),
    language: mysqlEnum('language', GUIDANCE_LANGUAGES),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    byteSize: int('byte_size', { unsigned: true }).notNull(),
    durationSeconds: int('duration_seconds', { unsigned: true }),
    width: int('width', { unsigned: true }),
    height: int('height', { unsigned: true }),
    storageKey: varchar('storage_key', { length: 255 }).notNull(),
    fileSha256: varchar('file_sha256', { length: 64 }).notNull(),
    rightsStatus: mysqlEnum('rights_status', RIGHTS_STATUSES)
      .notNull()
      .default('UNREVIEWED'),
    rightsReviewedBy: bigint('rights_reviewed_by', {
      mode: 'number',
      unsigned: true,
    }),
    rightsReviewedAt: timestamp('rights_reviewed_at'),
    rightsNote: varchar('rights_note', { length: 1000 }),
    containsIdentifiablePerson: boolean('contains_identifiable_person')
      .notNull()
      .default(false),
    consentStatus: mysqlEnum('consent_status', MEDIA_CONSENT_STATUSES)
      .notNull()
      .default('NOT_APPLICABLE'),
    consentReference: varchar('consent_reference', { length: 500 }),
    externalAiPolicy: mysqlEnum(
      'external_ai_policy',
      MEDIA_EXTERNAL_AI_POLICIES,
    )
      .notNull()
      .default('NO_EXTERNAL_AI'),
    voiceCloneAuthorized: boolean('voice_clone_authorized')
      .notNull()
      .default(false),
    runtimeEnabled: boolean('runtime_enabled').notNull().default(false),
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
    uniqueIndex('mav_asset_ver_unique').on(table.assetId, table.versionNumber),
    uniqueIndex('mav_storage_key_unique').on(table.storageKey),
    index('mav_asset_status_idx').on(table.assetId, table.status),
    index('mav_rights_idx').on(table.rightsStatus),
    index('mav_runtime_idx').on(table.runtimeEnabled),
    index('mav_consent_idx').on(table.consentStatus),
    foreignKey({
      columns: [table.assetId],
      foreignColumns: [mediaAssets.id],
      name: 'mav_asset_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'mav_created_by_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.approvedBy],
      foreignColumns: [users.id],
      name: 'mav_approved_by_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.publishedBy],
      foreignColumns: [users.id],
      name: 'mav_published_by_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.rightsReviewedBy],
      foreignColumns: [users.id],
      name: 'mav_rights_by_fk',
    }).onDelete('set null'),
  ],
)

/** Exact human-approved link between one Step 8 sacred content VERSION
 * and one media asset VERSION (e.g. the human-recorded audio of that
 * exact prayer text). Runtime eligibility of both sides is re-checked
 * at every future selection. */
export const sacredContentMediaLinks = mysqlTable(
  'sacred_content_media_links',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    contentVersionId: bigint('content_version_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    mediaAssetVersionId: bigint('media_asset_version_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    role: mysqlEnum('role', SACRED_MEDIA_LINK_ROLES).notNull(),
    sortOrder: int('sort_order').notNull().default(0),
    createdBy: bigint('created_by', { mode: 'number', unsigned: true }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('scml_unique').on(
      table.contentVersionId,
      table.mediaAssetVersionId,
      table.role,
    ),
    index('scml_media_idx').on(table.mediaAssetVersionId),
    foreignKey({
      columns: [table.contentVersionId],
      foreignColumns: [spiritualContentVersions.id],
      name: 'scml_content_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.mediaAssetVersionId],
      foreignColumns: [mediaAssetVersions.id],
      name: 'scml_media_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'scml_created_by_fk',
    }).onDelete('set null'),
  ],
)

// --- Visual Bibles ----------------------------------------------------------

export const VISUAL_BIBLE_RULE_CATEGORIES = [
  'ENVIRONMENT',
  'ARCHITECTURE',
  'NATURAL_SETTING',
  'COLOR',
  'SYMBOL',
  'CLOTHING',
  'CEREMONIAL_OBJECT',
  'CHARACTER_CONSTRAINT',
  'CAMERA',
  'LIGHTING',
  'MOVEMENT',
  'ATMOSPHERE',
  'PROHIBITED_IMAGERY',
  'PROHIBITED_SYMBOL',
  'PROHIBITED_COMBINATION',
  'NEGATIVE_PROMPT_GUIDANCE',
] as const
export type VisualBibleRuleCategory =
  (typeof VISUAL_BIBLE_RULE_CATEGORIES)[number]

/** One canonical Visual Bible per Sacred House (house-level; language
 * is not modeled for Bible rules in Step 10). */
export const visualBibles = mysqlTable(
  'visual_bibles',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    publicId: varchar('public_id', { length: 36 }).notNull(),
    sacredHouseId: int('sacred_house_id', { unsigned: true }).notNull(),
    active: boolean('active').notNull().default(true),
    createdBy: bigint('created_by', { mode: 'number', unsigned: true }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    uniqueIndex('vb_public_id_unique').on(table.publicId),
    uniqueIndex('vb_house_unique').on(table.sacredHouseId),
    foreignKey({
      columns: [table.sacredHouseId],
      foreignColumns: [sacredHouses.id],
      name: 'vb_house_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'vb_created_by_fk',
    }).onDelete('set null'),
  ],
)

export const visualBibleVersions = mysqlTable(
  'visual_bible_versions',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    visualBibleId: int('visual_bible_id', { unsigned: true }).notNull(),
    versionNumber: int('version_number', { unsigned: true }).notNull(),
    status: mysqlEnum('status', CONTENT_VERSION_STATUSES)
      .notNull()
      .default('DRAFT'),
    definitionSha256: varchar('definition_sha256', { length: 64 }),
    /** Governs whether the six-role reference pack is required to
     * publish. Defaults to TEXT_ONLY so existing versions are unchanged
     * in meaning. */
    referenceMode: mysqlEnum('reference_mode', VISUAL_BIBLE_REFERENCE_MODES)
      .notNull()
      .default('TEXT_ONLY'),
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
    uniqueIndex('vbv_bible_ver_unique').on(
      table.visualBibleId,
      table.versionNumber,
    ),
    index('vbv_bible_status_idx').on(table.visualBibleId, table.status),
    foreignKey({
      columns: [table.visualBibleId],
      foreignColumns: [visualBibles.id],
      name: 'vbv_bible_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'vbv_created_by_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.approvedBy],
      foreignColumns: [users.id],
      name: 'vbv_approved_by_fk',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.publishedBy],
      foreignColumns: [users.id],
      name: 'vbv_published_by_fk',
    }).onDelete('set null'),
  ],
)

/** Human-authored, ordered plain-text visual canon rules. Never AI
 * generated. Immutable once the version leaves DRAFT. */
export const visualBibleRules = mysqlTable(
  'visual_bible_rules',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    bibleVersionId: bigint('bible_version_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    category: mysqlEnum('category', VISUAL_BIBLE_RULE_CATEGORIES).notNull(),
    position: int('position', { unsigned: true }).notNull(),
    ruleText: varchar('rule_text', { length: 2000 }).notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('vbr_ver_pos_unique').on(table.bibleVersionId, table.position),
    index('vbr_category_idx').on(table.category),
    foreignKey({
      columns: [table.bibleVersionId],
      foreignColumns: [visualBibleVersions.id],
      name: 'vbr_version_fk',
    }).onDelete('restrict'),
  ],
)

/**
 * Approved reference imagery bound to ONE Visual Bible version
 * (Step 24, provider-neutral foundation).
 *
 * WHY NOT sacredContentMediaLinks: that table's contentVersionId keys
 * to spiritualContentVersions — it binds a PRAYER TEXT to media. Its
 * VISUAL_REFERENCE role means "reference for this sacred text", not
 * "room reference for this House's Visual Bible". Reusing it would
 * require a fictional content version and would misstate the domain.
 *
 * VERSION-BOUND, NOT BIBLE-BOUND. References are part of what gets
 * approved, so they belong to the version and enter its canonical
 * definition hash. A later version re-binds deliberately; approving v2
 * can never silently inherit v1's imagery. Binding is DRAFT-only:
 * once a version is submitted its references are as immutable as its
 * rules.
 *
 * EXACT MEDIA VERSION, plus the file hash frozen at bind time. An
 * edited image is a new media version and cannot leak into an approved
 * Bible, and a changed file trips the stored-hash comparison
 * independently of the media library's own integrity check.
 */
export const visualBibleReferenceMedia = mysqlTable(
  'visual_bible_reference_media',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    visualBibleVersionId: bigint('visual_bible_version_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    mediaAssetVersionId: bigint('media_asset_version_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    role: mysqlEnum('role', VISUAL_BIBLE_REFERENCE_ROLES).notNull(),
    /** The media version's file hash AT BIND TIME. Compared against the
     * live value at every later gate: a second, independent tripwire. */
    mediaFileSha256: varchar('media_file_sha256', { length: 64 }).notNull(),
    boundBy: bigint('bound_by', { mode: 'number', unsigned: true }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    // One reference per role per version: "which image is the wide
    // master" is never ambiguous and never order-dependent.
    uniqueIndex('vbrm_version_role_unique').on(
      table.visualBibleVersionId,
      table.role,
    ),
    index('vbrm_media_idx').on(table.mediaAssetVersionId),
    foreignKey({
      columns: [table.visualBibleVersionId],
      foreignColumns: [visualBibleVersions.id],
      name: 'vbrm_version_fk',
    }).onDelete('cascade'),
    // RESTRICT: an approved reference cannot be deleted out from under
    // the version that was approved with it.
    foreignKey({
      columns: [table.mediaAssetVersionId],
      foreignColumns: [mediaAssetVersions.id],
      name: 'vbrm_media_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.boundBy],
      foreignColumns: [users.id],
      name: 'vbrm_bound_by_fk',
    }).onDelete('set null'),
  ],
)
