// How to read a recipe, shorter (extract-recipe v6, and extract-recipe-photo from v3): the same
// rules as recipe-extract-rules.ts, step-match-rules.ts and recipe-tag-rules.ts, without the caps
// cleanExtractedRecipe already applies, the labels that only repeat a slug, or the repeats. Those
// files stay as they are for the prompts that still render them. Changing a line here changes
// every prompt that uses it: give each a new version file.
import { AI_TAG_FACETS, UNITS, type AiRecipeTagFacetKey } from '@shared/index.ts';

/** Follows "If <the content> isn't a single recipe (<examples>), ". */
export const NOT_A_RECIPE_RULE = 'set is_recipe to false and leave every other field empty ("", null or []).';

/** After a line saying where the ingredients are. */
export const INGREDIENT_RULES: readonly string[] = [
  '- name: what a shopper buys, without amount or preparation. "2 cloves garlic, minced" is name "garlic", quantity 2, unit "clove", note "minced".',
  '- quantity: a number, or null when the line has none. For a range ("2-3 carrots") use the higher number. Fractions as decimals (1 1/2 is 1.5).',
  `- unit: one of ${UNITS.join(', ')}; or null. "1 (15 oz) can chickpeas" is quantity 1, unit "can", note "15 oz". For any other unit (a sprig, a slice, a handful), unit is null and its wording goes in note.`,
  '- note: preparation, size and other details, or "". "Salt, to taste" is name "salt", quantity null, unit null, note "to taste". "For serving" goes in note too.',
];

/** After "From page text, " or "From the images, ". */
export const STEP_COPY_RULE =
  'copy each step word for word: don\'t rewrite, shorten, merge or add steps, and leave out step numbers. Where the method has named sections ("Marinate the chicken", "Grilling"), write "## " and the name on its own line before that section\'s steps. "Step 1" is not a section.';

export const NOT_A_STEP_RULE = '- Leave out tips, notes, substitutions, storage, nutrition and serving suggestions. No method: [].';

/** `which`: the steps the prompt matches, e.g. "the steps you copied out". */
export function stepIngredientsRules(which: string): string[] {
  return [
    `step_ingredients: one entry per step (${which}), none for "## " headings: its step number (from 1) and the ingredients it uses, each by its number in your ingredients list (from 1), with a quantity as below.`,
    '- List what the step adds, mixes in, cuts or otherwise handles for the first time, and only when it clearly does: a wrong ingredient is worse than a missing one.',
    '- Something made in an earlier step uses nothing new: "add the chicken back", "pour over the sauce", "stir in the onion mixture".',
    '- "The sauce ingredients", "the rub" or "all the ingredients" means the ingredients that make that part, when the list makes clear which.',
    '- An ingredient listed twice (butter for the pan, butter for the sauce) is two ingredients: give each step the one it uses.',
    '- When the recipe divides an ingredient ("half the oil", "juice 1 of the limes", "1 cup of the stock"), give each step its share as quantity, in the ingredient\'s own unit (1 for one of 3 limes; 0.5 for half of 1 tbsp). Otherwise quantity is null.',
    '- Salt, pepper and water count only when the step names them ("season with salt"), not for "salted water" or "to taste".',
    '- A garnish or serving suggestion no step mentions goes in no step. Steps that only preheat, rest, wait or serve usually use nothing.',
  ];
}

export const CHOICE_SECTIONS_RULE =
  'choice_sections: the numbers (from 1, over the "## " headings) of headings that are alternative ways to do the same part, of which a cook picks one, such as "Grilling", "Baking" and "Broiling". Never a section the others build on or every cook does ("Marinate the chicken", "Make the sauce"). At least two, else [].';

const FACET_HINTS: Record<AiRecipeTagFacetKey, string> = {
  meal: 'What the dish is usually eaten as.',
  cuisine: 'Only when the dish clearly belongs to it.',
  protein: 'The main proteins, not a little used for flavor.',
  diet: 'Only when every ingredient fits. Vegetarian: no meat, poultry, fish or shellfish, gelatin, meat stock or fish sauce. Vegan: vegetarian, and no eggs, dairy or honey.',
  method: 'Only when the recipe needs that equipment or way of cooking, not when it is merely possible.',
};

/** A slug, with its label only when the label says something the slug doesn't ("pressure-cooker (Instant Pot)"). */
function tagValue(v: { slug: string; label: string }): string {
  return v.slug === v.label.toLowerCase().replaceAll(' ', '-') ? v.slug : `${v.slug} (${v.label})`;
}

export const TAG_RULES: readonly string[] = [
  'tags: per facet, the slugs that clearly apply, most fitting first. A wrong tag hides the recipe from someone looking for it, so leave a facet empty rather than guess.',
  ...AI_TAG_FACETS.map((f) => `- ${f.key} (at most ${f.max}). ${FACET_HINTS[f.key]} ${f.values.map(tagValue).join(', ')}.`),
];

export const TOTAL_MINUTES_RULE = "total_minutes: the total time the recipe gives, in minutes, or null. Don't estimate.";
