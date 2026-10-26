-- Recipe collections: named sets of recipes shared by a household, and which recipes are in each.
-- Household data synced like the favorites; removing or deleting sets deleted_at.
CREATE TABLE `recipe_collection_recipes` (
	`collection_id` text NOT NULL,
	`recipe_id` text NOT NULL,
	`household_id` text NOT NULL,
	`added_at` integer NOT NULL,
	`deleted_at` integer,
	`updated_at` integer NOT NULL,
	`field_clock` text DEFAULT '{}' NOT NULL,
	PRIMARY KEY(`collection_id`, `recipe_id`),
	FOREIGN KEY (`collection_id`) REFERENCES `recipe_collections`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recipe_collection_recipes_recipe_idx` ON `recipe_collection_recipes` (`recipe_id`);--> statement-breakpoint
CREATE INDEX `recipe_collection_recipes_household_idx` ON `recipe_collection_recipes` (`household_id`);--> statement-breakpoint
CREATE TABLE `recipe_collections` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`name` text NOT NULL,
	`created_by` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`field_clock` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recipe_collections_household_idx` ON `recipe_collections` (`household_id`);