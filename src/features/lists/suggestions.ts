import { mergeSuggestions, rankRecipes } from '@/domain/suggestion-rank';
import { catalogEntry, searchCatalog } from '@/features/categories/categories';
import { recipeAddTimes, recipesQuery, type RecipeSummary } from '@/features/recipes/recipes';
import { displayItemName, parseQuantity } from '@/shared';

import { searchRecentItems } from './items';

export type Suggestion = { key: string; displayName: string; source: 'history' | 'catalog' };

/** With at least this many household history matches, the catalog is left out (spec 4.2). */
const HISTORY_ONLY_MIN = 2;

/**
 * Add-bar autocomplete (spec 4.2), in `mergeSuggestions`' order: the suggestion that is the typed name (normalized as
 * an add, so `coffees` gives Coffee) first, from history or the catalog; then shorter names before longer ones, from
 * either source; at equal length a prefix match before a word match, then frecency, history before the catalog, then
 * alphabetical. With 2 or more history matches the catalog is left out, except its entry for the typed name, which
 * always shows. Matches the name part of the text, so `2 lbs chi` suggests chicken thighs.
 * TODO(M6): limit catalog suggestions per spec 6.5 once server rows are cached.
 */
export function getSuggestions(householdId: string, text: string, limit = 5): Suggestion[] {
  const { name } = parseQuantity(text);
  if (name.trim().length < 2) return [];
  const history = searchRecentItems(householdId, name, limit);
  const exact = catalogEntry(name);
  const catalog = history.length < HISTORY_ONLY_MIN ? searchCatalog(name, limit) : [];
  return mergeSuggestions(history, exact ? [exact, ...catalog] : catalog, name, limit).map(
    ({ key, displayName, source }) => ({ key, displayName, source }),
  );
}

/** The add text with its name replaced by a suggestion, keeping a typed amount: `2 lbs chi` → `2 lbs chicken thighs`. */
export function applySuggestion(text: string, suggestion: Pick<Suggestion, 'key' | 'displayName'>): string {
  const { name } = parseQuantity(text);
  const trimmed = text.trim();
  const prefix = name && trimmed.endsWith(name) ? trimmed.slice(0, trimmed.length - name.length) : '';
  return `${prefix}${suggestion.displayName}`;
}

/** A recipe chip in a list's add bar (spec 4.2): tapping it adds the whole recipe at 1×. */
export type RecipeSuggestion = { id: string; name: string; ingredientCount: number };

/** Recipe chips shown after the item suggestions while typing: a guard on the row's length, not a product cap. */
const RECIPE_SUGGESTION_LIMIT = 20;

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

/** A chip in the list add bar's suggestion row. `text` is what tapping an item chip adds. */
export type SuggestionChip =
  | { kind: 'recipe'; key: string; recipe: RecipeSuggestion }
  | { kind: 'item'; key: string; label: string; text: string; removable: boolean };

/**
 * The chip row above the add bar (spec 4.2): autocomplete (household history and the catalog, in `getSuggestions`'
 * order), each adding the typed amount with its name, then matching recipes. Empty while the field is empty (whitespace counts) and when
 * nothing matches, so the row collapses.
 */
export function suggestionChips(
  text: string,
  sources: { recipes: readonly RecipeSuggestion[]; suggestions: readonly Suggestion[] },
): SuggestionChip[] {
  if (!text.trim()) return [];
  return [
    ...sources.suggestions.map(
      (s): SuggestionChip => ({
        kind: 'item',
        key: s.key,
        label: displayItemName(s.displayName),
        text: applySuggestion(text, s),
        removable: s.source === 'history',
      }),
    ),
    ...sources.recipes.map((r): SuggestionChip => ({ kind: 'recipe', key: `recipe-${r.id}`, recipe: r })),
  ];
}
