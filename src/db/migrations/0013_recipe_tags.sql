-- Recipe tags and total time (spec 4.14), and who added a recipe (set by the server, spec 5).
-- Existing recipes stay untagged (tags null).
ALTER TABLE `recipes` ADD `tags` text;--> statement-breakpoint
ALTER TABLE `recipes` ADD `tags_edited` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `recipes` ADD `total_minutes` integer;--> statement-breakpoint
ALTER TABLE `recipes` ADD `added_by` text;