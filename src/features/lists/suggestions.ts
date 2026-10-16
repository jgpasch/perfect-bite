import { rankRecipes } from '@/domain/suggestion-rank';
import { searchCatalog } from '@/features/categories/categories';
import { recipeAddTimes, recipesQuery, type RecipeSummary } from '@/features/recipes/recipes';
import { displayItemName, parseQuantity } from '@/shared';

import { searchRecentItems } from './items';

export type Suggestion = { key: string; displayName: string; source: 'history' | 'catalog' };

/** With at least this many household history matches, the catalog is left out (spec 4.2). */
const HISTORY_ONLY_MIN = 2;

/**
 * Add-bar autocomplete (spec 4.2): household history wins. With 2 or more history matches only history is shown;
 * with fewer, the catalog fills the remaining slots. Matches the name part of the text, so `2 lbs chi` suggests
 * chicken thighs. A match identical to the typed name is still shown, so typing a whole name (`dill`) keeps it first.
 * TODO(M6): limit catalog suggestions per spec 6.5 once server rows are cached.
 */
export function getSuggestions(householdId: string, text: string, limit = 5): Suggestion[] {
  const { name } = parseQuantity(text);
  if (name.trim().length < 2) return [];
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  const push = (rows: { key: string; displayName: string }[], source: Suggestion['source']) => {
    for (const r of rows) {
      if (out.length === limit) return;
      if (seen.has(r.key)) continue;
      seen.add(r.key);
      out.push({ key: r.key, displayName: r.displayName, source });
    }
  };
  push(searchRecentItems(householdId, name, limit), 'history');
  if (out.length < HISTORY_ONLY_MIN) push(searchCatalog(name, limit), 'catalog');
  return out;
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

/** Recipe rows shown above the item suggestions while typing. */
const RECIPE_SUGGESTION_LIMIT = 2;

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
 * The chip row above the add bar (spec 4.2): matching recipes, then autocomplete (household history, then the
 * catalog), each adding the typed amount with its name. Empty while the field is empty (whitespace counts) and when
 * nothing matches, so the row collapses.
 */
export function suggestionChips(
  text: string,
  sources: { recipes: readonly RecipeSuggestion[]; suggestions: readonly Suggestion[] },
): SuggestionChip[] {
  if (!text.trim()) return [];
  return [
    ...sources.recipes.map((r): SuggestionChip => ({ kind: 'recipe', key: `recipe-${r.id}`, recipe: r })),
    ...sources.suggestions.map(
      (s): SuggestionChip => ({
        kind: 'item',
        key: s.key,
        label: displayItemName(s.displayName),
        text: applySuggestion(text, s),
        removable: s.source === 'history',
      }),
    ),
  ];
}
