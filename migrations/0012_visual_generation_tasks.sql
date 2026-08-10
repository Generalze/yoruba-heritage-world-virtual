CREATE TABLE `prayer_generation_visual_tasks` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`generation_job_id` bigint unsigned NOT NULL,
	`manifest_snapshot_id` bigint unsigned NOT NULL,
	`task_id` varchar(100) NOT NULL,
	`scene_id` varchar(100) NOT NULL,
	`idempotency_key` varchar(64) NOT NULL,
	`status` enum('PENDING','SUBMITTED','PROCESSING','SUCCEEDED','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
	`attempt_count` int unsigned NOT NULL DEFAULT 0,
	`provider_code` varchar(40),
	`provider_operation_id` varchar(200),
	`artifact_sha256` varchar(64),
	`artifact_mime_type` varchar(100),
	`artifact_duration_ms` int unsigned,
	`artifact_storage_ref` varchar(255),
	`last_error_code` varchar(60),
	`last_error_message` varchar(500),
	`next_poll_at` timestamp,
	`submitted_at` timestamp,
	`completed_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `prayer_generation_visual_tasks_id` PRIMARY KEY(`id`),
	CONSTRAINT `pgvt_job_manifest_task_unique` UNIQUE(`generation_job_id`,`manifest_snapshot_id`,`task_id`),
	CONSTRAINT `pgvt_idempotency_unique` UNIQUE(`idempotency_key`)
);
--> statement-breakpoint
ALTER TABLE `prayer_generation_visual_tasks` ADD CONSTRAINT `pgvt_job_fk` FOREIGN KEY (`generation_job_id`) REFERENCES `prayer_generation_jobs`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_generation_visual_tasks` ADD CONSTRAINT `pgvt_manifest_fk` FOREIGN KEY (`manifest_snapshot_id`) REFERENCES `prayer_generation_manifest_snapshots`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `pgvt_status_idx` ON `prayer_generation_visual_tasks` (`status`);--> statement-breakpoint
CREATE INDEX `pgvt_poll_idx` ON `prayer_generation_visual_tasks` (`status`,`next_poll_at`);