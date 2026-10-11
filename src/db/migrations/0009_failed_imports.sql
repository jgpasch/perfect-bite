CREATE TABLE `failed_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`title` text,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL
);
