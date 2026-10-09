CREATE TABLE `recipe_ingredients` (
	`id` text PRIMARY KEY NOT NULL,
	`recipe_id` text NOT NULL,
	`household_id` text NOT NULL,
	`ingredient_name` text NOT NULL,
	`display_name` text NOT NULL,
	`quantity` real,
	`unit` text,
	`note` text,
	`position` real NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recipe_ingredients_recipe_idx` ON `recipe_ingredients` (`recipe_id`);--> statement-breakpoint
CREATE TABLE `recipes` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`notes` text,
	`source_url` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recipes_household_idx` ON `recipes` (`household_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_list_item_contributions` (
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
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_list_item_contributions`("id", "list_item_id", "household_id", "source", "recipe_id", "quantity", "unit", "added_by", "deleted_at", "created_at", "updated_at") SELECT "id", "list_item_id", "household_id", "source", "recipe_id", "quantity", "unit", "added_by", "deleted_at", "created_at", "updated_at" FROM `list_item_contributions`;--> statement-breakpoint
DROP TABLE `list_item_contributions`;--> statement-breakpoint
ALTER TABLE `__new_list_item_contributions` RENAME TO `list_item_contributions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `list_item_contributions_item_idx` ON `list_item_contributions` (`list_item_id`);