// A row that arrives while you look (spec 4.1, board 2 E): another member's add, or their Combine
// into an item, reaching a list that's on screen. The row grows in and wears a NEW badge
// (`list-news.ts`); VoiceOver hears who added what.
import { and, eq, isNull } from 'drizzle-orm';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import { db, listItemContributions, listItems } from '@/db';
import { nameOf, type MemberNames } from '@/features/households/member-names';
import { SEEN_CLOCK_SKEW_MS } from '@/features/lists/last-seen';
import { i18n } from '@/i18n';

import type { ItemView } from './items';

/** VoiceOver hears at most one arrival announcement this often; what comes between is grouped. */
export const ANNOUNCE_EVERY_MS = 5000;

/** One arrival: an item on the list that another member just added, or added to. */
export type Arrival = {
  itemId: string;
  /** The member whose add it was (the latest, if several came at once). */
  userId: string;
  /** The item's name as stored, for VoiceOver: "limes". */
  displayName: string;
  /** That add's contribution. */
  contributionId: string;
  /** Every amount they added this visit, for the "+1 box" badge. */
  contributionIds: string[];
  /** A row that wasn't on the list to get (a new item, or a checked one re-added): it grows in. */
  grow: boolean;
};

/** What was on the list when the visit began, and since: every amount, and the items still to get. */
export type ListContents = { contributions: ReadonlySet<string>; open: ReadonlySet<string> };

export function listContents(items: readonly ItemView[]): ListContents {
  return {
    contributions: new Set(items.flatMap((item) => item.contributions.map((c) => c.id))),
    open: new Set(items.filter((item) => item.checkedAt === null).map((item) => item.id)),
  };
}

/**
 * The list's contents straight from the database, read once as a visit begins: the live query may
 * not have run yet, and what's there already is never an arrival.
 */
export function readListContents(listId: string): ListContents {
  const rows = db
    .select({ itemId: listItems.id, checkedAt: listItems.checkedAt, contributionId: listItemContributions.id })
    .from(listItems)
    .leftJoin(
      listItemContributions,
      and(eq(listItemContributions.listItemId, listItems.id), isNull(listItemContributions.deletedAt)),
    )
    .where(and(eq(listItems.listId, listId), isNull(listItems.deletedAt)))
    .all();
  return {
    contributions: new Set(rows.flatMap((r) => (r.contributionId ? [r.contributionId] : []))),
    open: new Set(rows.filter((r) => r.checkedAt === null).map((r) => r.itemId)),
  };
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((v) => b.has(v));

/**
 * The items to get that gained an amount since `before` from another member: not `me` (any of my
 * devices, Siri on my account), not a null `added_by`, and made on the server after `from` (pull
 * catching up on what was there before the list was shown doesn't count).
 */
export function detectArrivals(
  before: ListContents,
  items: readonly ItemView[],
  me: string | null,
  from: Date,
): Arrival[] {
  const arrivals: Arrival[] = [];
  for (const item of items) {
    if (item.checkedAt !== null) continue;
    const added = item.contributions.filter(
      (c) => !before.contributions.has(c.id) && c.addedBy !== null && c.addedBy !== me && c.createdAt > from,
    );
    if (added.length === 0) continue;
    const latest = added.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
    arrivals.push({
      itemId: item.id,
      userId: latest.addedBy!,
      displayName: item.displayName.trim(),
      contributionId: latest.id,
      contributionIds: added.map((c) => c.id),
      grow: !before.open.has(item.id),
    });
  }
  return arrivals;
}

type Tracking = {
  listId: string;
  onScreen: boolean;
  /** Null while the list isn't on screen. */
  contents: ListContents | null;
  /** Amounts made on the server before this don't count. */
  from: Date;
  /** Each arrived row this visit still to get: its growth and badge (NEW, or "+1 box"). */
  cues: ReadonlyMap<string, Arrival>;
  /** The latest arrivals, for VoiceOver; `seq` counts them. */
  latest: { seq: number; arrivals: Arrival[] };
};

const EMPTY: ReadonlyMap<string, Arrival> = new Map();

function idle(listId: string, onScreen: boolean, latest: Tracking['latest']): Tracking {
  return { listId, onScreen, contents: null, from: new Date(0), cues: EMPTY, latest };
}

/** A row's later arrival keeps what came before: it still grew in, with every amount added since. */
const withArrivals = (map: ReadonlyMap<string, Arrival>, arrivals: readonly Arrival[]) =>
  new Map([
    ...map,
    ...arrivals.map((a) => {
      const before = map.get(a.itemId);
      const merged = before
        ? { ...a, grow: before.grow || a.grow, contributionIds: [...new Set([...before.contributionIds, ...a.contributionIds])] }
        : a;
      return [a.itemId, merged] as const;
    }),
  ]);
const keepOpen = (map: ReadonlyMap<string, Arrival>, open: ReadonlySet<string>) =>
  [...map.keys()].every((id) => open.has(id)) ? map : new Map([...map].filter(([id]) => open.has(id)));

/**
 * Tracks arrivals on list `listId` while it's on screen (the Keep screen on rule, in the foreground).
 * A visit starts from what's on the list as it comes on screen; leaving ends it and clears every cue.
 * `items` are the live query's items, checked ones too.
 *
 * Worked out as the live query's rows come in, during render, so a new row mounts already knowing
 * it arrived (its entering animation is picked as it mounts).
 */
export function useListArrivals(listId: string, items: readonly ItemView[], onScreen: boolean, me: string | null) {
  const [tracking, setTracking] = useState<Tracking>(() =>
    onScreen ? start(listId, { seq: 0, arrivals: [] }) : idle(listId, false, { seq: 0, arrivals: [] }),
  );
  let next = tracking;
  if (tracking.listId !== listId || tracking.onScreen !== onScreen) {
    next = onScreen ? start(listId, tracking.latest) : idle(listId, false, tracking.latest);
  } else if (tracking.contents) {
    const now = listContents(items);
    // The live query can lag the visit's first read: a row it hasn't shown yet isn't gone.
    const contributions = new Set([...tracking.contents.contributions, ...now.contributions]);
    if (!sameSet(contributions, tracking.contents.contributions) || !sameSet(now.open, tracking.contents.open)) {
      const arrivals = detectArrivals(tracking.contents, items, me, tracking.from);
      next = {
        ...tracking,
        contents: { contributions, open: now.open },
        cues: keepOpen(withArrivals(tracking.cues, arrivals), now.open),
        latest: arrivals.length > 0 ? { seq: tracking.latest.seq + 1, arrivals } : tracking.latest,
      };
    }
  }
  if (next !== tracking) setTracking(next);
  return { cues: next.cues, latest: next.latest };
}

function start(listId: string, latest: Tracking['latest']): Tracking {
  return {
    ...idle(listId, true, latest),
    contents: readListContents(listId),
    from: new Date(Date.now() - SEEN_CLOCK_SKEW_MS),
  };
}

/**
 * What VoiceOver says for some arrivals, one sentence per member in the order they came: "Alex added
 * limes", or grouped, "Alex added 3 items" (an item counts once).
 */
export function arrivalAnnouncement(arrivals: readonly Arrival[], names: MemberNames, currentUserId: string | null): string {
  const byMember = new Map<string, Map<string, string>>();
  for (const a of arrivals) {
    const items = byMember.get(a.userId) ?? new Map<string, string>();
    byMember.set(a.userId, items);
    items.set(a.itemId, a.displayName);
  }
  return [...byMember]
    .map(([userId, items]) => {
      const name = nameOf(names, userId, currentUserId);
      return items.size === 1
        ? i18n.t('lists.arrivals.addedOne', { name, item: [...items.values()][0] })
        : i18n.t('lists.arrivals.addedMany', { name, count: items.size });
    })
    .join('. ');
}

/**
 * Announces each batch of `latest` arrivals to VoiceOver, at most once every 5 s: the first at once,
 * then whatever came in the meantime as one grouped announcement. `active` false (the list left the
 * screen) drops what's waiting. No haptic and no sound.
 */
export function useArrivalAnnouncements(
  latest: { seq: number; arrivals: Arrival[] },
  active: boolean,
  names: MemberNames,
  currentUserId: string | null,
): void {
  const waiting = useRef<Arrival[]>([]);
  const lastAt = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Read when the announcement is made, so a name that's just arrived is used.
  const namesRef = useRef({ names, currentUserId });
  useEffect(() => {
    namesRef.current = { names, currentUserId };
  }, [names, currentUserId]);

  const flush = useCallback(() => {
    timer.current = null;
    if (waiting.current.length === 0) return;
    const { names: memberNames, currentUserId: me } = namesRef.current;
    AccessibilityInfo.announceForAccessibility(arrivalAnnouncement(waiting.current, memberNames, me));
    waiting.current = [];
    lastAt.current = Date.now();
  }, []);

  const seen = useRef(latest.seq);
  useEffect(() => {
    if (latest.seq === seen.current) return;
    seen.current = latest.seq;
    if (!active) return;
    waiting.current.push(...latest.arrivals);
    if (timer.current) return;
    const wait = lastAt.current === null ? 0 : lastAt.current + ANNOUNCE_EVERY_MS - Date.now();
    if (wait <= 0) flush();
    else timer.current = setTimeout(flush, wait);
  }, [latest, active, flush]);

  useEffect(() => {
    if (active) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    waiting.current = [];
  }, [active]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
}
