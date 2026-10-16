-- Members' names (spec 4.7, 5): a device-only cache of get_household_members, never pushed.
CREATE TABLE `household_member_names` (
	`household_id` text NOT NULL,
	`user_id` text NOT NULL,
	`display_name` text NOT NULL,
	`joined_at` text NOT NULL,
	PRIMARY KEY(`household_id`, `user_id`)
);
