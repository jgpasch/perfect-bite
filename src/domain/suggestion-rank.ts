// Spec 4.2: orders the household's ingredient history, the catalog and the household's recipes, for autocomplete. Pure.

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

/**
 * The visible rows whose display name or key starts with `query` (case-insensitive), or has a
 * word that does, highest frecency first. At equal score a whole-name prefix match beats a word
 * match, then the shorter name, then alphabetical. An empty query matches nothing.
 */
export function rankHistory<T extends HistoryRow>(rows: readonly T[], query: string, now: Date): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return rows
    .flatMap((row) => {
      if (row.hiddenAt !== null) return [];
      const kind = matchKind([row.displayName, row.ingredientName], q);
      return kind ? [{ row, kind, score: frecency(row, now) }] : [];
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.kind === b.kind ? 0 : a.kind === 'prefix' ? -1 : 1) ||
        a.row.displayName.length - b.row.displayName.length ||
        (a.row.displayName < b.row.displayName ? -1 : a.row.displayName > b.row.displayName ? 1 : 0),
    )
    .map((m) => m.row);
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
