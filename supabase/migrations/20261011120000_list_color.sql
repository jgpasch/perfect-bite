-- A list's colour (spec 4.1): one of the aisle hues, or null for Default. It belongs to the list
-- like its name, so every member of the household sees the same one, and it's written through
-- apply_mutations under the same household check as a rename (spec 7.1-7.3).
--
-- Keep the hues in step with AISLE_HUES in src/domain/aisle-color.ts. Adding one later means
-- replacing this constraint; older apps read a hue they don't know as Default.

alter table public.lists
  add column color text
  constraint lists_color_check check (color in ('green', 'blue', 'rose', 'amber', 'grey'));
