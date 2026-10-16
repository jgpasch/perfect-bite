-- Which ingredients each method step uses (spec 4.5, 5). Existing recipes are unmatched (null).
ALTER TABLE `recipes` ADD `step_ingredients` text;