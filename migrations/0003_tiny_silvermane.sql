CREATE TABLE `spiritual_interests` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`code` varchar(50) NOT NULL,
	`name` varchar(100) NOT NULL,
	`sort_order` int NOT NULL DEFAULT 0,
	`active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `spiritual_interests_id` PRIMARY KEY(`id`),
	CONSTRAINT `spiritual_interests_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `user_consents` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`consent_type` enum('TERMS','PRIVACY','SPIRITUAL_NOTICE','MARKETING') NOT NULL,
	`version` varchar(20) NOT NULL,
	`accepted_at` timestamp NOT NULL DEFAULT (now()),
	`revoked_at` timestamp,
	CONSTRAINT `user_consents_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_consents_user_type_version_unique` UNIQUE(`user_id`,`consent_type`,`version`)
);
--> statement-breakpoint
CREATE TABLE `user_profiles` (
	`user_id` bigint unsigned NOT NULL,
	`full_name` varchar(200),
	`phone_e164` varchar(20),
	`country_code` varchar(2),
	`timezone` varchar(64),
	`preferred_language` varchar(8),
	`date_of_birth` date,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `user_profiles_user_id` PRIMARY KEY(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `user_spiritual_interests` (
	`user_id` bigint unsigned NOT NULL,
	`spiritual_interest_id` int unsigned NOT NULL,
	`selected_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `user_spiritual_interests_user_id_spiritual_interest_id_pk` PRIMARY KEY(`user_id`,`spiritual_interest_id`)
);
--> statement-breakpoint
ALTER TABLE `user_consents` ADD CONSTRAINT `user_consents_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_profiles` ADD CONSTRAINT `user_profiles_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_spiritual_interests` ADD CONSTRAINT `usi_user_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_spiritual_interests` ADD CONSTRAINT `usi_interest_fk` FOREIGN KEY (`spiritual_interest_id`) REFERENCES `spiritual_interests`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `user_consents_user_idx` ON `user_consents` (`user_id`);--> statement-breakpoint
CREATE INDEX `usi_interest_idx` ON `user_spiritual_interests` (`spiritual_interest_id`);