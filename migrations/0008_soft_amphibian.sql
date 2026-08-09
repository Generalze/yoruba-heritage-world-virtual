CREATE TABLE `prayer_session_template_slots` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`template_version_id` bigint unsigned NOT NULL,
	`slot_key` varchar(60) NOT NULL,
	`position` int unsigned NOT NULL,
	`slot_kind` enum('CONTENT','SILENCE') NOT NULL,
	`min_select` int unsigned NOT NULL DEFAULT 1,
	`max_select` int unsigned NOT NULL DEFAULT 1,
	`content_type` varchar(40),
	`selector_mode` enum('PINNED_VERSIONS','ELIGIBLE_FILTER'),
	`theme_code` varchar(60),
	`variant_kind` enum('ORIGINAL','AUTHORIZED_ALTERNATE','TRANSLATION','TRANSLITERATION','GLOSS'),
	`silence_duration_seconds` int unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `prayer_session_template_slots_id` PRIMARY KEY(`id`),
	CONSTRAINT `psts_ver_key_unique` UNIQUE(`template_version_id`,`slot_key`),
	CONSTRAINT `psts_ver_pos_unique` UNIQUE(`template_version_id`,`position`)
);
--> statement-breakpoint
CREATE TABLE `prayer_session_template_versions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`template_id` int unsigned NOT NULL,
	`language` enum('en','yo') NOT NULL,
	`version_number` int unsigned NOT NULL,
	`status` enum('DRAFT','UNDER_REVIEW','APPROVED','PUBLISHED','ARCHIVED') NOT NULL DEFAULT 'DRAFT',
	`priority` int NOT NULL DEFAULT 0,
	`selection_weight` int unsigned NOT NULL DEFAULT 1,
	`target_min_seconds` int unsigned NOT NULL,
	`target_max_seconds` int unsigned NOT NULL,
	`definition_sha256` varchar(64),
	`created_by` bigint unsigned,
	`submitted_at` timestamp,
	`review_note` varchar(500),
	`approved_by` bigint unsigned,
	`approved_at` timestamp,
	`published_by` bigint unsigned,
	`published_at` timestamp,
	`archived_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `prayer_session_template_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `pstv_tpl_lang_ver_unique` UNIQUE(`template_id`,`language`,`version_number`)
);
--> statement-breakpoint
CREATE TABLE `prayer_session_templates` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`public_id` varchar(36) NOT NULL,
	`code` varchar(60) NOT NULL,
	`scope_type` enum('PLATFORM','SACRED_HOUSE','SERVICE') NOT NULL,
	`sacred_house_id` int unsigned,
	`service_id` int unsigned,
	`active` boolean NOT NULL DEFAULT true,
	`created_by` bigint unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `prayer_session_templates_id` PRIMARY KEY(`id`),
	CONSTRAINT `pst_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `pst_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `prayer_template_forbidden_pairs` (
	`template_version_id` bigint unsigned NOT NULL,
	`content_item_id_a` int unsigned NOT NULL,
	`content_item_id_b` int unsigned NOT NULL,
	CONSTRAINT `ptfp_pk` PRIMARY KEY(`template_version_id`,`content_item_id_a`,`content_item_id_b`)
);
--> statement-breakpoint
CREATE TABLE `prayer_template_slot_pins` (
	`slot_id` bigint unsigned NOT NULL,
	`content_version_id` bigint unsigned NOT NULL,
	`pin_order` int unsigned NOT NULL DEFAULT 0,
	CONSTRAINT `ptsp_pk` PRIMARY KEY(`slot_id`,`content_version_id`)
);
--> statement-breakpoint
CREATE TABLE `prayer_template_slot_scopes` (
	`slot_id` bigint unsigned NOT NULL,
	`scope_type` enum('PLATFORM','SACRED_HOUSE','SERVICE') NOT NULL,
	CONSTRAINT `ptss_pk` PRIMARY KEY(`slot_id`,`scope_type`)
);
--> statement-breakpoint
ALTER TABLE `prayer_session_template_slots` ADD CONSTRAINT `psts_version_fk` FOREIGN KEY (`template_version_id`) REFERENCES `prayer_session_template_versions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_session_template_versions` ADD CONSTRAINT `pstv_template_fk` FOREIGN KEY (`template_id`) REFERENCES `prayer_session_templates`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_session_template_versions` ADD CONSTRAINT `pstv_created_by_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_session_template_versions` ADD CONSTRAINT `pstv_approved_by_fk` FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_session_template_versions` ADD CONSTRAINT `pstv_published_by_fk` FOREIGN KEY (`published_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_session_templates` ADD CONSTRAINT `pst_house_fk` FOREIGN KEY (`sacred_house_id`) REFERENCES `sacred_houses`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_session_templates` ADD CONSTRAINT `pst_service_fk` FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_session_templates` ADD CONSTRAINT `pst_created_by_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_template_forbidden_pairs` ADD CONSTRAINT `ptfp_version_fk` FOREIGN KEY (`template_version_id`) REFERENCES `prayer_session_template_versions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_template_forbidden_pairs` ADD CONSTRAINT `ptfp_item_a_fk` FOREIGN KEY (`content_item_id_a`) REFERENCES `spiritual_content_items`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_template_forbidden_pairs` ADD CONSTRAINT `ptfp_item_b_fk` FOREIGN KEY (`content_item_id_b`) REFERENCES `spiritual_content_items`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_template_slot_pins` ADD CONSTRAINT `ptsp_slot_fk` FOREIGN KEY (`slot_id`) REFERENCES `prayer_session_template_slots`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_template_slot_pins` ADD CONSTRAINT `ptsp_content_fk` FOREIGN KEY (`content_version_id`) REFERENCES `spiritual_content_versions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_template_slot_scopes` ADD CONSTRAINT `ptss_slot_fk` FOREIGN KEY (`slot_id`) REFERENCES `prayer_session_template_slots`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `pstv_tpl_lang_status_idx` ON `prayer_session_template_versions` (`template_id`,`language`,`status`);--> statement-breakpoint
CREATE INDEX `pst_scope_idx` ON `prayer_session_templates` (`scope_type`);--> statement-breakpoint
CREATE INDEX `pst_house_idx` ON `prayer_session_templates` (`sacred_house_id`);--> statement-breakpoint
CREATE INDEX `pst_service_idx` ON `prayer_session_templates` (`service_id`);--> statement-breakpoint
CREATE INDEX `pst_active_idx` ON `prayer_session_templates` (`active`);--> statement-breakpoint
CREATE INDEX `ptsp_version_idx` ON `prayer_template_slot_pins` (`content_version_id`);