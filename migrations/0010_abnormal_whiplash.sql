CREATE TABLE `prayer_generation_job_events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`generation_job_id` bigint unsigned NOT NULL,
	`from_status` enum('QUEUED','PREPARING','STORYBOARDING','GENERATING_VISUALS','GENERATING_AUDIO','RENDERING','UPLOADING','READY','RETRYING','FAILED','CANCELLED'),
	`to_status` enum('QUEUED','PREPARING','STORYBOARDING','GENERATING_VISUALS','GENERATING_AUDIO','RENDERING','UPLOADING','READY','RETRYING','FAILED','CANCELLED') NOT NULL,
	`event_code` varchar(60) NOT NULL,
	`attempt_number` int unsigned NOT NULL DEFAULT 0,
	`detail_code` varchar(100),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `prayer_generation_job_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `prayer_generation_jobs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` varchar(36) NOT NULL,
	`appointment_id` bigint unsigned NOT NULL,
	`service_id_snapshot` int unsigned NOT NULL,
	`sacred_house_id_snapshot` int unsigned NOT NULL,
	`language_snapshot` enum('en','yo') NOT NULL,
	`variation_seed` varchar(64) NOT NULL,
	`status` enum('QUEUED','PREPARING','STORYBOARDING','GENERATING_VISUALS','GENERATING_AUDIO','RENDERING','UPLOADING','READY','RETRYING','FAILED','CANCELLED') NOT NULL DEFAULT 'QUEUED',
	`attempt_count` int unsigned NOT NULL DEFAULT 0,
	`max_attempts` int unsigned NOT NULL DEFAULT 5,
	`resume_status` enum('QUEUED','PREPARING','STORYBOARDING','GENERATING_VISUALS','GENERATING_AUDIO','RENDERING','UPLOADING','READY','RETRYING','FAILED','CANCELLED'),
	`next_attempt_at` timestamp,
	`lease_token` varchar(36),
	`lease_owner` varchar(100),
	`lease_acquired_at` timestamp,
	`lease_expires_at` timestamp,
	`last_error_code` varchar(60),
	`last_error_message` varchar(500),
	`prepared_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `prayer_generation_jobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `pgj_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `pgj_appointment_unique` UNIQUE(`appointment_id`)
);
--> statement-breakpoint
CREATE TABLE `prayer_generation_recipe_snapshots` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`generation_job_id` bigint unsigned NOT NULL,
	`snapshot_number` int unsigned NOT NULL,
	`recipe_json_text` text NOT NULL,
	`payload_sha256` varchar(64) NOT NULL,
	`recipe_sha256` varchar(64) NOT NULL,
	`template_version_id` bigint unsigned NOT NULL,
	`template_definition_sha256` varchar(64) NOT NULL,
	`visual_bible_version_id` bigint unsigned,
	`visual_bible_definition_sha256` varchar(64),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `prayer_generation_recipe_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `pgrs_job_num_unique` UNIQUE(`generation_job_id`,`snapshot_number`)
);
--> statement-breakpoint
ALTER TABLE `prayer_generation_job_events` ADD CONSTRAINT `pgje_job_fk` FOREIGN KEY (`generation_job_id`) REFERENCES `prayer_generation_jobs`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_generation_jobs` ADD CONSTRAINT `pgj_appointment_fk` FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_generation_recipe_snapshots` ADD CONSTRAINT `pgrs_job_fk` FOREIGN KEY (`generation_job_id`) REFERENCES `prayer_generation_jobs`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `pgje_job_idx` ON `prayer_generation_job_events` (`generation_job_id`);--> statement-breakpoint
CREATE INDEX `pgj_status_idx` ON `prayer_generation_jobs` (`status`);--> statement-breakpoint
CREATE INDEX `pgj_due_idx` ON `prayer_generation_jobs` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `pgj_lease_idx` ON `prayer_generation_jobs` (`lease_expires_at`);