// The "Added" rows on the item sheet (spec 4.4, board 04): who added each amount, and when,
// e.g. "You, Tuesday" or "Siri, just now".

import { avatarInitial } from '@/domain/avatar-initial';
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

/** A run of an "Added by" row's text; `bold` ones are a member's name, in `ink` 700. */
export type TextPart = { text: string; bold: boolean };

export type AddedBySummary = {
  /** Up to three avatars, in the text's order: the others by their first add, then you. */
  people: { userId: string; initial: string }[];
  /** "Added by **Alex** · Tuesday", in runs. */
  text: TextPart[];
  /** What VoiceOver reads for the row: "Added by Alex, Tuesday". */
  label: string;
};

const MAX_AVATARS = 3;
// Marks a bold name inside a translated string, so the runs can be split back out after i18n.
const BOLD = '\u0001';

/**
 * The "Added by" row under the item's name on its sheet (spec 4.4): who added it, by everyone
 * with a live add. One person: "Added by Alex · Tuesday" (when = their earliest add) or "Added by
 * you · Tuesday"; two: "Added by Alex and you" (you last, no time); three or more: "Added by Alex,
 * Sam and 2 others". A Siri or recipe add counts as whoever made it (`added_by`); adds with no one
 * recorded, and deleted ones, are skipped. Null when no one's left.
 */
export function addedBySummary(
  contributions: readonly { addedBy: string | null; createdAt: Date; deletedAt?: Date | null }[],
  userId: string | null,
  names: ReadonlyMap<string, string>,
  now: Date,
): AddedBySummary | null {
  // Each person's earliest live add.
  const first = new Map<string, Date>();
  for (const c of contributions) {
    if (c.addedBy === null || c.deletedAt) continue;
    const seen = first.get(c.addedBy);
    if (!seen || c.createdAt < seen) first.set(c.addedBy, c.createdAt);
  }
  if (first.size === 0) return null;

  const ids = [...first.keys()].sort((a, b) => first.get(a)!.getTime() - first.get(b)!.getTime());
  const others = ids.filter((id) => id !== userId);
  const youAdded = others.length < ids.length;
  const ordered = youAdded ? [...others, userId!] : others;
  const people = ordered.slice(0, MAX_AVATARS).map((id) => ({ userId: id, initial: avatarInitial(names.get(id)) }));

  // A member's name in bold, or "someone" when it isn't on the device.
  const name = (id: string, bold: boolean) => {
    const known = names.get(id);
    if (!known) return i18n.t('addedBy.byNobody');
    return bold ? `${BOLD}${known}${BOLD}` : known;
  };

  let marked: string;
  let label: string;
  if (ordered.length === 1) {
    const when = addedWhen(first.get(ordered[0])!, now);
    if (youAdded) {
      marked = i18n.t('addedBy.byYou', { when });
      label = i18n.t('addedBy.byYouLabel', { when });
    } else {
      marked = i18n.t('addedBy.byOne', { name: name(ordered[0], true), when });
      label = i18n.t('addedBy.byOneLabel', { name: name(ordered[0], false), when });
    }
  } else if (ordered.length === 2 && youAdded) {
    marked = i18n.t('addedBy.byOneAndYou', { name: name(others[0], true) });
    label = i18n.t('addedBy.byOneAndYou', { name: name(others[0], false) });
  } else if (ordered.length === 2) {
    marked = i18n.t('addedBy.byTwo', { first: name(others[0], true), second: name(others[1], true) });
    label = i18n.t('addedBy.byTwo', { first: name(others[0], false), second: name(others[1], false) });
  } else {
    // With three or more, you're never one of the two named: there are at least two others.
    const count = ordered.length - 2;
    marked = i18n.t('addedBy.byMany', { first: name(ordered[0], true), second: name(ordered[1], true), count });
    label = i18n.t('addedBy.byMany', { first: name(ordered[0], false), second: name(ordered[1], false), count });
  }

  const text = marked
    .split(BOLD)
    .map((part, i) => ({ text: part, bold: i % 2 === 1 }))
    .filter((part) => part.text !== '');
  return { people, text, label };
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
