CREATE TABLE `prayer_generation_render_plans` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`generation_job_id` bigint unsigned NOT NULL,
	`manifest_snapshot_id` bigint unsigned NOT NULL,
	`snapshot_number` int unsigned NOT NULL,
	`plan_json_text` text NOT NULL,
	`payload_sha256` varchar(64) NOT NULL,
	`render_plan_sha256` varchar(64) NOT NULL,
	`manifest_sha256` varchar(64) NOT NULL,
	`scene_count` int unsigned NOT NULL,
	`audio_segment_count` int unsigned NOT NULL,
	`total_duration_ms` int unsigned NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `prayer_generation_render_plans_id` PRIMARY KEY(`id`),
	CONSTRAINT `pgrp_job_num_unique` UNIQUE(`generation_job_id`,`snapshot_number`)
);
--> statement-breakpoint
CREATE TABLE `prayer_generation_render_results` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`generation_job_id` bigint unsigned NOT NULL,
	`manifest_snapshot_id` bigint unsigned NOT NULL,
	`render_plan_snapshot_id` bigint unsigned NOT NULL,
	`idempotency_key` varchar(64) NOT NULL,
	`renderer_code` varchar(40) NOT NULL,
	`renderer_version` varchar(40) NOT NULL,
	`renderer_is_mock` int unsigned NOT NULL DEFAULT 0,
	`status` enum('PENDING','RUNNING','SUCCEEDED','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
	`attempt_count` int unsigned NOT NULL DEFAULT 0,
	`render_plan_sha256` varchar(64) NOT NULL,
	`artifact_sha256` varchar(64),
	`artifact_mime_type` varchar(100),
	`artifact_duration_ms` int unsigned,
	`artifact_storage_ref` varchar(255),
	`last_error_code` varchar(60),
	`last_error_message` varchar(500),
	`started_at` timestamp,
	`completed_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `prayer_generation_render_results_id` PRIMARY KEY(`id`),
	CONSTRAINT `pgrr_job_manifest_plan_unique` UNIQUE(`generation_job_id`,`manifest_snapshot_id`,`render_plan_snapshot_id`),
	CONSTRAINT `pgrr_idempotency_unique` UNIQUE(`idempotency_key`)
);
--> statement-breakpoint
ALTER TABLE `prayer_generation_render_plans` ADD CONSTRAINT `pgrp_job_fk` FOREIGN KEY (`generation_job_id`) REFERENCES `prayer_generation_jobs`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_generation_render_plans` ADD CONSTRAINT `pgrp_manifest_fk` FOREIGN KEY (`manifest_snapshot_id`) REFERENCES `prayer_generation_manifest_snapshots`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_generation_render_results` ADD CONSTRAINT `pgrr_job_fk` FOREIGN KEY (`generation_job_id`) REFERENCES `prayer_generation_jobs`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_generation_render_results` ADD CONSTRAINT `pgrr_manifest_fk` FOREIGN KEY (`manifest_snapshot_id`) REFERENCES `prayer_generation_manifest_snapshots`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_generation_render_results` ADD CONSTRAINT `pgrr_plan_fk` FOREIGN KEY (`render_plan_snapshot_id`) REFERENCES `prayer_generation_render_plans`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `pgrp_manifest_idx` ON `prayer_generation_render_plans` (`manifest_snapshot_id`);--> statement-breakpoint
CREATE INDEX `pgrp_hash_idx` ON `prayer_generation_render_plans` (`generation_job_id`,`render_plan_sha256`);--> statement-breakpoint
CREATE INDEX `pgrr_status_idx` ON `prayer_generation_render_results` (`status`);