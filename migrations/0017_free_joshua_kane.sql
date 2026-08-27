CREATE TABLE `notification_deliveries` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`notification_id` bigint unsigned NOT NULL,
	`channel` enum('IN_APP','EMAIL') NOT NULL,
	`status` enum('PENDING','SENT','FAILED','SUPPRESSED') NOT NULL DEFAULT 'PENDING',
	`attempts` bigint unsigned NOT NULL DEFAULT 0,
	`last_error` varchar(300),
	`sent_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `notification_deliveries_id` PRIMARY KEY(`id`),
	CONSTRAINT `nd_ntf_channel_unique` UNIQUE(`notification_id`,`channel`)
);
--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`category` enum('APPOINTMENT','PRAYER_ROOM','PAYMENT') NOT NULL,
	`in_app_enabled` boolean NOT NULL DEFAULT true,
	`email_enabled` boolean NOT NULL DEFAULT true,
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `notification_preferences_id` PRIMARY KEY(`id`),
	CONSTRAINT `np_user_category_unique` UNIQUE(`user_id`,`category`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` varchar(36) NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`category` enum('APPOINTMENT','PRAYER_ROOM','PAYMENT') NOT NULL,
	`type` enum('APPOINTMENT_CONFIRMED','APPOINTMENT_CANCELLED','APPOINTMENT_RESCHEDULED','APPOINTMENT_EXPIRED','PRAYER_ROOM_READY','PAYMENT_SUCCEEDED','PAYMENT_UNDER_REVIEW') NOT NULL,
	`title` varchar(200) NOT NULL,
	`body` varchar(500) NOT NULL,
	`link_public_id` varchar(36),
	`read_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`),
	CONSTRAINT `ntf_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
ALTER TABLE `notification_deliveries` ADD CONSTRAINT `nd_ntf_fk` FOREIGN KEY (`notification_id`) REFERENCES `notifications`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notification_preferences` ADD CONSTRAINT `np_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notifications` ADD CONSTRAINT `ntf_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `nd_status_idx` ON `notification_deliveries` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `ntf_user_created_idx` ON `notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ntf_user_read_idx` ON `notifications` (`user_id`,`read_at`);