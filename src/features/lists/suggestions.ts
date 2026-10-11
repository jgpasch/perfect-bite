import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db, ingredientUsage, listItemContributions, listItems, recipeIngredients } from '@/db';
import { formatAmount, type Amount } from '@/domain/quantity-display';
import { frecency, rankRecipes, recentRecipes } from '@/domain/suggestion-rank';
import { searchCatalog } from '@/features/categories/categories';
import { recipeAddTimes, recipesQuery, type RecipeSummary } from '@/features/recipes/recipes';
import { parseQuantity } from '@/shared';

import { searchRecentItems } from './items';

export type Suggestion = { key: string; displayName: string; source: 'history' | 'catalog' };

/** With at least this many household history matches, the catalog is left out (spec 4.2). */
const HISTORY_ONLY_MIN = 2;

/**
 * Add-bar autocomplete (spec 4.2): household history wins. With 2 or more history matches only history is shown;
 * with fewer, the catalog fills the remaining slots. Matches the name part of the text, so `2 lbs chi` suggests
 * chicken thighs. A history match identical to the typed name is still shown, so a recently used item stays first;
 * a catalog suggestion identical to it is skipped.
 * TODO(M6): limit catalog suggestions per spec 6.5 once server rows are cached.
 */
export function getSuggestions(householdId: string, text: string, limit = 5): Suggestion[] {
  const { name } = parseQuantity(text);
  const typed = name.trim().toLowerCase();
  if (typed.length < 2) return [];
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  const push = (rows: { key: string; displayName: string }[], source: Suggestion['source']) => {
    for (const r of rows) {
      if (out.length === limit) return;
      if (seen.has(r.key) || (source === 'catalog' && r.displayName.toLowerCase() === typed)) continue;
      seen.add(r.key);
      out.push({ key: r.key, displayName: r.displayName, source });
    }
  };
  push(searchRecentItems(householdId, name, limit), 'history');
  if (out.length < HISTORY_ONLY_MIN) push(searchCatalog(name, limit), 'catalog');
  return out;
}

/** The autocomplete panel's caption: "YOU USUALLY BUY" when household history leads, else "SUGGESTIONS". */
export function suggestionCaption(suggestions: readonly Pick<Suggestion, 'source'>[]): string {
  return suggestions[0]?.source === 'history' ? 'YOU USUALLY BUY' : 'SUGGESTIONS';
}

/** The add text with its name replaced by a suggestion, keeping a typed amount: `2 lbs chi` → `2 lbs chicken thighs`. */
export function applySuggestion(text: string, suggestion: Pick<Suggestion, 'key' | 'displayName'>): string {
  const { name } = parseQuantity(text);
  const trimmed = text.trim();
  const prefix = name && trimmed.endsWith(name) ? trimmed.slice(0, trimmed.length - name.length) : '';
  return `${prefix}${suggestion.displayName}`;
}

/** A "RECENTLY USED" row. `text` is what tapping it adds: the last amount used plus the name (`2 lb chicken thighs`). */
export type RecentItem = { key: string; displayName: string; text: string };

/**
 * The add bar's "RECENTLY USED" panel (spec 4.2), shown while it's focused and empty: the household's history by
 * frecency (ties as in autocomplete: shorter name, then alphabetical), leaving out hidden rows and ingredients already
 * unchecked on `listId`. Checked items stay, so they can be added back.
 */
export function getRecentItems(householdId: string, listId: string, limit = 30, now = new Date()): RecentItem[] {
  const onList = new Set(
    db
      .select({ key: listItems.ingredientName })
      .from(listItems)
      .where(and(eq(listItems.listId, listId), isNull(listItems.deletedAt), isNull(listItems.checkedAt)))
      .all()
      .map((r) => r.key),
  );
  const rows = db
    .select()
    .from(ingredientUsage)
    .where(and(eq(ingredientUsage.householdId, householdId), isNull(ingredientUsage.hiddenAt)))
    .all()
    .filter((r) => !onList.has(r.ingredientName))
    .map((row) => ({ row, score: frecency(row, now) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.row.displayName.length - b.row.displayName.length ||
        (a.row.displayName < b.row.displayName ? -1 : a.row.displayName > b.row.displayName ? 1 : 0),
    )
    .slice(0, Math.max(0, limit))
    .map((m) => m.row);
  const amounts = lastAmounts(
    householdId,
    rows.map((r) => r.ingredientName),
  );
  return rows.map((r) => {
    const amount = amounts.get(r.ingredientName);
    const prefix = amount ? formatAmount(amount) : '';
    return { key: r.ingredientName, displayName: r.displayName, text: prefix ? `${prefix} ${r.displayName}` : r.displayName };
  });
}

/**
 * The amount of each ingredient's latest use in the household: its newest live list amount (even on a since-deleted
 * item, since history outlives items) or recipe ingredient, whichever came last.
 */
function lastAmounts(householdId: string, keys: string[]): Map<string, Amount> {
  if (keys.length === 0) return new Map();
  const uses = [
    ...db
      .select({
        key: listItems.ingredientName,
        quantity: listItemContributions.quantity,
        unit: listItemContributions.unit,
        at: listItemContributions.createdAt,
      })
      .from(listItemContributions)
      .innerJoin(listItems, eq(listItems.id, listItemContributions.listItemId))
      .where(
        and(
          eq(listItems.householdId, householdId),
          inArray(listItems.ingredientName, keys),
          isNull(listItemContributions.deletedAt),
        ),
      )
      .all(),
    ...db
      .select({
        key: recipeIngredients.ingredientName,
        quantity: recipeIngredients.quantity,
        unit: recipeIngredients.unit,
        at: recipeIngredients.createdAt,
      })
      .from(recipeIngredients)
      .where(
        and(
          eq(recipeIngredients.householdId, householdId),
          inArray(recipeIngredients.ingredientName, keys),
          isNull(recipeIngredients.deletedAt),
        ),
      )
      .all(),
  ];
  const latest = new Map<string, { amount: Amount; at: Date }>();
  for (const { key, quantity, unit, at } of uses) {
    const found = latest.get(key);
    if (!found || at >= found.at) latest.set(key, { amount: { quantity, unit }, at });
  }
  return new Map([...latest].map(([key, { amount }]) => [key, amount]));
}

/** A recipe row in the add bar's panel (spec 4.2): tapping it adds the whole recipe at 1×. */
export type RecipeSuggestion = { id: string; name: string; ingredientCount: number };

/** Recipe rows shown above the item suggestions while typing. */
const RECIPE_SUGGESTION_LIMIT = 2;
/** Recently added recipes shown at the top of "RECENTLY USED". */
const RECENT_RECIPE_LIMIT = 3;

function householdRecipes(householdId: string): RecipeSummary[] {
  return recipesQuery()
    .all()
    .filter((r) => r.householdId === householdId);
}

const toRecipeSuggestion = ({ id, name, ingredientCount }: RecipeSummary): RecipeSuggestion => ({ id, name, ingredientCount });

/**
 * The household's recipes whose name matches the add text (spec 4.2, `rankRecipes`). Matches the whole text, so a
 * typed amount (`2 ta`) matches no recipe. Separate from `getSuggestions`, whose slots recipes never take.
 */
export function getRecipeSuggestions(householdId: string, text: string, limit = RECIPE_SUGGESTION_LIMIT): RecipeSuggestion[] {
  if (text.trim().length < 2) return [];
  return rankRecipes(householdRecipes(householdId), recipeAddTimes(householdId), householdId, text, limit).map(
    toRecipeSuggestion,
  );
}

/** The household's most recently added recipes, for the top of "RECENTLY USED" (spec 4.2, `recentRecipes`). */
export function getRecentRecipes(householdId: string, limit = RECENT_RECIPE_LIMIT): RecipeSuggestion[] {
  return recentRecipes(householdRecipes(householdId), recipeAddTimes(householdId), householdId, limit).map(
    toRecipeSuggestion,
  );
}
