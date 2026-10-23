-- Aisle order per household (spec 4.3.3), with 0026_household_aisle_order: the per-user,
-- cross-household order is gone, on the server too. No order data is kept: its rows and its queued
-- mutations (the server would refuse those forever) are dropped.
DELETE FROM `outbox` WHERE json_extract(`mutation`, '$.table') = 'user_category_order';--> statement-breakpoint
DROP TABLE `user_category_order`;
