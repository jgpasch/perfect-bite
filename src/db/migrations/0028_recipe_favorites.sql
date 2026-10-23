-- Favorites per person (spec 4.14): one row per recipe and member who favorited it. Household data,
-- synced like the staples; unfavoriting sets deleted_at. A `favorite` slug in recipes.tags stays, unknown.
CREATE TABLE `recipe_favorites` (
	`recipe_id` text NOT NULL,
	`user_id` text NOT NULL,
	`household_id` text NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`field_clock` text DEFAULT '{}' NOT NULL,
	PRIMARY KEY(`recipe_id`, `user_id`),
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recipe_favorites_household_idx` ON `recipe_favorites` (`household_id`);