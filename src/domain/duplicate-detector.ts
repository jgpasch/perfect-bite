// Spec 4.4: what an add does when the ingredient is already on the list. Pure.

export type ExistingItem = { id: string; ingredientName: string; checkedAt: Date | null };

export type AddDecision =
  /** Not on the list (or only deleted): a new item. */
  | { kind: 'new' }
  /** Open on the list: add the amount to it (Combine). */
  | { kind: 'combine'; itemId: string }
  /** Only checked on the list: uncheck it and replace its amounts ("you need it again"). */
  | { kind: 'reopen'; itemId: string };

/** Decides one add against the list's live items. An open match wins over checked ones. */
export function detectDuplicate(ingredientName: string, existing: readonly ExistingItem[]): AddDecision {
  const matches = existing.filter((i) => i.ingredientName === ingredientName);
  const open = matches.find((i) => i.checkedAt === null);
  if (open) return { kind: 'combine', itemId: open.id };
  const checked = matches
    .filter((i) => i.checkedAt !== null)
    .sort((a, b) => b.checkedAt!.getTime() - a.checkedAt!.getTime())[0];
  return checked ? { kind: 'reopen', itemId: checked.id } : { kind: 'new' };
}

export type BulkDecision = AddDecision | { kind: 'sameAsEarlier'; index: number };

/**
 * Decides a bulk add (a recipe added to a list). The same ingredient twice in one batch
 * combines into the first occurrence. `conflicts` are the adds that match an open item: the
 * ones the bulk sheet asks about (Combine / Keep existing).
 */
export function planBulkAdd(
  ingredientNames: readonly string[],
  existing: readonly ExistingItem[],
): { decisions: BulkDecision[]; conflicts: number[] } {
  const firstIndex = new Map<string, number>();
  const decisions: BulkDecision[] = ingredientNames.map((name, index) => {
    const earlier = firstIndex.get(name);
    if (earlier !== undefined) return { kind: 'sameAsEarlier', index: earlier };
    firstIndex.set(name, index);
    return detectDuplicate(name, existing);
  });
  const conflicts = decisions.flatMap((d, i) => (d.kind === 'combine' ? [i] : []));
  return { decisions, conflicts };
}
