-- Members' first and last names (spec 4.7, 5), with 0030_household_member_first_last_names: the
-- names cache loses display_name. It's a cache that refills on the next pull, so its rows are
-- dropped with it (SQLite can't add the new not-null first_name to a table in place).
DROP TABLE `household_member_names`;
