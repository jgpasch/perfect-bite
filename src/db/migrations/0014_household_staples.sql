-- Household staples, "Always have" (spec 4.5): ingredients a household always has. Household data,
-- synced like the aisle overrides; unmarking sets deleted_at.
CREATE TABLE `household_staples` (
	`household_id` text NOT NULL,
	`ingredient_name` text NOT NULL,
	`created_by` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`field_clock` text DEFAULT '{}' NOT NULL,
	PRIMARY KEY(`household_id`, `ingredient_name`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
