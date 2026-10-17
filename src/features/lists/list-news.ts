// NEW rows (spec 4.1, board 1 A): what the rest of the household added to a list since this device
// last had it on screen, worked out once as the list opens, and the NEW badges' clocks: each badge
// goes 10 s after its row is first in sight.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Motion } from '@/constants/theme';
import { useListSeenMarker, type MemberNews } from '@/features/lists/last-seen';

const NONE: ReadonlySet<string> = new Set();

/** The items in `listNewsSince`'s per-member groups, each once. */
export function newItemIds(news: readonly MemberNews[]): ReadonlySet<string> {
  return new Set(news.flatMap((member) => member.items.map((item) => item.itemId)));
}

/**
 * The rows new on open for this visit to a list (spec 4.1), keeping its marker as `useListSeenMarker`
 * does: worked out once as the list comes on screen and frozen while it stays (live arrivals get their
 * own cue), gone once it leaves, so coming back shows only what's new since. Empty before it's read.
 */
export function useListVisitNews(listId: string, onScreen: boolean): ReadonlySet<string> {
  const visit = useListSeenMarker(listId, onScreen);
  return useMemo(() => (visit ? newItemIds(visit.news) : NONE), [visit]);
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
