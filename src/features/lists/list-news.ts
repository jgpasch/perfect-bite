// NEW rows (spec 4.1, board 1 A): what the rest of the household added to a list since this device
// last had it on screen, worked out once as the list opens, and the badges' clocks (NEW, or "+1 box"
// on an item that was there): each badge goes 10 s after its row is first in sight.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Motion } from '@/constants/theme';
import { formatAmount } from '@/domain/quantity-display';
import { combineAmounts } from '@/domain/quantity-math';
import { countsInTotal, type ItemContribution } from '@/features/lists/items';
import { useListSeenMarker, type MemberNews } from '@/features/lists/last-seen';
import type { Unit } from '@/shared';

const NONE: ReadonlySet<string> = new Set();
const NO_NEWS: ReadonlyMap<string, RowNews> = new Map();

/**
 * One item's news this visit (spec 4.1): `fresh`, it wasn't on the list to get (NEW); otherwise others
 * added to it, and `added` are their contributions (the "+1 box" badge).
 */
export type RowNews = { fresh: boolean; added: ReadonlySet<string> };

/** Two sources' news for one item as one: fresh if either says so, and every add. */
export function mergeRowNews(a: RowNews | undefined, b: RowNews | undefined): RowNews | undefined {
  if (!a || !b) return a ?? b;
  return { fresh: a.fresh || b.fresh, added: new Set([...a.added, ...b.added]) };
}

/**
 * What a row's news shows (spec 4.1): NEW, or for an item that was there, what others added among
 * `contributions` (the row's amounts: one recipe's in By recipe) as one amount, `1 box` for "+1 box",
 * or `''` when it isn't one amount (the amount is tinted instead). Null when nothing shows: none of
 * those adds is an amount (a recipe link with no quantity), or none is this row's.
 */
export type RowBadge = { kind: 'new' } | { kind: 'added'; amount: string };

export function rowBadge(
  news: RowNews,
  contributions: readonly ItemContribution[],
  usualUnit: Unit | null,
): RowBadge | null {
  if (news.fresh) return { kind: 'new' };
  const added = contributions.filter((c) => news.added.has(c.id) && countsInTotal(c));
  if (added.length === 0) return null;
  const total = combineAmounts(added, usualUnit);
  return { kind: 'added', amount: total ? formatAmount(total) : '' };
}

/** `listNewsSince`'s per-member groups per item, each once. */
export function newsByItem(news: readonly MemberNews[]): ReadonlyMap<string, RowNews> {
  const byItem = new Map<string, RowNews>();
  for (const item of news.flatMap((member) => member.items)) {
    const row = { fresh: item.fresh, added: new Set(item.contributionIds) };
    byItem.set(item.itemId, mergeRowNews(byItem.get(item.itemId), row)!);
  }
  return byItem;
}

/**
 * The rows with news on open for this visit to a list (spec 4.1), keeping its marker as
 * `useListSeenMarker` does: worked out once as the list comes on screen and frozen while it stays (live
 * arrivals get their own cue), gone once it leaves, so coming back shows only what's new since. Empty
 * before it's read.
 */
export function useListVisitNews(listId: string, onScreen: boolean): ReadonlyMap<string, RowNews> {
  const visit = useListSeenMarker(listId, onScreen);
  return useMemo(() => (visit ? newsByItem(visit.news) : NO_NEWS), [visit]);
}

/** Whether a row (window coordinates) is in sight in the list's frame: its middle is inside it. */
export function inSight(row: { y: number; height: number }, viewport: { y: number; height: number }): boolean {
  const middle = row.y + row.height / 2;
  return middle >= viewport.y && middle <= viewport.y + viewport.height;
}

/**
 * The NEW badges' clocks for one visit to list `listId` (spec 4.1). A badge's clock starts the first
 * time its row is in sight (`seen`), and `Motion.newBadgeMs` later the badge is `gone`, not to come back
 * while the visit lasts. `active` false (the list off screen, or the app in the background) ends the
 * visit; the next one starts afresh.
 */
export function useNewBadgeClocks(listId: string, active: boolean) {
  const visit = active ? listId : null;
  const [state, setState] = useState<{ visit: string | null; gone: ReadonlySet<string> }>({ visit, gone: NONE });
  if (state.visit !== visit) setState({ visit, gone: NONE });

  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const running = timers.current;
    return () => {
      for (const timer of running.values()) clearTimeout(timer);
      running.clear();
    };
  }, [visit]);

  const seen = useCallback(
    (itemIds: readonly string[]) => {
      if (visit === null) return;
      for (const itemId of itemIds) {
        if (timers.current.has(itemId)) continue;
        const timer = setTimeout(
          () => setState((s) => (s.visit === visit ? { visit, gone: new Set([...s.gone, itemId]) } : s)),
          Motion.newBadgeMs,
        );
        timers.current.set(itemId, timer);
      }
    },
    [visit],
  );
  /** Whether a row's clock is running (or has run) this visit. */
  const started = useCallback((itemId: string) => timers.current.has(itemId), []);

  return { gone: state.visit === visit ? state.gone : NONE, seen, started };
}
