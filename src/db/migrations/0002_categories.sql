CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text,
	`name` text NOT NULL,
	`owner_user_id` text,
	`default_rank` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_unique` ON `categories` (`slug`);--> statement-breakpoint
CREATE TABLE `ingredients` (
	`normalized_name` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`default_category_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`is_grocery_item` integer,
	`categorized_by` text,
	FOREIGN KEY (`default_category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `user_category_order` (
	`user_id` text NOT NULL,
	`category_id` text NOT NULL,
	`position` real NOT NULL,
	PRIMARY KEY(`user_id`, `category_id`),
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `user_category_overrides` (
	`user_id` text NOT NULL,
	`ingredient_name` text NOT NULL,
	`category_id` text NOT NULL,
	PRIMARY KEY(`user_id`, `ingredient_name`),
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
