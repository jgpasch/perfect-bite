-- Members' first and last names (spec 4.7, 5), after 0029_tmp_drop: the device-only names cache
-- again, with first_name and last_name (null when none) from get_household_members. Empty until
-- the next pull fills it.
CREATE TABLE `household_member_names` (
	`household_id` text NOT NULL,
	`user_id` text NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text,
	`joined_at` text NOT NULL,
	PRIMARY KEY(`household_id`, `user_id`)
);
