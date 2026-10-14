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

/**
 * Who added an amount: "Siri", the recipe's name, "You", or "Someone else". Other members' names
 * aren't stored on the device, so their adds can't be named yet.
 */
export function addedByLabel({ source, addedBy, recipeName }: AddedBy, userId: string | null): string {
  if (source === 'siri') return i18n.t('addedBy.siri');
  if (source === 'recipe') return recipeName?.trim() || i18n.t('addedBy.recipe');
  if (addedBy !== null && addedBy === userId) return i18n.t('addedBy.you');
  return i18n.t('addedBy.someoneElse');
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
 * The line under a checked item's name on its sheet: "Checked 5 min ago by you". Other members'
 * names aren't on the device (as in `addedByLabel`), so their checks read "by someone else"; a
 * check with no one recorded leaves the "by" off.
 */
export function checkedLine(checkedAt: Date, checkedBy: string | null, userId: string | null, now: Date): string {
  const when = addedWhen(checkedAt, now);
  if (checkedBy === null) return i18n.t('addedBy.checked', { when });
  return i18n.t(checkedBy === userId ? 'addedBy.checkedByYou' : 'addedBy.checkedBySomeoneElse', { when });
}

/** The second column of an "Added" row: "You, Tuesday". */
export function addedLine(add: AddedBy & { createdAt: Date }, userId: string | null, now: Date): string {
  return i18n.t('addedBy.line', { who: addedByLabel(add, userId), when: addedWhen(add.createdAt, now) });
}
