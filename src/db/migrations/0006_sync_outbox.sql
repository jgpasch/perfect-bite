CREATE TABLE `outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`household_id` text,
	`mutation` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbox_household_idx` ON `outbox` (`household_id`);--> statement-breakpoint
ALTER TABLE `categories` ADD `field_clock` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `households` ADD `field_clock` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `ingredient_unit_usage` ADD `field_clock` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `ingredient_usage` ADD `field_clock` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `list_item_contributions` ADD `field_clock` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `list_items` ADD `field_clock` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `lists` ADD `field_clock` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `recipe_ingredients` ADD `field_clock` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `recipes` ADD `field_clock` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_category_order` ADD `field_clock` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_category_overrides` ADD `field_clock` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_settings` ADD `field_clock` text DEFAULT '{}' NOT NULL;