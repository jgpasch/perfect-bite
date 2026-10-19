// How to read a recipe into ingredients, steps, a step match, tags and a time (spec 6.6, 6.10),
// shared by the extract-recipe (v4, v5) and extract-recipe-photo (v1, v2) prompts so a page and a
// photo are read the same way. Changing a line here changes those prompts: give each a new version
// file (and add new lines rather than edit ones an older version still renders).
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

/**
 * STEP_COPY_RULE for prompts that keep sections (extract-recipe v5, extract-recipe-photo v2): the
 * headings stay, as SECTION_HEADING_RULE says.
 */
export const SECTION_STEP_COPY_RULE =
  "copy each step in the page's own words. Do not rewrite, shorten, summarize or merge steps, and do not add any. Leave out the step numbers.";

/** How a prompt that keeps sections writes a section's name in `steps` (spec 4.5, 6.6 "Sections"). */
export const SECTION_HEADING_RULE =
  '- Where the recipe names sections of its method ("Marinate the chicken", "Grilling"), write each name on its own line in steps, as "## " and the name, before that section\'s steps. Headings that only number the steps ("Step 1") are not sections. With no named sections, write no headings.';

/** A heading isn't a step: it's never numbered or matched. */
export const SECTION_NOT_A_STEP_RULE = 'A "## " heading is not a step: it has no step number and no step_ingredients entry.';

/** After the step-match rules: which sections are alternatives. */
export const CHOICE_SECTIONS_RULES: readonly string[] = [
  'choice_sections: the headings that are different ways to do the same part of the recipe, of which a cook picks one, such as "Grilling", "Baking", "Pan-frying" and "Broiling". Give each by its number: the "## " headings in order, from 1.',
  '- Never a section the others build on or that every cook does, such as "Marinate the chicken" or "Make the sauce".',
  '- Never just one heading: alternatives come at least two at a time.',
  '- With no such headings, or no headings at all, set choice_sections to [].',
];

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
