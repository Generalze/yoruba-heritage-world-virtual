CREATE TABLE `deities` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`code` varchar(50) NOT NULL,
	`name` varchar(150) NOT NULL,
	`slug` varchar(100) NOT NULL,
	`short_description` varchar(1000),
	`profile_status` enum('DRAFT','UNDER_REVIEW','APPROVED','PUBLISHED','ARCHIVED') NOT NULL DEFAULT 'DRAFT',
	`sort_order` int NOT NULL DEFAULT 0,
	`active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `deities_id` PRIMARY KEY(`id`),
	CONSTRAINT `deities_code_unique` UNIQUE(`code`),
	CONSTRAINT `deities_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `deity_sacred_houses` (
	`deity_id` int unsigned NOT NULL,
	`sacred_house_id` int unsigned NOT NULL,
	`sort_order` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `deity_sacred_houses_deity_id_sacred_house_id_pk` PRIMARY KEY(`deity_id`,`sacred_house_id`)
);
--> statement-breakpoint
CREATE TABLE `deity_services` (
	`deity_id` int unsigned NOT NULL,
	`service_id` int unsigned NOT NULL,
	`sort_order` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `deity_services_deity_id_service_id_pk` PRIMARY KEY(`deity_id`,`service_id`)
);
--> statement-breakpoint
CREATE TABLE `sacred_house_focus_areas` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`sacred_house_id` int unsigned NOT NULL,
	`label` varchar(200) NOT NULL,
	`sort_order` int NOT NULL DEFAULT 0,
	`active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sacred_house_focus_areas_id` PRIMARY KEY(`id`),
	CONSTRAINT `focus_areas_house_label_unique` UNIQUE(`sacred_house_id`,`label`)
);
--> statement-breakpoint
CREATE TABLE `sacred_house_members` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`sacred_house_id` int unsigned NOT NULL,
	`display_name` varchar(150) NOT NULL,
	`member_type` enum('PRAYER_WARRIOR','PRIEST','BABALAWO','REPRESENTATIVE') NOT NULL,
	`sort_order` int NOT NULL DEFAULT 0,
	`active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sacred_house_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `members_house_name_unique` UNIQUE(`sacred_house_id`,`display_name`)
);
--> statement-breakpoint
CREATE TABLE `sacred_houses` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`code` varchar(50) NOT NULL,
	`name` varchar(150) NOT NULL,
	`slug` varchar(100) NOT NULL,
	`short_description` varchar(1000),
	`status` enum('DRAFT','UNDER_REVIEW','APPROVED','PUBLISHED','ARCHIVED') NOT NULL DEFAULT 'DRAFT',
	`sort_order` int NOT NULL DEFAULT 0,
	`active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `sacred_houses_id` PRIMARY KEY(`id`),
	CONSTRAINT `sacred_houses_code_unique` UNIQUE(`code`),
	CONSTRAINT `sacred_houses_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
CREATE TABLE `services` (
	`id` int unsigned AUTO_INCREMENT NOT NULL,
	`sacred_house_id` int unsigned NOT NULL,
	`code` varchar(50) NOT NULL,
	`name` varchar(150) NOT NULL,
	`slug` varchar(100) NOT NULL,
	`short_description` varchar(1000),
	`service_status` enum('DRAFT','UNDER_REVIEW','APPROVED','PUBLISHED','ARCHIVED') NOT NULL DEFAULT 'DRAFT',
	`duration_minutes` int unsigned,
	`price_minor` int unsigned,
	`currency` varchar(3),
	`sort_order` int NOT NULL DEFAULT 0,
	`active` boolean NOT NULL DEFAULT true,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `services_id` PRIMARY KEY(`id`),
	CONSTRAINT `services_code_unique` UNIQUE(`code`),
	CONSTRAINT `services_slug_unique` UNIQUE(`slug`)
);
--> statement-breakpoint
ALTER TABLE `deity_sacred_houses` ADD CONSTRAINT `deity_sacred_houses_deity_id_deities_id_fk` FOREIGN KEY (`deity_id`) REFERENCES `deities`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deity_sacred_houses` ADD CONSTRAINT `deity_sacred_houses_sacred_house_id_sacred_houses_id_fk` FOREIGN KEY (`sacred_house_id`) REFERENCES `sacred_houses`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deity_services` ADD CONSTRAINT `deity_services_deity_id_deities_id_fk` FOREIGN KEY (`deity_id`) REFERENCES `deities`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deity_services` ADD CONSTRAINT `deity_services_service_id_services_id_fk` FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sacred_house_focus_areas` ADD CONSTRAINT `sacred_house_focus_areas_sacred_house_id_sacred_houses_id_fk` FOREIGN KEY (`sacred_house_id`) REFERENCES `sacred_houses`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sacred_house_members` ADD CONSTRAINT `sacred_house_members_sacred_house_id_sacred_houses_id_fk` FOREIGN KEY (`sacred_house_id`) REFERENCES `sacred_houses`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `services` ADD CONSTRAINT `services_sacred_house_id_sacred_houses_id_fk` FOREIGN KEY (`sacred_house_id`) REFERENCES `sacred_houses`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `deities_status_idx` ON `deities` (`profile_status`,`active`);--> statement-breakpoint
CREATE INDEX `deity_houses_house_idx` ON `deity_sacred_houses` (`sacred_house_id`);--> statement-breakpoint
CREATE INDEX `deity_services_service_idx` ON `deity_services` (`service_id`);--> statement-breakpoint
CREATE INDEX `sacred_houses_status_idx` ON `sacred_houses` (`status`,`active`);--> statement-breakpoint
CREATE INDEX `services_house_idx` ON `services` (`sacred_house_id`);--> statement-breakpoint
CREATE INDEX `services_status_idx` ON `services` (`service_status`,`active`);