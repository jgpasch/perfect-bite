// How the Recipes tab sorts and groups recipes (spec 4.5): two choices, a sort (Recently added or A–Z) and a
// grouping (none, or by a facet). Pure: no React or SQLite.

import type { AisleHue } from '@/domain/aisle-color';
import { currentLanguage, i18n } from '@/i18n';
import { cuisineRegionLabel, tagLabel } from '@/i18n/vocabulary';
import {
  CUISINE_REGIONS,
  knownTags,
  timeBucket,
  type CuisineRegion,
  type CuisineTag,
  type RecipeTags,
  type TimeBucket,
} from '@/shared/recipe-tags';

import { timeBucketLabel } from './recipe-filters';

export type RecipeSort = 'recent' | 'name';

/** The sort choices, in order. */
export const RECIPE_SORTS: readonly RecipeSort[] = ['recent', 'name'];
export const DEFAULT_RECIPE_SORT: RecipeSort = 'recent';

/** The device setting that remembers the sort on this device. */
export const RECIPE_SORT_KEY = 'recipes.sort';

export type RecipeGroup = 'none' | 'meal' | 'cuisine' | 'protein' | 'method' | 'time' | 'saved';

/** The grouping choices, in order. Diet isn't one: two values, and Filters covers it. */
export const RECIPE_GROUPS: readonly RecipeGroup[] = ['none', 'meal', 'cuisine', 'protein', 'method', 'time', 'saved'];
export const DEFAULT_RECIPE_GROUP: RecipeGroup = 'none';

/** The device setting that remembers the grouping on this device. */
export const RECIPE_GROUP_KEY = 'recipes.group';

/** A stored sort, or the default for anything else (never set, or from a newer app version). */
export function readRecipeSort(value: unknown): RecipeSort {
  return RECIPE_SORTS.includes(value as RecipeSort) ? (value as RecipeSort) : DEFAULT_RECIPE_SORT;
}

/** A stored grouping, or none for anything else. */
export function readRecipeGroup(value: unknown): RecipeGroup {
  return RECIPE_GROUPS.includes(value as RecipeGroup) ? (value as RecipeGroup) : DEFAULT_RECIPE_GROUP;
}

/**
 * Both stored choices. A `recipes.sort` of `'meal'` is from before grouping was its own choice (By meal was a
 * sort): it reads as A–Z grouped by meal, the same screen, and `legacy` says to write both settings back.
 */
export function readRecipeSortChoice(
  storedSort: unknown,
  storedGroup: unknown,
): { sort: RecipeSort; group: RecipeGroup; legacy: boolean } {
  if (storedSort === 'meal') return { sort: 'name', group: 'meal', legacy: true };
  return { sort: readRecipeSort(storedSort), group: readRecipeGroup(storedGroup), legacy: false };
}

/** A sort in the menu: "Recently added", "A–Z". */
export function recipeSortLabel(sort: RecipeSort): string {
  return i18n.t(`recipes.sort.${sort}`);
}

/** A grouping as the pill reads it: "By meal", "By cuisine", … "Saved". */
export function recipeGroupLabel(group: Exclude<RecipeGroup, 'none'>): string {
  return i18n.t(`recipes.sort.groups.${group}`);
}

/** The pill's label: the grouping when there is one ("By cuisine"), else the sort ("Recent", "A–Z"). */
export function recipeSortPillLabel(sort: RecipeSort, group: RecipeGroup): string {
  if (group !== 'none') return recipeGroupLabel(group);
  return sort === 'recent' ? i18n.t('recipes.sort.recentShort') : recipeSortLabel(sort);
}

/** What VoiceOver reads for the pill: "Sort: Recently added", "Sort: A–Z, grouped by cuisine". */
export function recipeSortButtonLabel(sort: RecipeSort, group: RecipeGroup): string {
  const choice = recipeSortLabel(sort);
  return group === 'none'
    ? i18n.t('recipes.sort.button', { choice })
    : i18n.t('recipes.sort.buttonGrouped', { choice, group: i18n.t(`recipes.sort.groupNames.${group}`) });
}

let collator: { language: string; compare: (a: string, b: string) => number } | null = null;

/** Two names in the app's language's alphabetical order, ignoring case and accents, numbers by value. */
export function compareRecipeNames(a: string, b: string): number {
  const language = currentLanguage();
  if (collator?.language !== language) {
    collator = { language, compare: new Intl.Collator(language, { sensitivity: 'base', numeric: true }).compare };
  }
  return collator.compare(a, b);
}

/** Recipes A–Z by name (ties by id, so the order is stable). */
export function sortRecipesByName<R extends { id: string; name: string }>(recipes: readonly R[]): R[] {
  return [...recipes].sort((a, b) => compareRecipeNames(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Recipes in the chosen order: Recently added keeps theirs (`recipesQuery` is newest change first); A–Z by name. */
export function sortRecipes<R extends { id: string; name: string }>(recipes: readonly R[], sort: RecipeSort): R[] {
  return sort === 'recent' ? [...recipes] : sortRecipesByName(recipes);
}

/** A section of a grouping: a facet value (a region for Cuisine, a bucket for Time), or `none` for "No …". */
type GroupSection = { key: string; hue: AisleHue };

/** Each grouping's sections in order, each with its fixed header tint; the "No …" section last, grey. */
export const RECIPE_GROUP_SECTIONS: Readonly<Record<Exclude<RecipeGroup, 'none'>, readonly GroupSection[]>> = {
  meal: [
    { key: 'breakfast', hue: 'amber' },
    { key: 'lunch', hue: 'teal' },
    { key: 'dinner', hue: 'rose' },
    { key: 'side', hue: 'green' },
    { key: 'dessert', hue: 'plum' },
    { key: 'snack', hue: 'orange' },
    { key: 'drink', hue: 'blue' },
    { key: 'none', hue: 'grey' },
  ],
  cuisine: [
    { key: 'american', hue: 'blue' },
    { key: 'latin', hue: 'orange' },
    { key: 'european', hue: 'green' },
    { key: 'middle-eastern', hue: 'amber' },
    { key: 'asian', hue: 'teal' },
    { key: 'african', hue: 'plum' },
    { key: 'none', hue: 'grey' },
  ],
  protein: [
    { key: 'chicken', hue: 'amber' },
    { key: 'turkey', hue: 'orange' },
    { key: 'beef', hue: 'rose' },
    { key: 'pork', hue: 'plum' },
    { key: 'lamb', hue: 'rose' },
    { key: 'fish', hue: 'blue' },
    { key: 'shellfish', hue: 'teal' },
    { key: 'eggs', hue: 'amber' },
    { key: 'tofu-tempeh', hue: 'green' },
    { key: 'beans-lentils', hue: 'orange' },
    { key: 'none', hue: 'grey' },
  ],
  method: [
    { key: 'pressure-cooker', hue: 'blue' },
    { key: 'slow-cooker', hue: 'orange' },
    { key: 'sheet-pan', hue: 'amber' },
    { key: 'one-pot', hue: 'teal' },
    { key: 'grill', hue: 'rose' },
    { key: 'air-fryer', hue: 'plum' },
    { key: 'no-cook', hue: 'green' },
    { key: 'none', hue: 'grey' },
  ],
  time: [
    { key: 'under-30', hue: 'green' },
    { key: 'under-60', hue: 'amber' },
    { key: 'over-60', hue: 'rose' },
    { key: 'none', hue: 'grey' },
  ],
  saved: [
    { key: 'favorite', hue: 'rose' },
    { key: 'want-to-try', hue: 'blue' },
    { key: 'none', hue: 'grey' },
  ],
};

const NO_SECTION_TITLES = {
  meal: 'noMeal',
  cuisine: 'noCuisine',
  protein: 'noProtein',
  method: 'noMethod',
  time: 'noTime',
  saved: 'notSaved',
} as const;

/** A section's title in the app's language: the value's label ("Dinner", "Asian", "Under 30 min"), or "No …". */
export function recipeGroupSectionTitle(group: Exclude<RecipeGroup, 'none'>, key: string): string {
  if (key === 'none') return i18n.t(`recipes.sort.${NO_SECTION_TITLES[group]}`);
  if (group === 'cuisine') return cuisineRegionLabel(key as CuisineRegion);
  if (group === 'time') return timeBucketLabel(key as TimeBucket);
  return tagLabel(group, key) ?? key;
}

/** The section keys a recipe belongs to in a grouping (several for several values), before "No …". */
function sectionKeysOf(recipe: { tags: RecipeTags | null; totalMinutes?: number | null }, group: Exclude<RecipeGroup, 'none'>) {
  if (group === 'time') {
    const bucket = timeBucket(recipe.totalMinutes);
    return bucket ? [bucket] : [];
  }
  const values = knownTags(recipe.tags)?.[group] ?? [];
  // Two cuisines in one region put the recipe in it once.
  return group === 'cuisine' ? [...new Set(values.map((c) => CUISINE_REGIONS[c as CuisineTag]))] : values;
}

export type RecipeSection<R> = { key: string; title: string; hue: AisleHue; recipes: R[] };

/**
 * One household's recipes in a grouping's sections, in its order, each in the chosen sort; a recipe with several
 * values in the facet is in each of their sections, one with none (or only unknown ones) in "No …". Empty
 * sections are left out; no grouping gives none.
 */
export function groupRecipes<R extends { id: string; name: string; tags: RecipeTags | null; totalMinutes?: number | null }>(
  recipes: readonly R[],
  group: RecipeGroup,
  sort: RecipeSort,
): RecipeSection<R>[] {
  if (group === 'none') return [];
  const byKey = new Map<string, R[]>();
  for (const recipe of recipes) {
    const keys = sectionKeysOf(recipe, group);
    for (const key of keys.length > 0 ? keys : ['none']) byKey.set(key, [...(byKey.get(key) ?? []), recipe]);
  }
  return RECIPE_GROUP_SECTIONS[group]
    .filter((section) => byKey.has(section.key))
    .map((section) => ({
      key: section.key,
      title: recipeGroupSectionTitle(group, section.key),
      hue: section.hue,
      recipes: sortRecipes(byKey.get(section.key)!, sort),
    }));
}

/** What a section's count counts, singular and plural, for its header's VoiceOver label. */
export function recipeSectionUnit(): readonly [one: string, other: string] {
  return [i18n.t('recipes.sort.unit', { count: 1 }), i18n.t('recipes.sort.unit', { count: 2 })];
}

/** A section's fold key: by household, grouping and section, so each household's Dinner folds on its own. */
export function recipeSectionKey(householdId: string, group: RecipeGroup, sectionKey: string): string {
  return `${householdId}:${group}:${sectionKey}`;
}
