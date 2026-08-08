CREATE TABLE `appointment_representatives` (
	`appointment_id` bigint unsigned NOT NULL,
	`sacred_house_member_id` int unsigned NOT NULL,
	`assignment_role` enum('PRIMARY','SUPPORT') NOT NULL,
	`assigned_by` bigint unsigned,
	`assigned_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `ar_pk` PRIMARY KEY(`appointment_id`,`sacred_house_member_id`)
);
--> statement-breakpoint
CREATE TABLE `appointments` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` varchar(36) NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`service_id` int unsigned NOT NULL,
	`sacred_house_id` int unsigned NOT NULL,
	`status` enum('PENDING_PAYMENT','CONFIRMED','CANCELLED','COMPLETED','NO_SHOW','EXPIRED') NOT NULL,
	`starts_at_utc` varchar(19) NOT NULL,
	`ends_at_utc` varchar(19) NOT NULL,
	`user_timezone` varchar(64) NOT NULL,
	`house_timezone` varchar(64) NOT NULL,
	`reservation_expires_at` varchar(19),
	`service_name_snapshot` varchar(150) NOT NULL,
	`service_code_snapshot` varchar(50) NOT NULL,
	`house_name_snapshot` varchar(150) NOT NULL,
	`duration_minutes_snapshot` int unsigned NOT NULL,
	`price_minor_snapshot` int unsigned NOT NULL,
	`currency_snapshot` varchar(3) NOT NULL,
	`private_request_note` varchar(1500),
	`cancelled_at` timestamp,
	`cancelled_by_user_id` bigint unsigned,
	`cancellation_reason` varchar(500),
	`completed_at` timestamp,
	`no_show_at` timestamp,
	`reschedule_count` int unsigned NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `appointments_id` PRIMARY KEY(`id`),
	CONSTRAINT `appt_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
CREATE TABLE `sacred_house_availability` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`sacred_house_id` int unsigned NOT NULL,
	`day_of_week` int unsigned NOT NULL,
	`start_local_time` time NOT NULL,
	`end_local_time` time NOT NULL,
	`active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sacred_house_availability_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sacred_house_availability_exceptions` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`sacred_house_id` int unsigned NOT NULL,
	`local_date` date NOT NULL,
	`type` enum('CLOSED','BLOCK','OPEN') NOT NULL,
	`start_local_time` time,
	`end_local_time` time,
	`label` varchar(200),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sacred_house_availability_exceptions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sacred_house_booking_settings` (
	`sacred_house_id` int unsigned NOT NULL,
	`scheduling_timezone` varchar(64) NOT NULL DEFAULT 'Africa/Lagos',
	`booking_enabled` boolean NOT NULL DEFAULT false,
	`slot_increment_minutes` int unsigned NOT NULL DEFAULT 30,
	`minimum_lead_minutes` int unsigned NOT NULL DEFAULT 1440,
	`maximum_advance_days` int unsigned NOT NULL DEFAULT 90,
	`reservation_hold_minutes` int unsigned NOT NULL DEFAULT 15,
	`cancellation_cutoff_minutes` int unsigned NOT NULL DEFAULT 1440,
	`reschedule_cutoff_minutes` int unsigned NOT NULL DEFAULT 1440,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sacred_house_booking_settings_sacred_house_id` PRIMARY KEY(`sacred_house_id`)
);
--> statement-breakpoint
ALTER TABLE `appointment_representatives` ADD CONSTRAINT `ar_appt_fk` FOREIGN KEY (`appointment_id`) REFERENCES `appointments`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `appointment_representatives` ADD CONSTRAINT `ar_member_fk` FOREIGN KEY (`sacred_house_member_id`) REFERENCES `sacred_house_members`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `appointment_representatives` ADD CONSTRAINT `ar_assigned_by_fk` FOREIGN KEY (`assigned_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `appointments` ADD CONSTRAINT `appt_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `appointments` ADD CONSTRAINT `appt_service_fk` FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `appointments` ADD CONSTRAINT `appt_house_fk` FOREIGN KEY (`sacred_house_id`) REFERENCES `sacred_houses`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `appointments` ADD CONSTRAINT `appt_cancelled_by_fk` FOREIGN KEY (`cancelled_by_user_id`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sacred_house_availability` ADD CONSTRAINT `sha_house_fk` FOREIGN KEY (`sacred_house_id`) REFERENCES `sacred_houses`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sacred_house_availability_exceptions` ADD CONSTRAINT `shae_house_fk` FOREIGN KEY (`sacred_house_id`) REFERENCES `sacred_houses`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sacred_house_booking_settings` ADD CONSTRAINT `shbs_house_fk` FOREIGN KEY (`sacred_house_id`) REFERENCES `sacred_houses`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `ar_member_idx` ON `appointment_representatives` (`sacred_house_member_id`);--> statement-breakpoint
CREATE INDEX `appt_house_start_idx` ON `appointments` (`sacred_house_id`,`starts_at_utc`);--> statement-breakpoint
CREATE INDEX `appt_user_start_idx` ON `appointments` (`user_id`,`starts_at_utc`);--> statement-breakpoint
CREATE INDEX `appt_status_idx` ON `appointments` (`status`);--> statement-breakpoint
CREATE INDEX `sha_house_day_idx` ON `sacred_house_availability` (`sacred_house_id`,`day_of_week`);--> statement-breakpoint
CREATE INDEX `shae_house_date_idx` ON `sacred_house_availability_exceptions` (`sacred_house_id`,`local_date`);