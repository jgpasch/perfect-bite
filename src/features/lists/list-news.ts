// The "since you looked" card and NEW rows (spec 4.1, board 1 A): what the rest of the household
// added to a list since this device last had it on screen, worked out once as the list opens.
import { useCallback, useMemo, useState } from 'react';

import { addedWhen } from '@/domain/added-by';
import { nameOf, type MemberNames } from '@/features/households/member-names';
import { useListSeenMarker, type ListVisit, type MemberNews, type NewsItem } from '@/features/lists/last-seen';
import { formatDate, i18n } from '@/i18n';
import { displayItemName } from '@/shared';

/** The card names this many items, then "and 1 more". */
export const NEWS_NAMES_SHOWN = 3;
/** The card shows this many members' avatars. */
export const NEWS_AVATARS_SHOWN = 3;

/** Who added a new item, and when: the member with its latest add. */
export type NewItemBy = { userId: string; addedAt: Date };

/** One visit's news, frozen as the list opened. */
export type ListNews = {
  /** The marker the visit started from. */
  since: Date;
  /** When it was worked out: what "yesterday" is counted from for the whole visit. */
  at: Date;
  /** The members with news, most items first (`groupListNews`). */
  members: string[];
  /** Each new item once, newest add first. */
  items: NewsItem[];
  /** The rows to mark NEW. */
  byItem: ReadonlyMap<string, NewItemBy>;
};

/**
 * Folds `listNewsSince`'s per-member groups into one card's worth: an item two members both added to
 * counts once, under whoever added to it last. Null when there's nothing.
 */
export function summarizeNews(since: Date, at: Date, news: readonly MemberNews[]): ListNews | null {
  const byItem = new Map<string, NewItemBy>();
  const items = new Map<string, NewsItem>();
  for (const member of news) {
    for (const item of member.items) {
      const seen = byItem.get(item.itemId);
      if (!seen || seen.addedAt < item.addedAt) {
        byItem.set(item.itemId, { userId: member.userId, addedAt: item.addedAt });
        items.set(item.itemId, item);
      }
    }
  }
  if (items.size === 0) return null;
  return {
    since,
    at,
    members: news.filter((m) => m.items.length > 0).map((m) => m.userId),
    items: [...items.values()].sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime() || a.itemId.localeCompare(b.itemId)),
    byItem,
  };
}

/** "Alex added 4 items", "Alex and Sam added 7 items", "Alex, Sam and 2 others added 12 items". */
export function newsTitle(names: readonly string[], count: number): string {
  if (names.length <= 1) return i18n.t('lists.news.titleOne', { name: names[0] ?? i18n.t('addedBy.someone'), count });
  if (names.length === 2) return i18n.t('lists.news.titleTwo', { first: names[0], second: names[1], count });
  return i18n.t('lists.news.titleMany', {
    first: names[0],
    second: names[1],
    others: i18n.t('lists.news.others', { count: names.length - 2 }),
    count,
  });
}

/**
 * When the list was last seen, as the edit sheet's Added rows read it ("yesterday", "Tuesday",
 * "Mar 4"), with the time. Under an hour ago the minutes say enough on their own ("5 min ago").
 */
function sinceParts(since: Date, now: Date): { when: string; time: string | null } {
  const when = addedWhen(since, now);
  const recent = now.getTime() - since.getTime() < 60 * 60_000;
  return { when, time: recent ? null : formatDate(since, { hour: 'numeric', minute: '2-digit' }) };
}

/** The card's footnote: "Since you looked, yesterday at 6:40 PM". */
export function newsSinceLine(since: Date, now: Date): string {
  const { when, time } = sinceParts(since, now);
  return time ? i18n.t('lists.news.sinceAt', { when, time }) : i18n.t('lists.news.since', { when });
}

/** Up to three names, then "and 1 more", as stored: "eggs, limes, corn tortillas and 1 more". */
function namesList(items: readonly NewsItem[]): string {
  const names = items.map((i) => i.displayName.trim());
  if (names.length > NEWS_NAMES_SHOWN) {
    return i18n.t('lists.news.namesMore', {
      names: names.slice(0, NEWS_NAMES_SHOWN).join(', '),
      count: names.length - NEWS_NAMES_SHOWN,
    });
  }
  if (names.length <= 1) return names[0] ?? '';
  return i18n.t('lists.news.namesLast', { names: names.slice(0, -1).join(', '), last: names[names.length - 1] });
}

/** The card's item line, in sentence case: "Eggs, limes, corn tortillas and 1 more". */
export function newsItemsLine(items: readonly NewsItem[]): string {
  return displayItemName(namesList(items));
}

/** The members' short names, in the card's order. */
export function newsNames(news: ListNews, names: MemberNames, currentUserId: string | null): string[] {
  return news.members.map((userId) => nameOf(names, userId, currentUserId));
}

/** The whole card for VoiceOver: "Alex added 4 items since yesterday, 6:40 PM: eggs, limes, corn tortillas and 1 more". */
export function newsCardLabel(news: ListNews, memberNames: readonly string[], now: Date): string {
  const { when, time } = sinceParts(news.since, now);
  return i18n.t('lists.news.label', {
    title: newsTitle(memberNames, news.items.length),
    since: time ? i18n.t('lists.news.labelSinceAt', { when, time }) : when,
    names: namesList(news.items),
  });
}

/** A new row's second line, before its own: "Alex · yesterday". */
export function newRowLine(name: string, addedAt: Date, now: Date): string {
  return i18n.t('lists.news.rowLine', { name, when: addedWhen(addedAt, now) });
}

/** What VoiceOver adds to a new row: "new, added by Alex". */
export function newRowLabel(name: string): string {
  return i18n.t('lists.news.rowLabel', { name });
}

/** A row's NEW marking, if the item is in this visit's news: its line and VoiceOver part. */
export function rowNews(
  news: ListNews | null,
  itemId: string,
  names: MemberNames,
  currentUserId: string | null,
): { line: string; label: string } | undefined {
  const by = news?.byItem.get(itemId);
  if (!news || !by) return undefined;
  const name = nameOf(names, by.userId, currentUserId);
  return { line: newRowLine(name, by.addedAt, news.at), label: newRowLabel(name) };
}

/**
 * The news for this visit to a list (spec 4.1), keeping its marker as `useListSeenMarker` does: worked
 * out once as the list comes on screen and frozen while it stays (live arrivals get their own cue),
 * gone once it leaves, so coming back shows only what's new since. ✕ hides the card for this visit;
 * the rows stay NEW.
 */
export function useListVisitNews(
  listId: string,
  onScreen: boolean,
): { news: ListNews | null; dismissed: boolean; dismiss: () => void } {
  const visit = useListSeenMarker(listId, onScreen);
  const news = useMemo(() => (visit ? summarizeNews(visit.since, visit.at, visit.news) : null), [visit]);
  // A dismissal belongs to the visit it was made in; the next visit is a new object.
  const [dismissedVisit, setDismissedVisit] = useState<ListVisit | null>(null);
  const dismiss = useCallback(() => setDismissedVisit(visit), [visit]);
  return { news, dismissed: visit !== null && dismissedVisit === visit, dismiss };
}
