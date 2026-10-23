-- Aisle order per household (spec 4.3.3): the household's order and each member's own order for
-- it, plus custom aisles' created_at (missing aisles go after an order by it). 0027 drops the old
-- per-user order.
CREATE TABLE `household_category_order` (
	`household_id` text PRIMARY KEY NOT NULL,
	`category_ids` text NOT NULL,
	`updated_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`field_clock` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `user_household_category_order` (
	`user_id` text NOT NULL,
	`household_id` text NOT NULL,
	`category_ids` text NOT NULL,
	`field_clock` text DEFAULT '{}' NOT NULL,
	PRIMARY KEY(`user_id`, `household_id`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `categories` ADD `created_at` integer;