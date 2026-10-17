// Last seen per list (spec 4.1): when this device last had a list on screen, and what the rest of
// the household added to it since, for the rows marked NEW.
import { and, desc, eq, gt, isNotNull, isNull, ne } from 'drizzle-orm';
import { useEffect, useState } from 'react';

import { db, listItemContributions, listItems, lists } from '@/db';
import { getAccount } from '@/features/auth/account';
import { useForeground } from '@/features/lists/keep-awake';
import { listSeenAtKey } from '@/features/lists/list-view';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';

/** Server and device clocks can disagree by this much; news counts from this long before the marker. */
export const SEEN_CLOCK_SKEW_MS = 2 * 60 * 1000;

/** When the list was last seen on this device, or null if it never was. */
export function getListSeenAt(listId: string): Date | null {
  const value = getDeviceSetting<unknown>(listSeenAtKey(listId), null);
  return typeof value === 'number' ? new Date(value) : null;
}

/**
 * Moves the list's marker to `at`. A list this device no longer has (its household purged) gets none,
 * so a screen closing after the purge can't leave a setting behind.
 */
export function markListSeen(listId: string, at: Date = new Date()): void {
  if (!db.select({ id: lists.id }).from(lists).where(eq(lists.id, listId)).get()) return;
  setDeviceSetting(listSeenAtKey(listId), at.getTime());
}

/** One visit to a list: the marker it started from and the news since it, read once (`at`) as it began. */
export type ListVisit = { listId: string; since: Date; at: Date; news: MemberNews[] };

/**
 * Keeps the list's marker: set to now whenever the list stops being on screen after being shown in
 * the foreground (`onScreen` going false, the app going to the background, or the screen closing:
 * another list, or this one deleted or archived). A list shown for the first time on this device has
 * no marker, so it's set at once and shows no news.
 *
 * Returns the current visit: `listNewsSince` the marker, read once as the list came on screen and
 * kept while it stays there (null before it's read, off screen, or with no marker), for the rows
 * marked NEW on open.
 */
export function useListSeenMarker(listId: string, onScreen: boolean): ListVisit | null {
  const foreground = useForeground();
  const shown = onScreen && foreground;
  const [visit, setVisit] = useState<ListVisit | null>(null);
  useEffect(() => {
    if (!shown) return;
    const since = getListSeenAt(listId);
    let live = true;
    if (since === null) markListSeen(listId);
    else {
      listNewsSince(listId, since).then(
        (news) => {
          if (live) setVisit({ listId, since, at: new Date(), news });
        },
        (err: unknown) => console.warn(`[lists] couldn't read the news on ${listId}`, err),
      );
    }
    return () => {
      live = false;
      markListSeen(listId);
      setVisit(null);
    };
  }, [listId, shown]);
  return shown && visit?.listId === listId ? visit : null;
}

export type NewsItem = { itemId: string; displayName: string; addedAt: Date };
/** One other member's news: their items, newest add first. */
export type MemberNews = { userId: string; items: NewsItem[] };

type NewsRow = { itemId: string; displayName: string; userId: string | null; addedAt: Date };

/**
 * Groups contribution rows per member: an item counts once per member however many of their
 * contributions it has, dated by their latest. Members with the most items come first, then the most
 * recent. An item two members both added to is in both.
 */
export function groupListNews(rows: readonly NewsRow[]): MemberNews[] {
  const byMember = new Map<string, Map<string, NewsItem>>();
  for (const row of rows) {
    if (row.userId === null) continue;
    const items = byMember.get(row.userId) ?? new Map<string, NewsItem>();
    byMember.set(row.userId, items);
    const seen = items.get(row.itemId);
    if (!seen || seen.addedAt < row.addedAt) {
      items.set(row.itemId, { itemId: row.itemId, displayName: row.displayName, addedAt: row.addedAt });
    }
  }
  const news = [...byMember].map(([userId, items]) => ({
    userId,
    items: [...items.values()].sort((a, b) => b.addedAt.getTime() - a.addedAt.getTime() || a.itemId.localeCompare(b.itemId)),
  }));
  const newest = (m: MemberNews) => m.items[0].addedAt.getTime();
  return news.sort((a, b) => b.items.length - a.items.length || newest(b) - newest(a) || a.userId.localeCompare(b.userId));
}

/**
 * What other members added to list `listId` since `since` (spec 4.1), per member: its live unchecked
 * items with a live contribution (a new item or a Combine into one) that member added after
 * `since - 2 min`, by the server `created_at` pull stores. Adds by `me` (from any device, Siri on
 * this account too) or with a null `added_by` never count. Re-runs on every `then`, so it works with
 * `useLiveQueryOn(…, LIST_NEWS_QUERY_TABLES)`.
 */
export function listNewsSince(
  listId: string,
  since: Date,
  me: string | null = getAccount()?.userId ?? null,
): PromiseLike<MemberNews[]> {
  const from = new Date(since.getTime() - SEEN_CLOCK_SKEW_MS);
  const query = db
    .select({
      itemId: listItems.id,
      displayName: listItems.displayName,
      userId: listItemContributions.addedBy,
      addedAt: listItemContributions.createdAt,
    })
    .from(listItemContributions)
    .innerJoin(listItems, eq(listItems.id, listItemContributions.listItemId))
    .where(
      and(
        eq(listItems.listId, listId),
        isNull(listItems.deletedAt),
        isNull(listItems.checkedAt),
        isNull(listItemContributions.deletedAt),
        isNotNull(listItemContributions.addedBy),
        me === null ? undefined : ne(listItemContributions.addedBy, me),
        gt(listItemContributions.createdAt, from),
      ),
    )
    .orderBy(desc(listItemContributions.createdAt));
  return {
    then: (onFulfilled, onRejected) => query.then(groupListNews).then(onFulfilled, onRejected),
  };
}

/** Tables `listNewsSince` reads, for `useLiveQueryOn`. */
export const LIST_NEWS_QUERY_TABLES = [listItems, listItemContributions];
