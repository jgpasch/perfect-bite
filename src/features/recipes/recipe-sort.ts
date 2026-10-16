// How the Recipes tab sorts and groups recipes (spec 4.5): Recently added, A–Z, or By meal. Pure: no React or SQLite.

import type { AisleHue } from '@/domain/aisle-color';
import { currentLanguage, i18n } from '@/i18n';
import { tagLabel } from '@/i18n/vocabulary';
import { knownTags, MEAL_TAGS, type MealTag, type RecipeTags } from '@/shared/recipe-tags';

export type RecipeSort = 'recent' | 'name' | 'meal';

/** The sort menu's choices, in order. */
export const RECIPE_SORTS: readonly RecipeSort[] = ['recent', 'name', 'meal'];
export const DEFAULT_RECIPE_SORT: RecipeSort = 'recent';

/** The device setting that remembers the choice on this device. */
export const RECIPE_SORT_KEY = 'recipes.sort';

/** A stored choice, or the default for anything else (never set, or from a newer app version). */
export function readRecipeSort(value: unknown): RecipeSort {
  return RECIPE_SORTS.includes(value as RecipeSort) ? (value as RecipeSort) : DEFAULT_RECIPE_SORT;
}

/** A choice in the menu: "Recently added", "A–Z", "By meal". */
export function recipeSortLabel(sort: RecipeSort): string {
  return i18n.t(`recipes.sort.${sort}`);
}

/** The pill's label: "Recent", "A–Z", "By meal". */
export function recipeSortPillLabel(sort: RecipeSort): string {
  return sort === 'recent' ? i18n.t('recipes.sort.recentShort') : recipeSortLabel(sort);
}

/** What VoiceOver reads for the pill: "Sort: Recently added". */
export function recipeSortButtonLabel(sort: RecipeSort): string {
  return i18n.t('recipes.sort.button', { choice: recipeSortLabel(sort) });
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

/**
 * Recipes in the chosen order: Recently added keeps theirs (`recipesQuery` is newest change first); A–Z and
 * By meal (inside each meal) go by name.
 */
export function sortRecipes<R extends { id: string; name: string }>(recipes: readonly R[], sort: RecipeSort): R[] {
  return sort === 'recent' ? [...recipes] : sortRecipesByName(recipes);
}

/** A By meal section: a `meal` tag, or `none` for recipes without one. */
export type MealSectionKey = MealTag | 'none';

/** The meals in facet order (Breakfast, Lunch, Dinner, Side, Dessert, Snack, Drink), then No meal. */
export const MEAL_SECTIONS: readonly MealSectionKey[] = [...MEAL_TAGS, 'none'];

/** Each section's fixed header tint: a different hue per meal, grey for No meal. */
export const MEAL_HUES: Readonly<Record<MealSectionKey, AisleHue>> = {
  breakfast: 'amber',
  lunch: 'teal',
  dinner: 'rose',
  side: 'green',
  dessert: 'plum',
  snack: 'orange',
  drink: 'blue',
  none: 'grey',
};

/** A section's title: the meal's label, or "No meal". */
export function mealSectionTitle(meal: MealSectionKey): string {
  return meal === 'none' ? i18n.t('recipes.sort.noMeal') : (tagLabel('meal', meal) ?? meal);
}

export type RecipeMealSection<R> = { meal: MealSectionKey; title: string; hue: AisleHue; recipes: R[] };

/**
 * One household's recipes By meal: a section per `meal` tag in facet order, then No meal for recipes without
 * one; a recipe with two meals is in both. Empty sections are left out; each section is A–Z.
 */
export function groupRecipesByMeal<R extends { id: string; name: string; tags: RecipeTags | null }>(
  recipes: readonly R[],
): RecipeMealSection<R>[] {
  const byMeal = new Map<MealSectionKey, R[]>();
  for (const recipe of recipes) {
    const meals = knownTags(recipe.tags)?.meal ?? [];
    for (const meal of meals.length > 0 ? (meals as MealTag[]) : (['none'] as const)) {
      byMeal.set(meal, [...(byMeal.get(meal) ?? []), recipe]);
    }
  }
  return MEAL_SECTIONS.filter((meal) => byMeal.has(meal)).map((meal) => ({
    meal,
    title: mealSectionTitle(meal),
    hue: MEAL_HUES[meal],
    recipes: sortRecipesByName(byMeal.get(meal)!),
  }));
}

/** What a section's count counts, singular and plural, for its header's VoiceOver label. */
export function mealSectionUnit(): readonly [one: string, other: string] {
  return [i18n.t('recipes.sort.unit', { count: 1 }), i18n.t('recipes.sort.unit', { count: 2 })];
}

/** A section's fold key: by household and meal, so each household's Dinner folds on its own. */
export function mealSectionKey(householdId: string, meal: MealSectionKey): string {
  return `${householdId}:${meal}`;
}
