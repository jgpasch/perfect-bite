// Where an imported recipe is saved (spec 4.10): a household, and optionally one of its lists. The
// share extension mirrors these rules in Swift (`ShareChoice` in
// targets/share-recipe/ShareChoice.swift); keep the two in sync by hand.
import { launchListId } from '@/features/lists/list-view';

export type ChoiceLists = {
  lastOpenedListId: string | null;
  defaultListId?: string | null;
  /** Live lists, in order. */
  lists: readonly { id: string; householdId: string }[];
  /** Every household, in order, including any with no lists. */
  households: readonly { id: string }[];
};

/**
 * The household a recipe is saved to by default: the household of the list the picker would pick
 * (last opened, then default, then first), else the first household; null with no households.
 */
export function defaultHouseholdId(choices: ChoiceLists): string | null {
  const listId = launchListId(choices.lastOpenedListId, choices.defaultListId ?? null, choices.lists);
  const householdId = choices.lists.find((l) => l.id === listId)?.householdId;
  if (householdId && choices.households.some((h) => h.id === householdId)) return householdId;
  return choices.households[0]?.id ?? null;
}

/** The household's lists, in order. */
export function householdLists<L extends { householdId: string }>(lists: readonly L[], householdId: string | null): L[] {
  return lists.filter((l) => l.householdId === householdId);
}

/** The default list within a household, by the same rule (last opened, default, first); null with none. */
export function defaultListIdIn(choices: ChoiceLists, householdId: string | null): string | null {
  return launchListId(
    choices.lastOpenedListId,
    choices.defaultListId ?? null,
    householdLists(choices.lists, householdId),
  );
}

/** The save button: "Save recipe" with the list off, "Save & add to <list>" with it on. */
export function saveButtonTitle(addToList: boolean, listName: string | null): string {
  return addToList ? `Save & add to ${listName ?? 'list'}` : 'Save recipe';
}

/** What the share sheet says after saving. */
export function shareSavedMessage(addToList: boolean): string {
  return addToList
    ? "Added. It'll be on your list when you open The Perfect Bite."
    : "Saved. It'll be in your recipes when you open The Perfect Bite.";
}

export const NO_LISTS_IN_HOUSEHOLD = 'This household has no lists';

/**
 * The share envelope's target fields: `listId` only when adding to a list. The switch on with no
 * list (a household with no lists, where it's disabled) saves the recipe only.
 */
export function shareEnvelopeTarget(
  householdId: string | null,
  addToList: boolean,
  listId: string | null,
): { householdId: string | null; addToList: boolean; listId: string | null } {
  const on = addToList && listId !== null;
  return { householdId, addToList: on, listId: on ? listId : null };
}
