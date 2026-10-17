// Shop this week (spec 4.16, board 3 G): the week toolbar's cart adds the planned recipes' ingredients to
// a list in one undoable add, through the recipe bulk add path (spec 4.4, `addItemsBulk`).
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { router } from 'expo-router';

import { db, listItemContributions, listItems, type RecipeIngredient } from '@/db';
import { addRecipeToList, buildRecipeAdds, type RecipeListAdd, undoRecipeAdd } from '@/features/recipes/add-to-list';
import { openList } from '@/features/lists/current-list';
import { type BulkAdd, itemTotal } from '@/features/lists/items';
import { currentLanguage, i18n } from '@/i18n';

import type { WeekPlan } from './queries';
import type { SlotToast } from './slot-actions';
import { type Day, MEALS, type Meal, weekDays, weekStart } from './week';

/**
 * The days the cart shops: today to Saturday in the current week, every day of a future week, and none of a
 * past one (the cart is disabled).
 */
export function shopDays(start: Day, today: Day): Day[] {
  return weekDays(start).filter((day) => day >= today);
}

/** The sheet's title: "Shop the rest of the week" for the current week, "Shop the week of Oct 18" after it. */
export function shopTitle(start: Day, today: Day): string {
  const sunday = weekStart(start);
  if (sunday <= today) return i18n.t('mealPlan.shopRest');
  const date = new Intl.DateTimeFormat(currentLanguage(), { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${sunday}T00:00:00Z`),
  );
  return i18n.t('mealPlan.shopWeekOf', { date });
}

/** A recipe entry the sheet offers. */
export type ShopEntry = {
  id: string;
  day: Day;
  meal: Meal;
  recipeId: string;
  recipeName: string;
  recipeImageUrl: string | null;
  recipePhotoPath: string | null;
};

/**
 * The recipe entries on `days`, in day then meal order: each slot's shown entry, when it's a recipe. Notes,
 * Leftovers and Eating out have nothing to buy.
 */
export function shopEntries(plan: WeekPlan, days: readonly Day[]): ShopEntry[] {
  return days.flatMap((day) =>
    MEALS.flatMap((meal) => {
      const shown = plan.slotEntries(day, meal)[0];
      if (shown?.kind !== 'recipe' || !shown.recipeId) return [];
      const { id, recipeId, recipeName, recipeImageUrl, recipePhotoPath } = shown;
      return [
        {
          id,
          day,
          meal,
          recipeId,
          recipeName: recipeName ?? '',
          recipeImageUrl: recipeImageUrl ?? null,
          recipePhotoPath: recipePhotoPath ?? null,
        },
      ];
    }),
  );
}

/**
 * The recipes with an amount on an open item of the list, which start unticked ("already on Groceries"), as the
 * Recipes tab's "On Groceries" badge counts them.
 */
export function recipesOnList(listId: string): Set<string> {
  return new Set(
    db
      .selectDistinct({ recipeId: listItemContributions.recipeId })
      .from(listItemContributions)
      .innerJoin(
        listItems,
        and(eq(listItems.id, listItemContributions.listItemId), isNull(listItems.deletedAt), isNull(listItems.checkedAt)),
      )
      .where(and(eq(listItems.listId, listId), isNull(listItemContributions.deletedAt), isNotNull(listItemContributions.recipeId)))
      .all()
      .map((r) => r.recipeId!),
  );
}

/** The entries ticked to start with: all but those whose recipe is already on the list. */
export function defaultTicked(entries: readonly ShopEntry[], onList: ReadonlySet<string>): Set<string> {
  return new Set(entries.filter((e) => !onList.has(e.recipeId)).map((e) => e.id));
}

/** One ingredient of the shop, merged across the ticked entries: what Review lists and Add adds. */
export type ShopLine = {
  ingredientName: string;
  /** The first recipe's text for it. */
  displayName: string;
  /** One of the household's staples (Always have): left out unless ticked in Review. */
  staple: boolean;
  /** Its amounts at 1×, one per entry ingredient, each with its recipe. */
  adds: BulkAdd[];
};

/**
 * The ticked entries' ingredients at 1×, merged by ingredient key in the order first met. Each entry counts
 * once, so a recipe planned twice adds its amounts twice. `ingredients(recipeId)` reads a recipe's ingredients.
 */
export function shopLines(
  entries: readonly ShopEntry[],
  ingredients: (recipeId: string) => readonly RecipeIngredient[],
  staples: ReadonlySet<string>,
): ShopLine[] {
  const lines = new Map<string, ShopLine>();
  for (const entry of entries) {
    const own = ingredients(entry.recipeId);
    const adds = buildRecipeAdds(entry.recipeId, own, new Set(own.map((i) => i.id)), 1);
    adds.forEach((add, index) => {
      const { ingredientName } = own[index];
      const line = lines.get(ingredientName);
      if (line) line.adds.push(add);
      else {
        lines.set(ingredientName, {
          ingredientName,
          displayName: own[index].displayName,
          staple: staples.has(ingredientName),
          adds: [add],
        });
      }
    });
  }
  return [...lines.values()];
}

/** The lines ticked to start with, by ingredient key: all but the staples. */
export function defaultLines(lines: readonly ShopLine[]): Set<string> {
  return new Set(lines.filter((l) => !l.staple).map((l) => l.ingredientName));
}

/** A line's merged amount at 1×: "1 lb + 8 oz", "3", or "" when none of its amounts has a quantity. */
export function lineAmount(line: ShopLine): string {
  return itemTotal(line.adds.map((a) => ('parsed' in a ? { ...a.parsed, source: 'recipe' } : { quantity: null, unit: null, source: 'recipe' })));
}

/** The bulk adds for the ticked lines, in line order. */
export function shopAdds(lines: readonly ShopLine[], ticked: ReadonlySet<string>): BulkAdd[] {
  return lines.filter((l) => ticked.has(l.ingredientName)).flatMap((l) => l.adds);
}

/**
 * Adds the shop to the list in one bulk add (spec 4.4): an open match Combines, a checked one is reopened, and
 * the same ingredient from two recipes folds into one item with an amount from each recipe.
 */
export function shopToList(listId: string, adds: readonly BulkAdd[], userId: string | null): RecipeListAdd {
  return addRecipeToList(listId, adds, userId);
}

/** How many list items an add touched: the "18 items" in the toast. */
export function shopItemCount(add: Pick<RecipeListAdd, 'results'>): number {
  return new Set(add.results.flatMap((r) => (r ? [r.itemId] : []))).size;
}

/** "Added 3 recipes · 18 items". */
export function shopToastMessage(recipes: number, items: number): string {
  return i18n.t('mealPlan.shopAdded', {
    recipes: i18n.t('mealPlan.shopRecipes', { count: recipes }),
    items: i18n.t('mealPlan.shopItems', { count: items }),
  });
}

/** The toast after Add: Undo takes back the whole add in one step, Open list shows the list. */
export function shopToast(add: RecipeListAdd, recipes: number, listId: string, onToast: (toast: SlotToast | null) => void): SlotToast {
  return {
    key: `shop-${Date.now()}`,
    message: shopToastMessage(recipes, shopItemCount(add)),
    actions: [
      { label: i18n.t('common.undo'), onPress: () => (undoRecipeAdd(add), onToast(null)) },
      { label: i18n.t('recipes.tab.openList'), onPress: () => (onToast(null), openList(listId)) },
    ],
  };
}

// The sheet is a route, so the week that opened it hands over where its toast goes.
let toastTarget: ((toast: SlotToast | null) => void) | null = null;

/** The cart: opens the shop sheet for the household's week; its toast shows through `onToast`. */
export function openShopSheet(householdId: string, start: Day, onToast: (toast: SlotToast | null) => void): void {
  toastTarget = onToast;
  router.push({ pathname: '/plan-shop', params: { householdId, start } });
}

/** Shows the sheet's toast on the week that opened it. */
export function showShopToast(add: RecipeListAdd, recipes: number, listId: string): void {
  const target = toastTarget;
  if (target) target(shopToast(add, recipes, listId, target));
}
