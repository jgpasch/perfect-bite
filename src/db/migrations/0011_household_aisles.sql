-- Household aisles (spec 4.3.2): overrides and custom aisles belong to a household now. No
-- existing aisle data is kept: per-user overrides, custom aisles, the order rows that point at
-- them, and their queued mutations (the server would reject those forever) are dropped.
DELETE FROM `outbox` WHERE json_extract(`mutation`, '$.table') IN ('user_category_overrides', 'categories');--> statement-breakpoint
DELETE FROM `outbox` WHERE json_extract(`mutation`, '$.table') = 'user_category_order' AND json_extract(`mutation`, '$.key.category_id') IN (SELECT `id` FROM `categories` WHERE `owner_user_id` IS NOT NULL);--> statement-breakpoint
DELETE FROM `user_category_order` WHERE `category_id` IN (SELECT `id` FROM `categories` WHERE `owner_user_id` IS NOT NULL);--> statement-breakpoint
DROP TABLE `user_category_overrides`;--> statement-breakpoint
DELETE FROM `categories` WHERE `owner_user_id` IS NOT NULL;--> statement-breakpoint
ALTER TABLE `categories` DROP COLUMN `owner_user_id`;--> statement-breakpoint
ALTER TABLE `categories` ADD `household_id` text REFERENCES households(id);--> statement-breakpoint
CREATE TABLE `household_category_overrides` (
	`household_id` text NOT NULL,
	`ingredient_name` text NOT NULL,
	`category_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`field_clock` text DEFAULT '{}' NOT NULL,
	PRIMARY KEY(`household_id`, `ingredient_name`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
