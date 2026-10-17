-- Who to credit for a recipe's own photo when it's a stock photo (spec 4.5, 5). Existing recipes have none (null).
ALTER TABLE `recipes` ADD `photo_credit` text;