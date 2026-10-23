// Fractional positions for user-ordered rows (lists, households): a move writes one row, so
// concurrent reorders on two devices touch different rows (spec 7.1).

/** A position strictly between two neighbours. Pass null for "start" or "end". */
export function positionBetween(before: number | null, after: number | null): number {
  if (before === null && after === null) return 1;
  if (before === null) return after! - 1;
  if (after === null) return before + 1;
  return (before + after) / 2;
}

/**
 * The new position for the item at `from` when it moves to `to` (indices into `positions`,
 * sorted ascending; `to` is the index the item ends up at).
 */
export function positionForMove(positions: readonly number[], from: number, to: number): number {
  const rest = positions.filter((_, i) => i !== from);
  return positionBetween(rest[to - 1] ?? null, rest[to] ?? null);
}
