// The Recipes tab's shelves (spec 4.5, 4.16): This week, Recently added and Favorites, each a short sideways
// row above All recipes. Pure, apart from reading the app's strings; shelves span households.
import { currentLanguage, i18n, type Language } from '@/i18n';
import { shortSlotName } from '@/features/meal-plan/plan-modal';
import type { PlanEntry } from '@/features/meal-plan/queries';
import { addDays, type Day, MEALS, weekStart } from '@/features/meal-plan/week';
import { dayName, mealLabel } from '@/features/meal-plan/week-view';
import type { RecipeTags } from '@/shared/recipe-tags';

import type { FavoritesByRecipe } from './favorites';
import { activeFilterCount, type RecipeFilters } from './recipe-filters';
import { foldForSearch } from './recipe-search';
import { sortRecipes, sortRecipesByName } from './recipe-sort';
import { recipeTimeLabel } from './recipe-view';

/** Below this many recipes the tab shows none: the whole collection fits on a screen. */
export const SHELVES_MIN_RECIPES = 8;

/** How many tiles Recently added and Favorites show at most. */
export const SHELF_MAX_ITEMS = 10;

export type RecipeShelfKey = 'thisWeek' | 'recent' | 'favorites';

/**
 * A tile: the recipe, the line under its name ("Thu dinner", "35 min") or none, and that line as VoiceOver
 * reads it ("Thursday dinner").
 */
export type RecipeShelfItem<R> = { recipe: R; caption: string | null; spokenCaption: string | null };

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

/** A tile's VoiceOver label: "Tacos, Thursday dinner", "Tacos, 35 min, on Groceries". */
export function shelfTileLabel(item: { recipe: { name: string }; spokenCaption: string | null }, onList: string | null): string {
  return [item.recipe.name, item.spokenCaption, onList ? i18n.t('recipes.tab.cardOn', { name: onList }) : null]
    .filter(Boolean)
    .join(', ');
}

/**
 * The shelves to show, in order: This week (recipes planned from `today` to the week's end, by day then meal,
 * each once at its first slot), Recently added (the 10 newest) and Favorites (A–Z, up to 10; a favorite of any
 * current member, the user included, from `favorites`). An empty shelf is left out, and there are none below
 * `SHELVES_MIN_RECIPES` recipes. `recipes` are in `recipesQuery`'s order (newest change first); `entries` are
 * every household's plan entries, any weeks.
 */
export function recipeShelves<R extends ShelfRecipe>({
  recipes,
  entries,
  today,
  favorites = new Map(),
  language = currentLanguage(),
}: {
  recipes: readonly R[];
  entries: readonly ShelfEntry[];
  today: Day;
  favorites?: FavoritesByRecipe;
  language?: Language;
}): RecipeShelf<R>[] {
  if (recipes.length < SHELVES_MIN_RECIPES) return [];
  const title = (key: RecipeShelfKey) => i18n.t(`recipes.shelves.${key}`, { lng: language });
  const withTime = (recipe: R): RecipeShelfItem<R> => {
    const caption = recipeTimeLabel(recipe.totalMinutes);
    return { recipe, caption, spokenCaption: caption };
  };

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
    thisWeek.push({
      recipe: byId.get(entry.recipeId!)!,
      caption: shortSlotName(entry.planDate, entry.meal, today, language),
      // Always in this week, so always a weekday.
      spokenCaption: i18n.t('mealPlan.slotShort', {
        lng: language,
        day: dayName(entry.planDate, 'long', language),
        meal: mealLabel(entry.meal).toLocaleLowerCase(language),
      }),
    });
  }

  const favorited = sortRecipesByName(recipes.filter((r) => favorites.has(r.id)));
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
      count: favorited.length,
      items: favorited.slice(0, SHELF_MAX_ITEMS).map(withTime),
    },
  ];
  return shelves.filter((shelf) => shelf.items.length > 0);
}
