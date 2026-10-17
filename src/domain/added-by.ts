// The "Added" rows on the item sheet (spec 4.4, board 04): who added each amount, and when,
// e.g. "You, Tuesday" or "Siri, just now".

import { formatDate, i18n, shortDate } from '@/i18n';

export type AddedBy = {
  source: 'manual' | 'recipe' | 'siri';
  /** The user who added it; null on old rows. */
  addedBy: string | null;
  /** The recipe's name for a recipe add; null once the recipe is deleted. */
  recipeName: string | null;
};

/** Who made an add: "You", their short name, or "Someone else" when it isn't on the device. */
function adderName(addedBy: string | null, userId: string | null, names: ReadonlyMap<string, string>): string {
  if (addedBy !== null && addedBy === userId) return i18n.t('addedBy.you');
  return (addedBy !== null && names.get(addedBy)) || i18n.t('addedBy.someoneElse');
}

/**
 * Who added an amount: "Siri"; "You"; another member's short name (`names`: the household's,
 * `useMemberNames`); "Someone else" when their name isn't on the device (removed, deleted, not
 * loaded yet) or an old row has no `added_by`. A recipe add is the recipe's name, followed by who
 * added it when that wasn't you ("Shakshuka · Alex").
 */
export function addedByLabel(
  { source, addedBy, recipeName }: AddedBy,
  userId: string | null,
  names: ReadonlyMap<string, string> = new Map(),
): string {
  if (source === 'siri') return i18n.t('addedBy.siri');
  if (source === 'recipe') {
    const recipe = recipeName?.trim() || i18n.t('addedBy.recipe');
    if (addedBy === null || addedBy === userId) return recipe;
    return i18n.t('addedBy.recipeBy', { recipe, name: adderName(addedBy, userId, names) });
  }
  return adderName(addedBy, userId, names);
}

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * When an amount was added, relative to `now` in local time: "just now" (under a minute, or a
 * clock that's ahead), "5 min ago", "today", "yesterday", a weekday within the last week, then
 * "Mar 4" ("Mar 4, 2025" in another year). Weekdays and dates are in the app's language
 * ("martes", "4 mar").
 */
export function addedWhen(at: Date, now: Date): string {
  const ms = now.getTime() - at.getTime();
  if (ms < 60_000) return i18n.t('addedBy.justNow');
  if (ms < 60 * 60_000) return i18n.t('addedBy.minutesAgo', { minutes: Math.floor(ms / 60_000) });
  // Round: a day across a daylight-saving change is 23 or 25 hours.
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days === 0) return i18n.t('addedBy.today');
  if (days === 1) return i18n.t('addedBy.yesterday');
  if (days < 7) return formatDate(at, { weekday: 'long' });
  return shortDate(at, now);
}

/**
 * The line under a checked item's name on its sheet: "Checked 5 min ago by you", "… by Alex" for
 * another member (`names`: the household's short names, `useMemberNames`), or "… by someone" when
 * their name isn't on the device (removed, deleted, or not loaded yet). A check with no one
 * recorded leaves the "by" off.
 */
export function checkedLine(
  checkedAt: Date,
  checkedBy: string | null,
  userId: string | null,
  now: Date,
  names: ReadonlyMap<string, string> = new Map(),
): string {
  const when = addedWhen(checkedAt, now);
  if (checkedBy === null) return i18n.t('addedBy.checked', { when });
  if (checkedBy === userId) return i18n.t('addedBy.checkedByYou', { when });
  const name = names.get(checkedBy);
  return name ? i18n.t('addedBy.checkedBy', { when, name }) : i18n.t('addedBy.checkedBySomeone', { when });
}

/** The second column of an "Added" row: "You, Tuesday", "Alex, Tuesday", "Shakshuka · Alex, yesterday". */
export function addedLine(
  add: AddedBy & { createdAt: Date },
  userId: string | null,
  now: Date,
  names: ReadonlyMap<string, string> = new Map(),
): string {
  return i18n.t('addedBy.line', { who: addedByLabel(add, userId, names), when: addedWhen(add.createdAt, now) });
}
