CREATE TABLE `ingredient_usage` (
	`household_id` text NOT NULL,
	`ingredient_name` text NOT NULL,
	`display_name` text NOT NULL,
	`use_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer NOT NULL,
	`hidden_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`household_id`, `ingredient_name`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE no action
);
