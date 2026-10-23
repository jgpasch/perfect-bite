// Spec 4.4: what an add does when the ingredient is already on the list. Pure.

/** `familyKey` (spec 4.15): its `same_as`, else its own key; left out, its own key. */
export type ExistingItem = { id: string; ingredientName: string; familyKey?: string; checkedAt: Date | null };

export type AddDecision =
  /** Not on the list (or only deleted): a new item. */
  | { kind: 'new' }
  /** Open on the list: add the amount to it (Combine). */
  | { kind: 'combine'; itemId: string }
  /** Only checked on the list: uncheck it and replace its amounts ("you need it again"). */
  | { kind: 'reopen'; itemId: string };

/**
 * Decides one add against the list's live items. An item matches when it has the add's key or the
 * add's family key (`family`, spec 4.15: `pepino` and an item `cucumber`). An open match wins over
 * checked ones, and at each step the add's own key wins over another name of its family.
 */
export function detectDuplicate(
  ingredientName: string,
  existing: readonly ExistingItem[],
  family: string = ingredientName,
): AddDecision {
  const own = existing.filter((i) => i.ingredientName === ingredientName);
  const kin = existing.filter((i) => i.ingredientName !== ingredientName && (i.familyKey ?? i.ingredientName) === family);
  const open = own.find((i) => i.checkedAt === null) ?? kin.find((i) => i.checkedAt === null);
  if (open) return { kind: 'combine', itemId: open.id };
  const checked = latestChecked(own) ?? latestChecked(kin);
  return checked ? { kind: 'reopen', itemId: checked.id } : { kind: 'new' };
}

function latestChecked(items: readonly ExistingItem[]): ExistingItem | undefined {
  return items
    .filter((i) => i.checkedAt !== null)
    .sort((a, b) => b.checkedAt!.getTime() - a.checkedAt!.getTime())[0];
}

export type BulkDecision = AddDecision | { kind: 'sameAsEarlier'; index: number };

/**
 * Decides a bulk add (a recipe added to a list): each add as a single add would be decided, except
 * that the same ingredient twice in one batch (or two names of one family, `families[i]` being
 * the i-th name's family key) combines into the first occurrence.
 */
export function planBulkAdd(
  ingredientNames: readonly string[],
  existing: readonly ExistingItem[],
  families: readonly string[] = ingredientNames,
): BulkDecision[] {
  const firstIndex = new Map<string, number>();
  return ingredientNames.map((name, index) => {
    const family = families[index] ?? name;
    const earlier = firstIndex.get(family);
    if (earlier !== undefined) return { kind: 'sameAsEarlier', index: earlier };
    firstIndex.set(family, index);
    return detectDuplicate(name, existing, family);
  });
}
