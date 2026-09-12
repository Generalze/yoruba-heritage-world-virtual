CREATE TABLE `appointment_prayer_room_media` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`appointment_id` bigint unsigned NOT NULL,
	`uploaded_by` bigint unsigned,
	`status` enum('ACTIVE','REVOKED') NOT NULL DEFAULT 'ACTIVE',
	`provider_code` varchar(40) NOT NULL,
	`provider_is_local` int unsigned NOT NULL DEFAULT 0,
	`object_key` varchar(255) NOT NULL,
	`file_sha256` varchar(64) NOT NULL,
	`mime_type` varchar(100) NOT NULL,
	`byte_size` int unsigned NOT NULL,
	`duration_seconds` int unsigned,
	`provider_etag` varchar(200),
	`provider_version_id` varchar(200),
	`admin_note` varchar(500),
	`uploaded_at` timestamp NOT NULL DEFAULT (now()),
	`revoked_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `appointment_prayer_room_media_id` PRIMARY KEY(`id`),
	CONSTRAINT `aprm_appointment_unique` UNIQUE(`appointment_id`),
	CONSTRAINT `aprm_object_key_unique` UNIQUE(`object_key`)
);
--> statement-breakpoint
ALTER TABLE `appointment_prayer_room_media` ADD CONSTRAINT `aprm_appointment_fk` FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `appointment_prayer_room_media` ADD CONSTRAINT `aprm_uploaded_by_fk` FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `aprm_status_idx` ON `appointment_prayer_room_media` (`status`);
