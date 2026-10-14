-- Recipe method steps, servings and photo URL (spec 5). Existing recipes have none (null).
ALTER TABLE `recipes` ADD `steps` text;--> statement-breakpoint
ALTER TABLE `recipes` ADD `servings` integer;--> statement-breakpoint
ALTER TABLE `recipes` ADD `image_url` text;