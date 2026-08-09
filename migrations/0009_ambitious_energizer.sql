CREATE TABLE `media_asset_versions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`asset_id` int unsigned NOT NULL,
	`version_number` int unsigned NOT NULL,
	`status` enum('DRAFT','UNDER_REVIEW','APPROVED','PUBLISHED','ARCHIVED') NOT NULL DEFAULT 'DRAFT',
	`source_type` enum('HUMAN_RECORDED','IN_HOUSE','LICENSED','AI_GENERATED','OPENART_CREATED','KLING_GENERATED') NOT NULL,
	`language` enum('en','yo'),
	`mime_type` varchar(100) NOT NULL,
	`byte_size` int unsigned NOT NULL,
	`duration_seconds` int unsigned,
	`width` int unsigned,
	`height` int unsigned,
	`storage_key` varchar(255) NOT NULL,
	`file_sha256` varchar(64) NOT NULL,
	`rights_status` enum('UNREVIEWED','PENDING_REVIEW','CLEARED','RESTRICTED','WITHDRAWN') NOT NULL DEFAULT 'UNREVIEWED',
	`rights_reviewed_by` bigint unsigned,
	`rights_reviewed_at` timestamp,
	`rights_note` varchar(1000),
	`contains_identifiable_person` boolean NOT NULL DEFAULT false,
	`consent_status` enum('NOT_APPLICABLE','PENDING','GRANTED','WITHDRAWN') NOT NULL DEFAULT 'NOT_APPLICABLE',
	`consent_reference` varchar(500),
	`external_ai_policy` enum('NO_EXTERNAL_AI','REFERENCE_ONLY','DERIVATIVE_GENERATION_ALLOWED') NOT NULL DEFAULT 'NO_EXTERNAL_AI',
	`voice_clone_authorized` boolean NOT NULL DEFAULT false,
	`runtime_enabled` boolean NOT NULL DEFAULT false,
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
	CONSTRAINT `media_asset_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `mav_asset_ver_unique` UNIQUE(`asset_id`,`version_number`),
	CONSTRAINT `mav_storage_key_unique` UNIQUE(`storage_key`)
);
--> statement-breakpoint
CREATE TABLE `media_assets` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`public_id` varchar(36) NOT NULL,
	`code` varchar(60) NOT NULL,
	`asset_kind` enum('AUDIO','IMAGE','VIDEO') NOT NULL,
	`scope_type` enum('PLATFORM','SACRED_HOUSE','SERVICE') NOT NULL,
	`sacred_house_id` int unsigned,
	`service_id` int unsigned,
	`content_type` varchar(40),
	`theme_code` varchar(60),
	`active` boolean NOT NULL DEFAULT true,
	`created_by` bigint unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `media_assets_id` PRIMARY KEY(`id`),
	CONSTRAINT `ma_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `ma_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `sacred_content_media_links` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`content_version_id` bigint unsigned NOT NULL,
	`media_asset_version_id` bigint unsigned NOT NULL,
	`role` enum('PRIMARY_AUDIO','ALTERNATE_AUDIO','VISUAL_REFERENCE') NOT NULL,
	`sort_order` int NOT NULL DEFAULT 0,
	`created_by` bigint unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sacred_content_media_links_id` PRIMARY KEY(`id`),
	CONSTRAINT `scml_unique` UNIQUE(`content_version_id`,`media_asset_version_id`,`role`)
);
--> statement-breakpoint
CREATE TABLE `visual_bible_rules` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`bible_version_id` bigint unsigned NOT NULL,
	`category` enum('ENVIRONMENT','ARCHITECTURE','NATURAL_SETTING','COLOR','SYMBOL','CLOTHING','CEREMONIAL_OBJECT','CHARACTER_CONSTRAINT','CAMERA','LIGHTING','MOVEMENT','ATMOSPHERE','PROHIBITED_IMAGERY','PROHIBITED_SYMBOL','PROHIBITED_COMBINATION','NEGATIVE_PROMPT_GUIDANCE') NOT NULL,
	`position` int unsigned NOT NULL,
	`rule_text` varchar(2000) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `visual_bible_rules_id` PRIMARY KEY(`id`),
	CONSTRAINT `vbr_ver_pos_unique` UNIQUE(`bible_version_id`,`position`)
);
--> statement-breakpoint
CREATE TABLE `visual_bible_versions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`visual_bible_id` int unsigned NOT NULL,
	`version_number` int unsigned NOT NULL,
	`status` enum('DRAFT','UNDER_REVIEW','APPROVED','PUBLISHED','ARCHIVED') NOT NULL DEFAULT 'DRAFT',
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
	CONSTRAINT `visual_bible_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `vbv_bible_ver_unique` UNIQUE(`visual_bible_id`,`version_number`)
);
--> statement-breakpoint
CREATE TABLE `visual_bibles` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`public_id` varchar(36) NOT NULL,
	`sacred_house_id` int unsigned NOT NULL,
	`active` boolean NOT NULL DEFAULT true,
	`created_by` bigint unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `visual_bibles_id` PRIMARY KEY(`id`),
	CONSTRAINT `vb_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `vb_house_unique` UNIQUE(`sacred_house_id`)
);
--> statement-breakpoint
ALTER TABLE `media_asset_versions` ADD CONSTRAINT `mav_asset_fk` FOREIGN KEY (`asset_id`) REFERENCES `media_assets`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_asset_versions` ADD CONSTRAINT `mav_created_by_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_asset_versions` ADD CONSTRAINT `mav_approved_by_fk` FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_asset_versions` ADD CONSTRAINT `mav_published_by_fk` FOREIGN KEY (`published_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_asset_versions` ADD CONSTRAINT `mav_rights_by_fk` FOREIGN KEY (`rights_reviewed_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_assets` ADD CONSTRAINT `ma_house_fk` FOREIGN KEY (`sacred_house_id`) REFERENCES `sacred_houses`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_assets` ADD CONSTRAINT `ma_service_fk` FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `media_assets` ADD CONSTRAINT `ma_created_by_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sacred_content_media_links` ADD CONSTRAINT `scml_content_fk` FOREIGN KEY (`content_version_id`) REFERENCES `spiritual_content_versions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sacred_content_media_links` ADD CONSTRAINT `scml_media_fk` FOREIGN KEY (`media_asset_version_id`) REFERENCES `media_asset_versions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sacred_content_media_links` ADD CONSTRAINT `scml_created_by_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visual_bible_rules` ADD CONSTRAINT `vbr_version_fk` FOREIGN KEY (`bible_version_id`) REFERENCES `visual_bible_versions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visual_bible_versions` ADD CONSTRAINT `vbv_bible_fk` FOREIGN KEY (`visual_bible_id`) REFERENCES `visual_bibles`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visual_bible_versions` ADD CONSTRAINT `vbv_created_by_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visual_bible_versions` ADD CONSTRAINT `vbv_approved_by_fk` FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visual_bible_versions` ADD CONSTRAINT `vbv_published_by_fk` FOREIGN KEY (`published_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visual_bibles` ADD CONSTRAINT `vb_house_fk` FOREIGN KEY (`sacred_house_id`) REFERENCES `sacred_houses`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visual_bibles` ADD CONSTRAINT `vb_created_by_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `mav_asset_status_idx` ON `media_asset_versions` (`asset_id`,`status`);--> statement-breakpoint
CREATE INDEX `mav_rights_idx` ON `media_asset_versions` (`rights_status`);--> statement-breakpoint
CREATE INDEX `mav_runtime_idx` ON `media_asset_versions` (`runtime_enabled`);--> statement-breakpoint
CREATE INDEX `mav_consent_idx` ON `media_asset_versions` (`consent_status`);--> statement-breakpoint
CREATE INDEX `ma_kind_idx` ON `media_assets` (`asset_kind`);--> statement-breakpoint
CREATE INDEX `ma_scope_idx` ON `media_assets` (`scope_type`);--> statement-breakpoint
CREATE INDEX `ma_house_idx` ON `media_assets` (`sacred_house_id`);--> statement-breakpoint
CREATE INDEX `ma_service_idx` ON `media_assets` (`service_id`);--> statement-breakpoint
CREATE INDEX `ma_type_idx` ON `media_assets` (`content_type`);--> statement-breakpoint
CREATE INDEX `ma_theme_idx` ON `media_assets` (`theme_code`);--> statement-breakpoint
CREATE INDEX `ma_active_idx` ON `media_assets` (`active`);--> statement-breakpoint
CREATE INDEX `scml_media_idx` ON `sacred_content_media_links` (`media_asset_version_id`);--> statement-breakpoint
CREATE INDEX `vbr_category_idx` ON `visual_bible_rules` (`category`);--> statement-breakpoint
CREATE INDEX `vbv_bible_status_idx` ON `visual_bible_versions` (`visual_bible_id`,`status`);