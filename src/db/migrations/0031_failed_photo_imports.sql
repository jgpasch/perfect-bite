-- Failed photo imports (spec 4.10): failed_imports gains `kind` (every existing row is a link) and
-- `pages`, and `url` becomes nullable, which SQLite can only do by rebuilding the table. Rows are kept.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_failed_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'link' NOT NULL,
	`url` text,
	`title` text,
	`reason` text NOT NULL,
	`household_id` text,
	`list_id` text,
	`pages` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_failed_imports`("id", "kind", "url", "title", "reason", "household_id", "list_id", "pages", "created_at") SELECT "id", 'link', "url", "title", "reason", "household_id", "list_id", NULL, "created_at" FROM `failed_imports`;--> statement-breakpoint
DROP TABLE `failed_imports`;--> statement-breakpoint
ALTER TABLE `__new_failed_imports` RENAME TO `failed_imports`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
