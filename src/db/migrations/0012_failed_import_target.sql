-- Failed imports keep where the share was going (spec 4.10), so Try again goes there too. Rows
-- recorded before this have neither and retry into the default list.
ALTER TABLE `failed_imports` ADD `household_id` text;--> statement-breakpoint
ALTER TABLE `failed_imports` ADD `list_id` text;