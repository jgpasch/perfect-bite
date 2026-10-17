-- A household's own recipe photo (spec 4.5, 5). Existing recipes have none (null).
ALTER TABLE `recipes` ADD `photo_path` text;