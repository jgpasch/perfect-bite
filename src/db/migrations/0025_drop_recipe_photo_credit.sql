-- A recipe photo no longer has a credit (spec 4.5, 5): stock photo search is gone and AI photos need none.
ALTER TABLE `recipes` DROP COLUMN `photo_credit`;