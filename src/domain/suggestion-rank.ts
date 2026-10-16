// Spec 4.2: orders the household's ingredient history, the catalog and the household's recipes, for autocomplete. Pure.

import { normalizeIngredientName } from '@/shared';

export type HistoryRow = {
  /** Ingredient key. */
  ingredientName: string;
  displayName: string;
  useCount: number;
  lastUsedAt: Date;
  hiddenAt: Date | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** A use loses half its weight every 30 days. */
const HALF_LIFE_DAYS = 30;

/** Frecency: `use_count * 0.5^(days since last use / 30)`. A future time counts as now. */
export function frecency(row: HistoryRow, now: Date): number {
  const days = Math.max(0, (now.getTime() - row.lastUsedAt.getTime()) / DAY_MS);
  return row.useCount * 0.5 ** (days / HALF_LIFE_DAYS);
}

/** 'prefix' when a whole name starts with the (lowercase) query, 'word' when a later word does. */
function matchKind(rawNames: readonly string[], query: string): 'prefix' | 'word' | null {
  const names = rawNames.map((n) => n.toLowerCase());
  if (names.some((n) => n.startsWith(query))) return 'prefix';
  if (names.some((n) => n.split(/\s+/).some((w) => w.startsWith(query)))) return 'word';
  return null;
}

/** How a suggestion matches the typed text: `exact` when it is the typed name, plus its prefix or word match. */
type SuggestionMatch = { exact: boolean; kind: 'prefix' | 'word' };

/**
 * Matches `names` against the typed `query`: exact when one of them is the typed name, both normalized as an add
 * (`coffees` is `Coffee`), and a whole-name prefix or word match as `matchKind`. Null when neither applies.
 */
function matchSuggestion(names: readonly string[], query: string): SuggestionMatch | null {
  const typed = normalizeIngredientName(query);
  const exact = typed !== '' && names.some((n) => normalizeIngredientName(n) === typed);
  const kind = matchKind(names, query.trim().toLowerCase());
  if (kind) return { exact, kind };
  return exact ? { exact, kind: 'prefix' } : null;
}

type Matched = { match: SuggestionMatch; displayName: string };

/** The exact match first, then the shorter display name, then a whole-name prefix match before a word match. */
function compareMatches(a: Matched, b: Matched): number {
  return (
    Number(b.match.exact) - Number(a.match.exact) ||
    a.displayName.length - b.displayName.length ||
    (a.match.kind === b.match.kind ? 0 : a.match.kind === 'prefix' ? -1 : 1)
  );
}

const alphabetical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The visible rows whose display name or key starts with `query` (case-insensitive), has a word that does, or is
 * the typed name normalized as an add (`coffees` matches Coffee). The row that is the typed name comes first, then
 * shorter display names before longer ones (`chi`: Chives before Chicken thighs, however often they're bought); at
 * equal length a whole-name prefix match beats a word match, then higher frecency, then alphabetical. An empty
 * query matches nothing.
 */
export function rankHistory<T extends HistoryRow>(rows: readonly T[], query: string, now: Date): T[] {
  if (!query.trim()) return [];
  return rows
    .flatMap((row) => {
      if (row.hiddenAt !== null) return [];
      const match = matchSuggestion([row.displayName, row.ingredientName], query);
      return match ? [{ row, match, displayName: row.displayName, score: frecency(row, now) }] : [];
    })
    .sort((a, b) => compareMatches(a, b) || b.score - a.score || alphabetical(a.displayName, b.displayName))
    .map((m) => m.row);
}

/**
 * Merges autocomplete's two sources into the item chips' order (spec 4.2), deduped by key (history wins). The
 * suggestion that is the typed name (normalized as an add) comes first, from either source; then shorter names
 * before longer ones; at equal length a whole-name prefix match beats a word match, then history (in `history`'s
 * order, i.e. `rankHistory`'s frecency) before the catalog, then alphabetical. Rows that don't match `query` are
 * dropped; at most `limit`.
 */
export function mergeSuggestions<T extends { key: string; displayName: string }>(
  history: readonly T[],
  catalog: readonly T[],
  query: string,
  limit: number,
): (T & { source: 'history' | 'catalog' })[] {
  if (!query.trim()) return [];
  const seen = new Set<string>();
  const tagged = [
    ...history.map((row) => ({ row, source: 'history' as const })),
    ...catalog.map((row) => ({ row, source: 'catalog' as const })),
  ];
  return tagged
    .flatMap(({ row, source }, index) => {
      if (seen.has(row.key)) return [];
      seen.add(row.key);
      const match = matchSuggestion([row.displayName, row.key], query);
      return match ? [{ row, source, index, match, displayName: row.displayName }] : [];
    })
    .sort(
      (a, b) =>
        compareMatches(a, b) ||
        (a.source === b.source ? 0 : a.source === 'history' ? -1 : 1) ||
        (a.source === 'history' ? a.index - b.index : alphabetical(a.displayName, b.displayName)),
    )
    .slice(0, Math.max(0, limit))
    .map(({ row, source }) => ({ ...row, source }));
}

/** A catalog name as autocomplete sees it (spec 4.2), with its language (4.15; null when not known). */
export type CatalogRow = { key: string; displayName: string; lang: string | null };

/**
 * The catalog names whose display name starts with `query` (case-insensitive), or has it after a space, so a query of
 * several words matches mid-name (`chicken th` → `frozen chicken thighs`; spec 4.2). Names in the app's `language`
 * first (4.15: `leche` before `milk` in Spanish), then a whole-name prefix match before a word match, then the shorter
 * name, then alphabetical; at most `limit`. An empty query matches nothing.
 */
export function rankCatalog<T extends CatalogRow>(rows: readonly T[], query: string, language: string, limit: number): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return rows
    .flatMap((row) => {
      const name = row.displayName.toLowerCase();
      const kind = name.startsWith(q) ? 'prefix' : name.includes(` ${q}`) ? 'word' : null;
      return kind ? [{ row, kind, other: row.lang === language ? 0 : 1 }] : [];
    })
    .sort(
      (a, b) =>
        a.other - b.other ||
        (a.kind === b.kind ? 0 : a.kind === 'prefix' ? -1 : 1) ||
        a.row.displayName.length - b.row.displayName.length ||
        (a.row.displayName < b.row.displayName ? -1 : a.row.displayName > b.row.displayName ? 1 : 0),
    )
    .slice(0, Math.max(0, limit))
    .map((m) => m.row);
}

/** A household history row needs this many uses to count as usual: a one-off isn't. */
export const USUAL_MIN_USES = 2;

/**
 * The household's usual items, for the chip row of an empty add field (spec 4.2): visible rows used at least twice,
 * highest frecency first, then the most recently used, then by display name.
 */
export function rankUsual<T extends HistoryRow>(rows: readonly T[], now: Date): T[] {
  return rows
    .flatMap((row) => (row.hiddenAt === null && row.useCount >= USUAL_MIN_USES ? [{ row, score: frecency(row, now) }] : []))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.row.lastUsedAt.getTime() - a.row.lastUsedAt.getTime() ||
        (a.row.displayName < b.row.displayName ? -1 : a.row.displayName > b.row.displayName ? 1 : 0),
    )
    .map((m) => m.row);
}

/** A recipe as the add bar sees it (spec 4.2), with its number of live ingredients. */
export type RecipeRow = { id: string; name: string; householdId: string; ingredientCount: number; updatedAt: Date };

/** One time a recipe was added to a list: one per recipe contribution. */
export type RecipeUse = { recipeId: string; at: Date };

/** The latest add to a list of each recipe, in ms. */
function lastAdds(uses: readonly RecipeUse[]): Map<string, number> {
  const last = new Map<string, number>();
  for (const use of uses) last.set(use.recipeId, Math.max(last.get(use.recipeId) ?? -Infinity, use.at.getTime()));
  return last;
}

const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const squash = (text: string) => text.trim().replace(/\s+/g, ' ');

/**
 * The household's recipes for autocomplete (spec 4.2): the same prefix/word rule as history, on the recipe's
 * name. Most recently used first (the later of its last change and its last add to a list), then a whole-name
 * prefix match before a word match, then the shorter name, then alphabetical. Recipes in other households and
 * recipes with no ingredients (nothing to add) are left out; a query under 2 characters matches nothing. The
 * result is kept apart from item suggestions, so recipes never take their slots.
 */
export function rankRecipes<T extends RecipeRow>(
  recipes: readonly T[],
  uses: readonly RecipeUse[],
  householdId: string,
  query: string,
  limit: number,
): T[] {
  const q = squash(query).toLowerCase();
  if (q.length < 2) return [];
  const added = lastAdds(uses);
  return recipes
    .flatMap((recipe) => {
      if (recipe.householdId !== householdId || recipe.ingredientCount === 0) return [];
      const kind = matchKind([squash(recipe.name)], q);
      const lastUse = Math.max(recipe.updatedAt.getTime(), added.get(recipe.id) ?? -Infinity);
      return kind ? [{ recipe, kind, lastUse }] : [];
    })
    .sort(
      (a, b) =>
        b.lastUse - a.lastUse ||
        (a.kind === b.kind ? 0 : a.kind === 'prefix' ? -1 : 1) ||
        a.recipe.name.length - b.recipe.name.length ||
        byName(a.recipe, b.recipe),
    )
    .slice(0, Math.max(0, limit))
    .map((m) => m.recipe);
}
