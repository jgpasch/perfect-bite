// What the "Add recipe from link…" sheet shows (spec 4.10). Pure, so it can be tested without rendering.

import { resetDate } from '@/features/plans/limits';
import { i18n, onLanguageChanged } from '@/i18n';

import { addedRecipeToListToast } from './recipe-view';
import type { ImportRecipeError } from './import';

/** Characters that end a sentence around a link rather than belong to it. */
const TRAILING_PUNCTUATION = /[.,;:!?'"’”]+$/;

/**
 * The link in what the user pasted or typed: the first `http(s)` URL (apps share a URL inside text,
 * spec 4.10), without the punctuation that ends the sentence around it. A bare `example.com/path`
 * typed on its own gets `https://`. Null when there's no link.
 */
export function urlFromText(text: string): string | null {
  const found = /https?:\/\/[^\s<>"']+/i.exec(text);
  if (found) return trimUrl(found[0]);
  const bare = text.trim();
  // One word with a dotted host, e.g. "smittenkitchen.com/2008/09/moms-apple-cake".
  if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#]\S*)?$/i.test(bare)) return trimUrl(`https://${bare}`);
  return null;
}

/** Drops trailing sentence punctuation, and closing brackets that weren't opened inside the URL. */
function trimUrl(url: string): string {
  let out = url;
  for (;;) {
    const next = out.replace(TRAILING_PUNCTUATION, '');
    const close = next.at(-1);
    const open = close === ')' ? '(' : close === ']' ? '[' : null;
    const unbalanced = open !== null && count(next, open) < count(next, close!);
    const trimmed = unbalanced ? next.slice(0, -1) : next;
    if (trimmed === out) return out;
    out = trimmed;
  }
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

/** What the sheet, a failed share and the imports card say when the plan has no recipe import (spec 4.10). */
// A live binding: follows the app's language once i18n is initialized.
export let NOT_ENTITLED_MESSAGE = '';
onLanguageChanged(() => {
  NOT_ENTITLED_MESSAGE = i18n.t('recipes.import.errors.notEntitled');
});

/**
 * The household's monthly imports are used up (spec 4.12): "You've used this month's recipe
 * imports. They reset on Nov 1.", for links and photos alike (they share the allowance). Never
 * "Try again in a minute".
 */
export function importLimitMessage(resetsAt: string): string {
  return i18n.t('recipes.import.errors.limitReached', { date: resetDate(resetsAt) });
}

/**
 * Under the import sheet's disabled button when the Save to household's plan has no recipe import
 * (spec 4.12): "Recipe import isn't included in Home's plan." Null when it has it.
 */
export function householdImportNote(canImport: boolean, householdName: string): string | null {
  return canImport ? null : i18n.t('recipes.import.householdNotEntitled', { household: householdName });
}

/** Spec 4.10's inline failure copy, for a link or photos; the sheet stays open. */
export function importErrorMessage(error: ImportRecipeError, from: 'link' | 'photo' = 'link'): string {
  switch (error.error) {
    case 'not_a_recipe':
      return i18n.t(from === 'photo' ? 'recipes.import.errors.photoNotARecipe' : 'recipes.import.errors.notARecipe');
    case 'not_entitled':
      return from === 'photo' ? i18n.t('recipes.import.errors.photoNotEntitled') : NOT_ENTITLED_MESSAGE;
    case 'rate_limited':
      return i18n.t('recipes.import.errors.rateLimited');
    case 'daily_limit':
      return i18n.t('errors.dailyLimit');
    case 'limit_reached':
      return importLimitMessage(error.resetsAt);
    case 'offline':
      return i18n.t('recipes.import.errors.offline');
    case 'blocked':
      return i18n.t('recipes.import.errors.blocked');
    case 'failed':
      if (error.reason === 'fetch_failed') return i18n.t('recipes.import.errors.fetchFailed');
      if (error.reason === 'invalid_url') return i18n.t('recipes.import.errors.invalidUrl');
      return i18n.t('recipes.import.errors.failed');
  }
}

/** The list screen's toast after an import: "Added Chicken tikka masala · 12 items", the name in bold. */
export function importedToast(recipeName: string, count: number): { message: string; emphasis: string } {
  return addedRecipeToListToast(recipeName, count);
}

/** The Recipes tab's toast for one shared recipe: "Added Chicken tikka masala · 12 items on Groceries". */
export function importedOnRecipesToast(
  recipeName: string,
  count: number,
  listName: string | null,
): { message: string; emphasis: string } {
  if (!listName) return importedToast(recipeName, count);
  return { message: i18n.t('recipes.toasts.addedOn', { name: recipeName, count, list: listName }), emphasis: recipeName };
}

/**
 * The Recipes tab's toast for one recipe-only share: "Saved Chicken tikka masala", or "Chicken tikka
 * masala is already in your recipes" when the import reused one with the same link.
 */
export function savedRecipeToast(recipeName: string, created: boolean): { message: string; emphasis: string } {
  return {
    message: i18n.t(created ? 'recipes.toasts.saved' : 'recipes.toasts.alreadySaved', { name: recipeName }),
    emphasis: recipeName,
  };
}

/** The list screen's toast when one share-queue drain imported several recipes: "Added 3 recipes". */
export function sharedImportsToast(count: number): { message: string } {
  return { message: i18n.t('recipes.toasts.sharedImports', { count }) };
}
