// Spec 4.3.3: which aisle order a list uses, and the aisles in it. Pure: no React, SQLite or network.

/** Where the order came from: the viewer's own order, the household's, or the default store walk. */
export type AisleOrderSource = 'personal' | 'household' | 'default';

export type OrderedAisle = {
  id: string;
  /** Null for system aisles; the household for custom ones. */
  householdId: string | null;
  /** Store-walk order for system aisles (section 6.2); null for custom ones. */
  defaultRank: number | null;
  /** When a custom aisle was made; null when the device doesn't know. */
  createdAt: Date | null;
};

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const time = (d: Date | null) => d?.getTime() ?? 0;

/**
 * The aisles of a household in the order its lists use for one viewer (spec 4.3.3). `categories`
 * are the household's aisles: the system ones plus its own custom ones. `personal` and `household`
 * are the saved orders as category ids (null when there is none).
 *
 * The whole order comes from one source: the viewer's own, else the household's, else the
 * default. Aisles it doesn't place go after the ones it does: system aisles by default rank, then
 * custom aisles by `createdAt` (unknown first), then id. Ids that aren't among `categories` (gone,
 * or another household's) and repeats are skipped.
 */
export function resolveAisleOrder<C extends OrderedAisle>({
  personal,
  household,
  categories,
}: {
  personal: readonly string[] | null;
  household: readonly string[] | null;
  categories: readonly C[];
}): { categories: C[]; source: AisleOrderSource } {
  const source: AisleOrderSource = personal ? 'personal' : household ? 'household' : 'default';
  const order = personal ?? household ?? [];
  const known = new Map(categories.map((c) => [c.id, c]));
  const placed: C[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    const category = known.get(id);
    if (!category || seen.has(id)) continue;
    seen.add(id);
    placed.push(category);
  }
  const missing = categories.filter((c) => !seen.has(c.id));
  const system = missing
    .filter((c) => c.householdId === null)
    .sort((a, b) => (a.defaultRank ?? Infinity) - (b.defaultRank ?? Infinity) || byId(a, b));
  const custom = missing
    .filter((c) => c.householdId !== null)
    .sort((a, b) => time(a.createdAt) - time(b.createdAt) || byId(a, b));
  return { categories: [...placed, ...system, ...custom], source };
}
