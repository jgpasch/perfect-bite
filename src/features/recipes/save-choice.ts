// Where an imported recipe is saved (spec 4.10): a household, and optionally one of its lists. The
// share extension mirrors these rules in Swift (`ShareChoice` in
// targets/share-recipe/ShareChoice.swift); keep the two in sync by hand.
import { launchListId } from '@/features/lists/list-view';
import { i18n, onLanguageChanged } from '@/i18n';

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
  if (!addToList) return i18n.t('recipes.import.save');
  return listName === null ? i18n.t('recipes.import.saveAndAddList') : i18n.t('recipes.import.saveAndAdd', { name: listName });
}

/** What the share sheet says after saving. */
export function shareSavedMessage(addToList: boolean): string {
  return addToList
    ? "Added. It'll be on your list when you open The Perfect Bite."
    : "Saved. It'll be in your recipes when you open The Perfect Bite.";
}

// A live binding: follows the app's language once i18n is initialized.
export let NO_LISTS_IN_HOUSEHOLD = '';
onLanguageChanged(() => {
  NO_LISTS_IN_HOUSEHOLD = i18n.t('recipes.import.noLists');
});

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

/**
 * Where the in-app import sheet opens (spec 4.10): from the Recipes tab (household by the default
 * rule, the switch as last left on this device), from a list's menu (that list's household, the
 * switch on with that list), or reopened by a failure's notification (the same choices as before).
 */
export type SheetEntry =
  | { from: 'recipes'; rememberedAddToList: boolean }
  | { from: 'list'; listId: string }
  | { from: 'retry'; householdId: string | null; addToList: boolean; listId: string | null };

export type SaveChoice = { householdId: string | null; addToList: boolean; listId: string | null };

/**
 * The sheet's starting choice for `entry`. A list or household that's gone by then falls back to
 * the default rule, and a list outside the chosen household gives that household's default list.
 */
export function initialSaveChoice(choices: ChoiceLists, entry: SheetEntry): SaveChoice {
  if (entry.from === 'list') {
    const list = choices.lists.find((l) => l.id === entry.listId);
    if (list) return { householdId: list.householdId, addToList: true, listId: list.id };
    const householdId = defaultHouseholdId(choices);
    return { householdId, addToList: true, listId: defaultListIdIn(choices, householdId) };
  }
  const retry = entry.from === 'retry' ? entry : null;
  const householdId =
    retry && choices.households.some((h) => h.id === retry.householdId) ? retry.householdId : defaultHouseholdId(choices);
  const kept = retry ? choices.lists.find((l) => l.id === retry.listId && l.householdId === householdId)?.id : undefined;
  return {
    householdId,
    addToList: retry ? retry.addToList : entry.from === 'recipes' && entry.rememberedAddToList,
    listId: kept ?? defaultListIdIn(choices, householdId),
  };
}

/** The device setting remembering the in-app sheet's switch (the share extension keeps its own). */
export const IMPORT_ADD_TO_LIST_KEY = 'importAddToList';
