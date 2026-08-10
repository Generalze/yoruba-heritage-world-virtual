CREATE TABLE `prayer_generation_uploads` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`generation_job_id` bigint unsigned NOT NULL,
	`render_result_id` bigint unsigned NOT NULL,
	`render_plan_snapshot_id` bigint unsigned NOT NULL,
	`render_plan_sha256` varchar(64) NOT NULL,
	`idempotency_key` varchar(64) NOT NULL,
	`provider_code` varchar(40) NOT NULL,
	`provider_is_local` int unsigned NOT NULL DEFAULT 0,
	`object_key` varchar(255) NOT NULL,
	`artifact_sha256` varchar(64) NOT NULL,
	`artifact_mime_type` varchar(100) NOT NULL,
	`artifact_duration_ms` int unsigned NOT NULL,
	`byte_size` int unsigned NOT NULL,
	`provider_etag` varchar(200),
	`provider_version_id` varchar(200),
	`status` enum('PENDING','UPLOADING','SUCCEEDED','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
	`attempt_count` int unsigned NOT NULL DEFAULT 0,
	`last_error_code` varchar(60),
	`last_error_message` varchar(500),
	`started_at` timestamp,
	`completed_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `prayer_generation_uploads_id` PRIMARY KEY(`id`),
	CONSTRAINT `pgu_job_result_unique` UNIQUE(`generation_job_id`,`render_result_id`),
	CONSTRAINT `pgu_idempotency_unique` UNIQUE(`idempotency_key`),
	CONSTRAINT `pgu_object_key_unique` UNIQUE(`object_key`)
);
--> statement-breakpoint
ALTER TABLE `prayer_generation_uploads` ADD CONSTRAINT `pgu_job_fk` FOREIGN KEY (`generation_job_id`) REFERENCES `prayer_generation_jobs`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `prayer_generation_uploads` ADD CONSTRAINT `pgu_result_fk` FOREIGN KEY (`render_result_id`) REFERENCES `prayer_generation_render_results`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `pgu_status_idx` ON `prayer_generation_uploads` (`status`);