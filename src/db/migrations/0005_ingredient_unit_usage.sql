CREATE TABLE `ingredient_unit_usage` (
	`household_id` text NOT NULL,
	`ingredient_name` text NOT NULL,
	`unit_key` text NOT NULL,
	`use_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`household_id`, `ingredient_name`, `unit_key`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
