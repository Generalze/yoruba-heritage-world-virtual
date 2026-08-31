CREATE TABLE `visual_bible_reference_media` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`visual_bible_version_id` bigint unsigned NOT NULL,
	`media_asset_version_id` bigint unsigned NOT NULL,
	`role` enum('WIDE_MASTER','MEDIUM_PRAYER','DIRECT_CAMERA','SIDE_PRAYER','WORKING_DETAIL','ENVIRONMENT_INSERT') NOT NULL,
	`media_file_sha256` varchar(64) NOT NULL,
	`bound_by` bigint unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `visual_bible_reference_media_id` PRIMARY KEY(`id`),
	CONSTRAINT `vbrm_version_role_unique` UNIQUE(`visual_bible_version_id`,`role`)
);
--> statement-breakpoint
ALTER TABLE `prayer_session_template_slots` ADD `shot_family` enum('WIDE_MASTER','MEDIUM_PRAYER','DIRECT_CAMERA','SIDE_PRAYER','WORKING_DETAIL','ENVIRONMENT_INSERT');--> statement-breakpoint
ALTER TABLE `prayer_session_template_slots` ADD `reference_requirement` enum('REQUIRED','OPTIONAL');--> statement-breakpoint
ALTER TABLE `visual_bible_versions` ADD `reference_mode` enum('TEXT_ONLY','IMAGE_REFERENCE_REQUIRED') DEFAULT 'TEXT_ONLY' NOT NULL;--> statement-breakpoint
ALTER TABLE `visual_bible_reference_media` ADD CONSTRAINT `vbrm_version_fk` FOREIGN KEY (`visual_bible_version_id`) REFERENCES `visual_bible_versions`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visual_bible_reference_media` ADD CONSTRAINT `vbrm_media_fk` FOREIGN KEY (`media_asset_version_id`) REFERENCES `media_asset_versions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `visual_bible_reference_media` ADD CONSTRAINT `vbrm_bound_by_fk` FOREIGN KEY (`bound_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `vbrm_media_idx` ON `visual_bible_reference_media` (`media_asset_version_id`);