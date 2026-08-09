CREATE TABLE `sacred_content_version_profiles` (
	`content_version_id` bigint unsigned NOT NULL,
	`content_item_id` int unsigned NOT NULL,
	`variant_kind` enum('ORIGINAL','AUTHORIZED_ALTERNATE','TRANSLATION','TRANSLITERATION','GLOSS') NOT NULL DEFAULT 'ORIGINAL',
	`provenance_type` enum('ORIGINAL_AUTHORED','COMMISSIONED','TRADITIONAL_ORAL','LICENSED_SOURCE','DOCUMENTED_SOURCE') NOT NULL,
	`source_community` varchar(255),
	`source_place` varchar(255),
	`source_reference` varchar(1000),
	`public_attribution_text` varchar(500),
	`internal_provenance_note` varchar(2000),
	`digital_storage_authorized` boolean NOT NULL DEFAULT false,
	`theme_code` varchar(60),
	`duration_hint_seconds` int unsigned,
	`repeatable` boolean NOT NULL DEFAULT false,
	`voice_policy` enum('HUMAN_RECORDED_REQUIRED','APPROVED_TTS_ALLOWED','TEXT_ONLY') NOT NULL,
	`external_ai_policy` enum('NO_EXTERNAL_AI','METADATA_ONLY','APPROVED_TEXT_CONTEXT') NOT NULL DEFAULT 'METADATA_ONLY',
	`access_policy` enum('STAFF_ONLY','PRAYER_ROOM_PRIVATE','ARCHIVAL_RESTRICTED') NOT NULL DEFAULT 'STAFF_ONLY',
	`rights_status` enum('UNREVIEWED','PENDING_REVIEW','CLEARED','RESTRICTED','WITHDRAWN') NOT NULL DEFAULT 'UNREVIEWED',
	`rights_reviewed_by` bigint unsigned,
	`rights_reviewed_at` timestamp,
	`rights_note` varchar(1000),
	`runtime_enabled` boolean NOT NULL DEFAULT false,
	`content_sha256` varchar(64),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sacred_content_version_profiles_content_version_id` PRIMARY KEY(`content_version_id`)
);
--> statement-breakpoint
ALTER TABLE `spiritual_content_items` ADD `content_domain` enum('GUIDANCE','SACRED_RUNTIME') DEFAULT 'GUIDANCE' NOT NULL;--> statement-breakpoint
ALTER TABLE `sacred_content_version_profiles` ADD CONSTRAINT `scvp_ver_item_fk` FOREIGN KEY (`content_version_id`,`content_item_id`) REFERENCES `spiritual_content_versions`(`id`,`content_item_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sacred_content_version_profiles` ADD CONSTRAINT `scvp_rights_by_fk` FOREIGN KEY (`rights_reviewed_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `scvp_item_idx` ON `sacred_content_version_profiles` (`content_item_id`);--> statement-breakpoint
CREATE INDEX `scvp_rights_idx` ON `sacred_content_version_profiles` (`rights_status`);--> statement-breakpoint
CREATE INDEX `scvp_runtime_idx` ON `sacred_content_version_profiles` (`runtime_enabled`);--> statement-breakpoint
CREATE INDEX `scvp_access_idx` ON `sacred_content_version_profiles` (`access_policy`);--> statement-breakpoint
CREATE INDEX `scvp_theme_idx` ON `sacred_content_version_profiles` (`theme_code`);--> statement-breakpoint
CREATE INDEX `scvp_variant_idx` ON `sacred_content_version_profiles` (`variant_kind`);--> statement-breakpoint
CREATE INDEX `sci_domain_idx` ON `spiritual_content_items` (`content_domain`);