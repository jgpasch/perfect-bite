CREATE TABLE `households` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `list_item_contributions` (
	`id` text PRIMARY KEY NOT NULL,
	`list_item_id` text NOT NULL,
	`household_id` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`recipe_id` text,
	`quantity` real,
	`unit` text,
	`added_by` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`list_item_id`) REFERENCES `list_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `list_item_contributions_item_idx` ON `list_item_contributions` (`list_item_id`);--> statement-breakpoint
CREATE TABLE `list_items` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`household_id` text NOT NULL,
	`ingredient_name` text NOT NULL,
	`display_name` text NOT NULL,
	`note` text,
	`checked_at` integer,
	`checked_by` text,
	`added_by` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `list_items_list_idx` ON `list_items` (`list_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `one_open_item_per_ingredient` ON `list_items` (`list_id`,`ingredient_name`) WHERE "list_items"."deleted_at" is null and "list_items"."checked_at" is null;--> statement-breakpoint
CREATE TABLE `lists` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`emoji` text,
	`position` real NOT NULL,
	`archived_at` integer,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `lists_household_idx` ON `lists` (`household_id`);--> statement-breakpoint
CREATE TABLE `user_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`default_list_id` text,
	FOREIGN KEY (`default_list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE no action
);
