// The "Added" rows on the item sheet (spec 4.4, board 04): who added each amount, and when,
// e.g. "You, Tuesday" or "Siri, just now".

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
  if (source === 'siri') return 'Siri';
  if (source === 'recipe') return recipeName?.trim() || 'A recipe';
  if (addedBy !== null && addedBy === userId) return 'You';
  return 'Someone else';
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * When an amount was added, relative to `now` in local time: "just now" (under a minute, or a
 * clock that's ahead), "5 min ago", "today", "yesterday", a weekday within the last week, then
 * "Mar 4" ("Mar 4, 2025" in another year).
 */
export function addedWhen(at: Date, now: Date): string {
  const ms = now.getTime() - at.getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)} min ago`;
  // Round: a day across a daylight-saving change is 23 or 25 hours.
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return WEEKDAYS[at.getDay()];
  const date = `${MONTHS[at.getMonth()]} ${at.getDate()}`;
  return at.getFullYear() === now.getFullYear() ? date : `${date}, ${at.getFullYear()}`;
}

/** The second column of an "Added" row: "You, Tuesday". */
export function addedLine(add: AddedBy & { createdAt: Date }, userId: string | null, now: Date): string {
  return `${addedByLabel(add, userId)}, ${addedWhen(add.createdAt, now)}`;
}
