ALTER TABLE `deities` ADD `approved_by` bigint unsigned;--> statement-breakpoint
ALTER TABLE `deities` ADD `approved_at` timestamp;--> statement-breakpoint
ALTER TABLE `deities` ADD `review_note` varchar(500);--> statement-breakpoint
ALTER TABLE `sacred_houses` ADD `approved_by` bigint unsigned;--> statement-breakpoint
ALTER TABLE `sacred_houses` ADD `approved_at` timestamp;--> statement-breakpoint
ALTER TABLE `sacred_houses` ADD `review_note` varchar(500);--> statement-breakpoint
ALTER TABLE `services` ADD `approved_by` bigint unsigned;--> statement-breakpoint
ALTER TABLE `services` ADD `approved_at` timestamp;--> statement-breakpoint
ALTER TABLE `services` ADD `review_note` varchar(500);--> statement-breakpoint
ALTER TABLE `deities` ADD CONSTRAINT `deities_approved_by_users_id_fk` FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sacred_houses` ADD CONSTRAINT `sacred_houses_approved_by_users_id_fk` FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `services` ADD CONSTRAINT `services_approved_by_users_id_fk` FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON DELETE set null ON UPDATE no action;