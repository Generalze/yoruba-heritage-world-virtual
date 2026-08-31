ALTER TABLE `visual_bible_reference_media` DROP FOREIGN KEY `vbrm_version_fk`;
--> statement-breakpoint
ALTER TABLE `visual_bible_reference_media` ADD CONSTRAINT `vbrm_version_fk` FOREIGN KEY (`visual_bible_version_id`) REFERENCES `visual_bible_versions`(`id`) ON DELETE restrict ON UPDATE no action;