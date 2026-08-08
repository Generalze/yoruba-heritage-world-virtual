import {
  bigint,
  foreignKey,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import { appointments } from './appointments'
import { users } from './users'

/**
 * Payment ledger (Phase One, Step 6; canon §28 payment architecture).
 *
 * Locked model: appointments keep their Step 5 lifecycle — there is NO
 * 'PAID' appointment status. Payment truth lives here. An appointment
 * may accumulate many attempts (failed Paystack, cancelled PayPal,
 * succeeded Stripe…), but at most ONE attempt ever becomes the accepted
 * settlement, enforced by appointment_payment_settlements' primary key.
 * Provider success arriving late / duplicated / commercially mismatched
 * is always RECORDED (money evidence is never lost) but resolves to
 * PAID_REQUIRES_REVIEW instead of confirming the appointment.
 *
 * Monetary instants are UTC 'YYYY-MM-DD HH:MM:SS' strings written by
 * application code, like appointments — never driver/VPS timezone
 * dependent. No card data, wallet keys or raw webhook bodies are ever
 * stored. All constraint names are explicit and short (MariaDB 64-char
 * identifier cap).
 */

/**
 * MOCK exists so development/test ledger rows are truthful about their
 * origin; the mock provider is impossible to enable in production
 * (registry + env validation both fail safe).
 */
export const PAYMENT_PROVIDERS = [
  'PAYSTACK',
  'PAYPAL',
  'STRIPE',
  'CRYPTO',
  'MOCK',
] as const
export type PaymentProviderCode = (typeof PAYMENT_PROVIDERS)[number]

export const PAYMENT_ATTEMPT_STATUSES = [
  'CREATED',
  'INITIALIZED',
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
] as const
export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number]

export const PAYMENT_RESOLUTION_STATUSES = [
  'NONE',
  'APPOINTMENT_CONFIRMED',
  'PAID_REQUIRES_REVIEW',
] as const
export type PaymentResolutionStatus =
  (typeof PAYMENT_RESOLUTION_STATUSES)[number]

export const PAYMENT_REVIEW_REASONS = [
  'RESERVATION_EXPIRED',
  'APPOINTMENT_NOT_CONFIRMABLE',
  'DUPLICATE_SUCCESS',
  'AMOUNT_MISMATCH',
  'CURRENCY_MISMATCH',
  'PROVIDER_REFERENCE_MISMATCH',
] as const
export type PaymentReviewReason = (typeof PAYMENT_REVIEW_REASONS)[number]

/**
 * One row per payment attempt. amount_minor/currency are copied from
 * the appointment's commercial snapshot at attempt creation and are the
 * ONLY values ever sent to a provider — never browser input, never the
 * service's current price. idempotency_key is the stable identity
 * reused for provider-side dedupe when an ambiguous network failure
 * forces a retry of the SAME attempt. The quoted_* columns exist only
 * for CRYPTO attempts; quoted_amount is a DECIMAL STRING (never
 * floating point).
 */
export const paymentAttempts = mysqlTable(
  'payment_attempts',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    publicId: varchar('public_id', { length: 36 }).notNull(),
    appointmentId: bigint('appointment_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    userId: bigint('user_id', { mode: 'number', unsigned: true }).notNull(),
    provider: mysqlEnum('provider', PAYMENT_PROVIDERS).notNull(),
    status: mysqlEnum('status', PAYMENT_ATTEMPT_STATUSES)
      .notNull()
      .default('CREATED'),
    resolutionStatus: mysqlEnum(
      'resolution_status',
      PAYMENT_RESOLUTION_STATUSES,
    )
      .notNull()
      .default('NONE'),
    reviewReason: mysqlEnum('review_reason', PAYMENT_REVIEW_REASONS),
    amountMinor: int('amount_minor', { unsigned: true }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    providerReference: varchar('provider_reference', { length: 128 }),
    providerPaymentId: varchar('provider_payment_id', { length: 128 }),
    providerCheckoutId: varchar('provider_checkout_id', { length: 128 }),
    checkoutUrl: varchar('checkout_url', { length: 1024 }),
    idempotencyKey: varchar('idempotency_key', { length: 64 }).notNull(),
    providerStatus: varchar('provider_status', { length: 64 }),
    initializedAt: varchar('initialized_at', { length: 19 }),
    paidAt: varchar('paid_at', { length: 19 }),
    failedAt: varchar('failed_at', { length: 19 }),
    expiresAt: varchar('expires_at', { length: 19 }),
    failureCode: varchar('failure_code', { length: 64 }),
    failureMessage: varchar('failure_message', { length: 255 }),
    quotedAsset: varchar('quoted_asset', { length: 16 }),
    quotedAmount: varchar('quoted_amount', { length: 64 }),
    quotedNetwork: varchar('quoted_network', { length: 32 }),
    quoteExpiresAt: varchar('quote_expires_at', { length: 19 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    uniqueIndex('pa_public_id_unique').on(table.publicId),
    uniqueIndex('pa_idem_key_unique').on(table.idempotencyKey),
    uniqueIndex('pa_provider_ref_unique').on(
      table.provider,
      table.providerReference,
    ),
    index('pa_appt_idx').on(table.appointmentId),
    index('pa_user_idx').on(table.userId),
    index('pa_status_idx').on(table.status),
    index('pa_resolution_idx').on(table.resolutionStatus),
    foreignKey({
      columns: [table.appointmentId],
      foreignColumns: [appointments.id],
      name: 'pa_appt_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'pa_user_fk',
    }).onDelete('restrict'),
  ],
)

export const SETTLEMENT_RESOLUTIONS = [
  'APPOINTMENT_CONFIRMED',
  'PAID_REQUIRES_REVIEW',
] as const
export type SettlementResolution = (typeof SETTLEMENT_RESOLUTIONS)[number]

/**
 * The concurrency-safe single-success boundary: appointment_id is the
 * PRIMARY KEY, so the database itself guarantees at most one accepted
 * settlement per appointment no matter how many providers succeed or
 * how many webhooks race. payment_attempt_id is UNIQUE so one attempt
 * can never settle two appointments. Later successes for an already
 * settled appointment stay in payment_attempts as
 * SUCCEEDED/PAID_REQUIRES_REVIEW/DUPLICATE_SUCCESS.
 */
export const appointmentPaymentSettlements = mysqlTable(
  'appointment_payment_settlements',
  {
    appointmentId: bigint('appointment_id', {
      mode: 'number',
      unsigned: true,
    }).primaryKey(),
    paymentAttemptId: bigint('payment_attempt_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    resolution: mysqlEnum('resolution', SETTLEMENT_RESOLUTIONS).notNull(),
    settledAt: timestamp('settled_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('aps_attempt_unique').on(table.paymentAttemptId),
    foreignKey({
      columns: [table.appointmentId],
      foreignColumns: [appointments.id],
      name: 'aps_appt_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.paymentAttemptId],
      foreignColumns: [paymentAttempts.id],
      name: 'aps_attempt_fk',
    }).onDelete('restrict'),
  ],
)

export const WEBHOOK_PROCESSING_STATUSES = [
  'RECEIVED',
  'PROCESSED',
  'IGNORED',
  'FAILED',
] as const
export type WebhookProcessingStatus =
  (typeof WEBHOOK_PROCESSING_STATUSES)[number]

/**
 * Webhook event idempotency ledger. (provider, event_key) is UNIQUE:
 * provider retries and duplicate deliveries collapse onto one row.
 * PROCESSED/IGNORED duplicates return success without reprocessing;
 * FAILED rows MAY be retried when the provider redelivers (transient
 * processing failures must not be ignored forever). Bodies are never
 * stored — only a SHA-256 digest plus sanitized identifiers. Rows are
 * only created AFTER provider signature verification succeeds.
 */
export const paymentWebhookEvents = mysqlTable(
  'payment_webhook_events',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    provider: mysqlEnum('provider', PAYMENT_PROVIDERS).notNull(),
    eventKey: varchar('event_key', { length: 191 }).notNull(),
    providerEventId: varchar('provider_event_id', { length: 128 }),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    payloadSha256: varchar('payload_sha256', { length: 64 }).notNull(),
    processingStatus: mysqlEnum(
      'processing_status',
      WEBHOOK_PROCESSING_STATUSES,
    )
      .notNull()
      .default('RECEIVED'),
    paymentAttemptId: bigint('payment_attempt_id', {
      mode: 'number',
      unsigned: true,
    }),
    receivedAt: timestamp('received_at').notNull().defaultNow(),
    processedAt: timestamp('processed_at'),
    errorCode: varchar('error_code', { length: 64 }),
  },
  (table) => [
    uniqueIndex('pwe_provider_event_unique').on(table.provider, table.eventKey),
    index('pwe_status_idx').on(table.processingStatus),
    foreignKey({
      columns: [table.paymentAttemptId],
      foreignColumns: [paymentAttempts.id],
      name: 'pwe_attempt_fk',
    }).onDelete('set null'),
  ],
)
