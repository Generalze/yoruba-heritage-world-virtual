CREATE TABLE `appointment_payment_settlements` (
	`appointment_id` bigint unsigned NOT NULL,
	`payment_attempt_id` bigint unsigned NOT NULL,
	`resolution` enum('APPOINTMENT_CONFIRMED','PAID_REQUIRES_REVIEW') NOT NULL,
	`settled_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `appointment_payment_settlements_appointment_id` PRIMARY KEY(`appointment_id`),
	CONSTRAINT `aps_attempt_unique` UNIQUE(`payment_attempt_id`)
);
--> statement-breakpoint
CREATE TABLE `payment_attempts` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` varchar(36) NOT NULL,
	`appointment_id` bigint unsigned NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`provider` enum('PAYSTACK','PAYPAL','STRIPE','CRYPTO','MOCK') NOT NULL,
	`status` enum('CREATED','INITIALIZED','PENDING','SUCCEEDED','FAILED','CANCELLED','EXPIRED') NOT NULL DEFAULT 'CREATED',
	`resolution_status` enum('NONE','APPOINTMENT_CONFIRMED','PAID_REQUIRES_REVIEW') NOT NULL DEFAULT 'NONE',
	`review_reason` enum('RESERVATION_EXPIRED','APPOINTMENT_NOT_CONFIRMABLE','DUPLICATE_SUCCESS','AMOUNT_MISMATCH','CURRENCY_MISMATCH','PROVIDER_REFERENCE_MISMATCH'),
	`amount_minor` int unsigned NOT NULL,
	`currency` varchar(3) NOT NULL,
	`provider_reference` varchar(128),
	`provider_payment_id` varchar(128),
	`provider_checkout_id` varchar(128),
	`checkout_url` varchar(1024),
	`idempotency_key` varchar(64) NOT NULL,
	`provider_status` varchar(64),
	`initialized_at` varchar(19),
	`paid_at` varchar(19),
	`failed_at` varchar(19),
	`expires_at` varchar(19),
	`failure_code` varchar(64),
	`failure_message` varchar(255),
	`quoted_asset` varchar(16),
	`quoted_amount` varchar(64),
	`quoted_network` varchar(32),
	`quote_expires_at` varchar(19),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `payment_attempts_id` PRIMARY KEY(`id`),
	CONSTRAINT `pa_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `pa_idem_key_unique` UNIQUE(`idempotency_key`),
	CONSTRAINT `pa_provider_ref_unique` UNIQUE(`provider`,`provider_reference`)
);
--> statement-breakpoint
CREATE TABLE `payment_webhook_events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`provider` enum('PAYSTACK','PAYPAL','STRIPE','CRYPTO','MOCK') NOT NULL,
	`event_key` varchar(191) NOT NULL,
	`provider_event_id` varchar(128),
	`event_type` varchar(64) NOT NULL,
	`payload_sha256` varchar(64) NOT NULL,
	`processing_status` enum('RECEIVED','PROCESSED','IGNORED','FAILED') NOT NULL DEFAULT 'RECEIVED',
	`payment_attempt_id` bigint unsigned,
	`received_at` timestamp NOT NULL DEFAULT (now()),
	`processed_at` timestamp,
	`error_code` varchar(64),
	CONSTRAINT `payment_webhook_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `pwe_provider_event_unique` UNIQUE(`provider`,`event_key`)
);
--> statement-breakpoint
ALTER TABLE `appointment_payment_settlements` ADD CONSTRAINT `aps_appt_fk` FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `appointment_payment_settlements` ADD CONSTRAINT `aps_attempt_fk` FOREIGN KEY (`payment_attempt_id`) REFERENCES `payment_attempts`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_attempts` ADD CONSTRAINT `pa_appt_fk` FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_attempts` ADD CONSTRAINT `pa_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_webhook_events` ADD CONSTRAINT `pwe_attempt_fk` FOREIGN KEY (`payment_attempt_id`) REFERENCES `payment_attempts`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `pa_appt_idx` ON `payment_attempts` (`appointment_id`);--> statement-breakpoint
CREATE INDEX `pa_user_idx` ON `payment_attempts` (`user_id`);--> statement-breakpoint
CREATE INDEX `pa_status_idx` ON `payment_attempts` (`status`);--> statement-breakpoint
CREATE INDEX `pa_resolution_idx` ON `payment_attempts` (`resolution_status`);--> statement-breakpoint
CREATE INDEX `pwe_status_idx` ON `payment_webhook_events` (`processing_status`);