CREATE TABLE `appointment_guidance_acknowledgements` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`appointment_id` bigint unsigned NOT NULL,
	`content_version_id` bigint unsigned NOT NULL,
	`acknowledged_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `appointment_guidance_acknowledgements_id` PRIMARY KEY(`id`),
	CONSTRAINT `agk_appt_ver_unique` UNIQUE(`appointment_id`,`content_version_id`)
);
--> statement-breakpoint
CREATE TABLE `appointment_guidance_assignments` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`appointment_id` bigint unsigned NOT NULL,
	`content_item_id` int unsigned NOT NULL,
	`content_version_id` bigint unsigned NOT NULL,
	`selected_scope` enum('PLATFORM','SACRED_HOUSE','SERVICE') NOT NULL,
	`fallback_used` boolean NOT NULL DEFAULT false,
	`sort_order_snapshot` int NOT NULL DEFAULT 0,
	`assigned_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `appointment_guidance_assignments_id` PRIMARY KEY(`id`),
	CONSTRAINT `aga_appt_item_unique` UNIQUE(`appointment_id`,`content_item_id`),
	CONSTRAINT `aga_appt_ver_unique` UNIQUE(`appointment_id`,`content_version_id`)
);
--> statement-breakpoint
CREATE TABLE `appointment_guidance_sets` (
	`appointment_id` bigint unsigned NOT NULL,
	`preferred_language_snapshot` varchar(10),
	`selection_result` enum('ASSIGNED','NO_APPLICABLE_CONTENT','MISSING_LANGUAGE') NOT NULL,
	`assignment_count` int unsigned NOT NULL DEFAULT 0,
	`assigned_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `appointment_guidance_sets_appointment_id` PRIMARY KEY(`appointment_id`)
);
--> statement-breakpoint
CREATE TABLE `spiritual_content_items` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`public_id` varchar(36) NOT NULL,
	`code` varchar(60) NOT NULL,
	`content_type` varchar(40) NOT NULL,
	`scope_type` enum('PLATFORM','SACRED_HOUSE','SERVICE') NOT NULL,
	`sacred_house_id` int unsigned,
	`service_id` int unsigned,
	`sort_order` int NOT NULL DEFAULT 0,
	`active` boolean NOT NULL DEFAULT true,
	`created_by` bigint unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `spiritual_content_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `sci_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `sci_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `spiritual_content_versions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`content_item_id` int unsigned NOT NULL,
	`language` varchar(10) NOT NULL,
	`version_number` int unsigned NOT NULL,
	`title` varchar(200) NOT NULL,
	`body` text NOT NULL,
	`visibility_stage` enum('AFTER_CONFIRMATION','BEFORE_APPOINTMENT','AFTER_APPOINTMENT') NOT NULL DEFAULT 'AFTER_CONFIRMATION',
	`acknowledgement_required` boolean NOT NULL DEFAULT false,
	`allow_english_fallback` boolean NOT NULL DEFAULT false,
	`status` enum('DRAFT','UNDER_REVIEW','APPROVED','PUBLISHED','ARCHIVED') NOT NULL DEFAULT 'DRAFT',
	`created_by` bigint unsigned,
	`submitted_at` timestamp,
	`approved_by` bigint unsigned,
	`approved_at` timestamp,
	`published_by` bigint unsigned,
	`published_at` timestamp,
	`archived_at` timestamp,
	`review_note` varchar(500),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `spiritual_content_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `scv_item_lang_ver_unique` UNIQUE(`content_item_id`,`language`,`version_number`),
	CONSTRAINT `scv_id_item_unique` UNIQUE(`id`,`content_item_id`)
);
--> statement-breakpoint
ALTER TABLE `appointment_guidance_acknowledgements` ADD CONSTRAINT `agk_appt_fk` FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `appointment_guidance_acknowledgements` ADD CONSTRAINT `agk_version_fk` FOREIGN KEY (`content_version_id`) REFERENCES `spiritual_content_versions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `appointment_guidance_assignments` ADD CONSTRAINT `aga_appt_fk` FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `appointment_guidance_assignments` ADD CONSTRAINT `aga_ver_item_fk` FOREIGN KEY (`content_version_id`,`content_item_id`) REFERENCES `spiritual_content_versions`(`id`,`content_item_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `appointment_guidance_sets` ADD CONSTRAINT `ags_appt_fk` FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `spiritual_content_items` ADD CONSTRAINT `sci_house_fk` FOREIGN KEY (`sacred_house_id`) REFERENCES `sacred_houses`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `spiritual_content_items` ADD CONSTRAINT `sci_service_fk` FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `spiritual_content_items` ADD CONSTRAINT `sci_created_by_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `spiritual_content_versions` ADD CONSTRAINT `scv_item_fk` FOREIGN KEY (`content_item_id`) REFERENCES `spiritual_content_items`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `spiritual_content_versions` ADD CONSTRAINT `scv_created_by_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `spiritual_content_versions` ADD CONSTRAINT `scv_approved_by_fk` FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `spiritual_content_versions` ADD CONSTRAINT `scv_published_by_fk` FOREIGN KEY (`published_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `aga_version_idx` ON `appointment_guidance_assignments` (`content_version_id`);--> statement-breakpoint
CREATE INDEX `sci_type_idx` ON `spiritual_content_items` (`content_type`);--> statement-breakpoint
CREATE INDEX `sci_scope_idx` ON `spiritual_content_items` (`scope_type`);--> statement-breakpoint
CREATE INDEX `sci_house_idx` ON `spiritual_content_items` (`sacred_house_id`);--> statement-breakpoint
CREATE INDEX `sci_service_idx` ON `spiritual_content_items` (`service_id`);--> statement-breakpoint
CREATE INDEX `sci_active_idx` ON `spiritual_content_items` (`active`);--> statement-breakpoint
CREATE INDEX `scv_item_lang_status_idx` ON `spiritual_content_versions` (`content_item_id`,`language`,`status`);