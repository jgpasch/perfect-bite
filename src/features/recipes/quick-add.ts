/** What the quick add needs of the current list. */
export type QuickAddCandidate = { id: string; name: string; householdId: string; archivedAt: Date | null };

/**
 * The list a recipe card's **Add to <list>** adds to (spec 4.5): the current list (`resolveCurrentListId`), when
 * there is one, it isn't archived and it's in the recipe's household, as Add to a list only offers those. Null, so
 * the menu leaves it out, otherwise or when the recipe has no ingredients.
 */
export function quickAddList(
  current: QuickAddCandidate | null | undefined,
  recipe: { householdId: string; ingredientCount: number },
): { id: string; name: string } | null {
  if (!current || current.archivedAt !== null) return null;
  if (current.householdId !== recipe.householdId || recipe.ingredientCount === 0) return null;
  return { id: current.id, name: current.name };
}

/** The menu item's title: "Add to Groceries". */
export function quickAddTitle(listName: string): string {
  return `Add to ${listName}`;
}
