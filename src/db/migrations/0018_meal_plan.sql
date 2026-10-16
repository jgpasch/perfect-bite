-- The household's meal plan (spec 4.16): one row per entry in a slot (a day and a meal). Household
-- data, synced like recipes; clearing a slot sets deleted_at.
CREATE TABLE `meal_plan_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`plan_date` text NOT NULL,
	`meal` text NOT NULL,
	`position` real DEFAULT 0 NOT NULL,
	`kind` text NOT NULL,
	`recipe_id` text,
	`note` text,
	`added_by` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`field_clock` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `meal_plan_entries_household_date_idx` ON `meal_plan_entries` (`household_id`,`plan_date`);