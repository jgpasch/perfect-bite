// Spec 4.2: orders the household's ingredient history for autocomplete. Pure.

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

/** 'prefix' when the whole name starts with the query, 'word' when a later word does. */
function matchKind(row: HistoryRow, query: string): 'prefix' | 'word' | null {
  const names = [row.displayName.toLowerCase(), row.ingredientName.toLowerCase()];
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
      const kind = matchKind(row, q);
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
