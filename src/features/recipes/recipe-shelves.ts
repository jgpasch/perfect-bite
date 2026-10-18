// The Recipes tab's shelves (spec 4.5, 4.16): This week, Recently added and Favorites, each a short sideways
// row above All recipes. Pure, apart from reading the app's strings; shelves span households.
import { currentLanguage, i18n, type Language } from '@/i18n';
import { shortSlotName } from '@/features/meal-plan/plan-modal';
import type { PlanEntry } from '@/features/meal-plan/queries';
import { addDays, type Day, MEALS, weekStart } from '@/features/meal-plan/week';
import { knownTags, type RecipeTags } from '@/shared/recipe-tags';

import { activeFilterCount, type RecipeFilters } from './recipe-filters';
import { foldForSearch } from './recipe-search';
import { sortRecipes, sortRecipesByName } from './recipe-sort';
import { recipeTimeLabel } from './recipe-view';

/** Below this many recipes the tab shows none: the whole collection fits on a screen. */
export const SHELVES_MIN_RECIPES = 8;

/** How many tiles Recently added and Favorites show at most. */
export const SHELF_MAX_ITEMS = 10;

export type RecipeShelfKey = 'thisWeek' | 'recent' | 'favorites';

/** A tile: the recipe, and the line under its name ("Thu dinner", "35 min"), or none. */
export type RecipeShelfItem<R> = { recipe: R; caption: string | null };

/** A shelf: `count` is what its See all counts, which can be more than the tiles shown. */
export type RecipeShelf<R> = { key: RecipeShelfKey; title: string; count: number; items: RecipeShelfItem<R>[] };

type ShelfRecipe = { id: string; name: string; tags: RecipeTags | null; totalMinutes: number | null };
type ShelfEntry = Pick<PlanEntry, 'planDate' | 'meal' | 'kind' | 'recipeId' | 'position'>;

/** Whether the tab shows shelves: not while searching or filtering, nor with fewer than 8 recipes. */
export function shelvesShown({
  query,
  filters,
  recipeCount,
}: {
  query: string;
  filters: RecipeFilters;
  recipeCount: number;
}): boolean {
  return recipeCount >= SHELVES_MIN_RECIPES && !foldForSearch(query) && activeFilterCount(filters) === 0;
}

const isFavorite = (recipe: ShelfRecipe) => knownTags(recipe.tags)?.saved.includes('favorite') ?? false;

/**
 * The shelves to show, in order: This week (recipes planned from `today` to the week's end, by day then meal,
 * each once at its first slot), Recently added (the 10 newest) and Favorites (A–Z, up to 10). An empty shelf
 * is left out, and there are none below `SHELVES_MIN_RECIPES` recipes. `recipes` are in `recipesQuery`'s
 * order (newest change first); `entries` are every household's plan entries, any weeks.
 */
export function recipeShelves<R extends ShelfRecipe>({
  recipes,
  entries,
  today,
  language = currentLanguage(),
}: {
  recipes: readonly R[];
  entries: readonly ShelfEntry[];
  today: Day;
  language?: Language;
}): RecipeShelf<R>[] {
  if (recipes.length < SHELVES_MIN_RECIPES) return [];
  const title = (key: RecipeShelfKey) => i18n.t(`recipes.shelves.${key}`, { lng: language });
  const withTime = (recipe: R): RecipeShelfItem<R> => ({ recipe, caption: recipeTimeLabel(recipe.totalMinutes) });

  const byId = new Map(recipes.map((r) => [r.id, r]));
  const weekEnd = addDays(weekStart(today), 6);
  const planned = entries
    .filter((e) => e.kind === 'recipe' && e.recipeId && byId.has(e.recipeId) && e.planDate >= today && e.planDate <= weekEnd)
    .sort(
      (a, b) =>
        (a.planDate < b.planDate ? -1 : a.planDate > b.planDate ? 1 : 0) ||
        MEALS.indexOf(a.meal) - MEALS.indexOf(b.meal) ||
        a.position - b.position,
    );
  const seen = new Set<string>();
  const thisWeek: RecipeShelfItem<R>[] = [];
  for (const entry of planned) {
    if (seen.has(entry.recipeId!)) continue;
    seen.add(entry.recipeId!);
    thisWeek.push({ recipe: byId.get(entry.recipeId!)!, caption: shortSlotName(entry.planDate, entry.meal, today, language) });
  }

  const favorites = sortRecipesByName(recipes.filter(isFavorite));
  const shelves: RecipeShelf<R>[] = [
    { key: 'thisWeek', title: title('thisWeek'), count: planned.length, items: thisWeek },
    {
      key: 'recent',
      title: title('recent'),
      count: recipes.length,
      items: sortRecipes(recipes, 'recent').slice(0, SHELF_MAX_ITEMS).map(withTime),
    },
    {
      key: 'favorites',
      title: title('favorites'),
      count: favorites.length,
      items: favorites.slice(0, SHELF_MAX_ITEMS).map(withTime),
    },
  ];
  return shelves.filter((shelf) => shelf.items.length > 0);
}
