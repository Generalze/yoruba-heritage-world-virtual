CREATE TABLE `subscription_content` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`plan_id` int unsigned NOT NULL,
	`scheduled_date` date NOT NULL,
	`content_item_id` int unsigned NOT NULL,
	`content_version_id` bigint unsigned NOT NULL,
	`scheduled_by` bigint unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `subscription_content_id` PRIMARY KEY(`id`),
	CONSTRAINT `subc_plan_date_unique` UNIQUE(`plan_id`,`scheduled_date`)
);
--> statement-breakpoint
CREATE TABLE `subscription_history` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`subscription_id` bigint unsigned NOT NULL,
	`delivered_date` date NOT NULL,
	`content_item_id` int unsigned NOT NULL,
	`content_version_id` bigint unsigned NOT NULL,
	`delivered_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `subscription_history_id` PRIMARY KEY(`id`),
	CONSTRAINT `subh_sub_date_unique` UNIQUE(`subscription_id`,`delivered_date`)
);
--> statement-breakpoint
CREATE TABLE `subscription_plans` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`public_id` varchar(36) NOT NULL,
	`code` varchar(60) NOT NULL,
	`name` varchar(200) NOT NULL,
	`description` text,
	`term_days` int unsigned NOT NULL,
	`price_minor` int unsigned,
	`currency` varchar(3),
	`active` boolean NOT NULL DEFAULT false,
	`created_by` bigint unsigned,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `subscription_plans_id` PRIMARY KEY(`id`),
	CONSTRAINT `sp_public_id_unique` UNIQUE(`public_id`),
	CONSTRAINT `sp_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`public_id` varchar(36) NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`plan_id` int unsigned NOT NULL,
	`plan_name_snapshot` varchar(200) NOT NULL,
	`term_days_snapshot` int unsigned NOT NULL,
	`price_minor_snapshot` int unsigned,
	`currency_snapshot` varchar(3),
	`user_timezone_snapshot` varchar(64) NOT NULL,
	`status` enum('PENDING_PAYMENT','ACTIVE','EXPIRED','CANCELLED') NOT NULL DEFAULT 'PENDING_PAYMENT',
	`start_date` date NOT NULL,
	`end_date` date NOT NULL,
	`activated_at` timestamp,
	`cancelled_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `subscriptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `sub_public_id_unique` UNIQUE(`public_id`)
);
--> statement-breakpoint
ALTER TABLE `subscription_content` ADD CONSTRAINT `subc_plan_fk` FOREIGN KEY (`plan_id`) REFERENCES `subscription_plans`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscription_content` ADD CONSTRAINT `subc_ver_item_fk` FOREIGN KEY (`content_version_id`,`content_item_id`) REFERENCES `spiritual_content_versions`(`id`,`content_item_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscription_content` ADD CONSTRAINT `subc_by_fk` FOREIGN KEY (`scheduled_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscription_history` ADD CONSTRAINT `subh_sub_fk` FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscription_history` ADD CONSTRAINT `subh_ver_item_fk` FOREIGN KEY (`content_version_id`,`content_item_id`) REFERENCES `spiritual_content_versions`(`id`,`content_item_id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscription_plans` ADD CONSTRAINT `sp_created_by_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD CONSTRAINT `sub_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `subscriptions` ADD CONSTRAINT `sub_plan_fk` FOREIGN KEY (`plan_id`) REFERENCES `subscription_plans`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `subc_version_idx` ON `subscription_content` (`content_version_id`);--> statement-breakpoint
CREATE INDEX `subh_version_idx` ON `subscription_history` (`content_version_id`);--> statement-breakpoint
CREATE INDEX `sp_active_idx` ON `subscription_plans` (`active`);--> statement-breakpoint
CREATE INDEX `sub_user_status_idx` ON `subscriptions` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `sub_window_idx` ON `subscriptions` (`start_date`,`end_date`);--> statement-breakpoint
CREATE INDEX `sub_plan_idx` ON `subscriptions` (`plan_id`);