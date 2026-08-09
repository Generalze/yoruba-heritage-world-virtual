CREATE TABLE `prayer_generation_manifest_snapshots` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`generation_job_id` bigint unsigned NOT NULL,
	`storyboard_snapshot_id` bigint unsigned NOT NULL,
	`snapshot_number` int unsigned NOT NULL,
	`manifest_json_text` text NOT NULL,
	`payload_sha256` varchar(64) NOT NULL,
	`manifest_sha256` varchar(64) NOT NULL,
	`visual_task_count` int unsigned NOT NULL,
	`audio_requirement_count` int unsigned NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `prayer_generation_manifest_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `pgms_job_num_unique` UNIQUE(`generation_job_id`,`snapshot_number`)
);
--> statement-breakpoint
CREATE TABLE `prayer_generation_storyboard_snapshots` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`generation_job_id` bigint unsigned NOT NULL,
	`recipe_snapshot_id` bigint unsigned NOT NULL,
	`snapshot_number` int unsigned NOT NULL,
	`storyboard_json_text` text NOT NULL,
	`payload_sha256` varchar(64) NOT NULL,
	`storyboard_sha256` varchar(64) NOT NULL,
	`scene_count` int unsigned NOT NULL,
	`total_duration_ms` int unsigned NOT NULL,
	`visual_bible_version_id` bigint unsigned,
	`visual_bible_definition_sha256` varchar(64),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `prayer_generation_storyboard_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `pgss_job_num_unique` UNIQUE(`generation_job_id`,`snapshot_number`)
);
--> statement-breakpoint
ALTER TABLE `prayer_generation_manifest_snapshots` ADD CONSTRAINT `pgms_job_fk` FOREIGN KEY (`generation_job_id`) REFERENCES `prayer_generation_jobs`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_generation_manifest_snapshots` ADD CONSTRAINT `pgms_storyboard_fk` FOREIGN KEY (`storyboard_snapshot_id`) REFERENCES `prayer_generation_storyboard_snapshots`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_generation_storyboard_snapshots` ADD CONSTRAINT `pgss_job_fk` FOREIGN KEY (`generation_job_id`) REFERENCES `prayer_generation_jobs`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_generation_storyboard_snapshots` ADD CONSTRAINT `pgss_recipe_fk` FOREIGN KEY (`recipe_snapshot_id`) REFERENCES `prayer_generation_recipe_snapshots`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `pgms_storyboard_idx` ON `prayer_generation_manifest_snapshots` (`storyboard_snapshot_id`);--> statement-breakpoint
CREATE INDEX `pgss_recipe_idx` ON `prayer_generation_storyboard_snapshots` (`recipe_snapshot_id`);