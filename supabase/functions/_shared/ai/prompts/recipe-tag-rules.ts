// How to tag a recipe (spec 4.14), shared by the extract-recipe and suggest-recipe-tags prompts so
// both tag the same way. Changing a line here changes both prompts: give each a new version file.
import { AI_TAG_FACETS } from '@shared/index.ts';

/**
 * One line per facet: its key, how many it may have, and every value as `slug (Label)`. Not
 * `saved` (Favorite, Want to try): only a person sets it.
 */
const FACET_LINES = AI_TAG_FACETS.map(
  (facet) =>
    `- ${facet.key} (${facet.label}, at most ${facet.max}): ${facet.values.map((v) => `${v.slug} (${v.label})`).join(', ')}.`,
);

/** The tagging rules, then every facet's values. Follows a line saying what `tags` is. */
export const RECIPE_TAG_RULES: readonly string[] = [
  'Pick only values that clearly apply. A wrong tag hides the recipe from someone looking for it, so an empty list is better than a guess.',
  '- meal: what the dish is usually eaten as.',
  '- cuisine: only when the dish clearly belongs to that cuisine.',
  '- protein: the main proteins, not a little used for flavor.',
  '- diet: only when every ingredient fits it. Vegetarian: no meat, poultry, fish or shellfish, and no gelatin, meat stock or fish sauce. Vegan: vegetarian, and no eggs, dairy or honey either.',
  '- method: only when the recipe needs that equipment or way of cooking (an Instant Pot, a slow cooker, a grill); not when it is merely possible.',
  ...FACET_LINES,
];
