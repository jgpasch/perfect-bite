// How to read a recipe into ingredients, steps, a step match, tags and a time (spec 6.6, 6.10),
// shared by the extract-recipe (v4) and extract-recipe-photo prompts so a page and a photo are read
// the same way. Changing a line here changes both prompts: give each a new version file.
import { UNITS } from '@shared/index.ts';

import { RECIPE_TAG_RULES } from './recipe-tag-rules.ts';

/** Follows the not-a-recipe lines; then each prompt says where the ingredients are. */
export const INGREDIENT_LINES_RULE = 'Give one entry per ingredient line, in order. Drop headings that only group lines, such as "For the sauce:".';

/** Each entry's fields, the unit list and the caps. */
export const INGREDIENT_ENTRY_RULES: readonly string[] = [
  'For each entry:',
  '- name: what a shopper buys, without the amount or preparation. "2 cloves garlic, minced" is name "garlic", quantity 2, unit "clove", note "minced".',
  '- quantity: a number, or null when the line has none. For a range ("2-3 carrots") use the higher number. Write fractions as decimals (1 1/2 is 1.5).',
  '- unit: one of the units below, or null. A package with a size: "1 (15 oz) can chickpeas" is quantity 1, unit "can", note "15 oz". If the line uses a unit that is not in the list (a sprig, a slice, a handful), set unit to null and keep that wording in note.',
  '- note: preparation, size and other details, or "". "Salt, to taste" is name "salt", quantity null, unit null, note "to taste". "For serving" also goes in note, with no quantity.',
  `Units (use only these): ${UNITS.join(', ')}.`,
  'Ingredient names are at most 64 characters, notes and the recipe name at most 120. At most 80 ingredients.',
];

export const STEPS_RULE = 'steps: the method, one entry per step, in the order the page gives them.';

/** After "From page text, " or "From the images, ". */
export const STEP_COPY_RULE =
  "copy each step in the page's own words. Do not rewrite, shorten, summarize or merge steps, and do not add any. Leave out the step numbers and headings that only group steps.";

/** What isn't a step, and the caps. */
export const STEP_LIMIT_RULES: readonly string[] = [
  '- Leave out anything that is not a step, such as tips, notes, substitutions, storage advice, nutrition and serving suggestions.',
  '- At most 100 steps of at most 2000 characters. If the page gives no method, set steps to [].',
];

/** After "step_ingredients: one entry per step, in order: <which steps>."; then STEP_MATCH_RULES. */
export const STEP_INGREDIENTS_RULE =
  'Each has its step number (from 1) and the ingredients it uses: each ingredient by the number of its entry in your ingredients list (from 1), with quantity as below. With no steps, set step_ingredients to [].';

/** The tags, every facet's values, and the time. */
export const TAG_AND_TIME_RULES: readonly string[] = [
  'tags: one list per facet below, of slugs from that facet only (write the slug, not the label), most fitting first.',
  ...RECIPE_TAG_RULES,
  'total_minutes: the total time the page gives to make the recipe, in minutes, or null when it gives none. Do not estimate.',
];
