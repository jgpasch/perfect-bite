// "Alex is adding" (spec 4.1, 7.2): while a list is on screen, in the foreground and online, the app
// joins the list's private Realtime channel, topic `list:<listId>`, and tracks `{ user_id, adding }`
// there. `adding` is true while the add field is focused and for ADDING_TAIL_MS after the last add,
// and goes out at most once per PRESENCE_THROTTLE_MS. Presence never carries what's being typed.
// The channel's RLS policies (migration `list_presence.sql`) keep it to the household's members. It's
// separate from the sync channels (`src/sync/realtime.ts`), whose topics are per client.
import type { RealtimeChannel } from '@supabase/supabase-js';
import { addNetworkStateListener } from 'expo-network';
import { useCallback, useEffect, useRef, useState } from 'react';

import { isOnline } from '@/features/categories/catch-up';
import { nameOf, type MemberNames } from '@/features/households/member-names';
import { i18n } from '@/i18n';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

/** How long after the last add someone still counts as adding. */
export const ADDING_TAIL_MS = 10_000;
/** At most one presence update per this long. */
export const PRESENCE_THROTTLE_MS = 1_000;

/** What each device tracks on a list's channel. Nothing about what's typed. */
export type ListPresence = { user_id: string; adding: boolean };

/** The list's presence topic. RLS matches this exact form. */
export function presenceTopic(listId: string): string {
  return `list:${listId}`;
}

/**
 * The members adding on a list, from its channel's presence state (keyed by presence key, each with
 * one entry per device): each user once, in the order they appear, and never `me` (on any device).
 */
export function othersAdding(state: Record<string, readonly Record<string, unknown>[]>, me: string | null): string[] {
  const adding: string[] = [];
  for (const metas of Object.values(state)) {
    for (const meta of metas) {
      const userId = meta.user_id;
      if (typeof userId !== 'string' || userId === me || meta.adding !== true || adding.includes(userId)) continue;
      adding.push(userId);
    }
  }
  return adding;
}

/** The header pill's text: "Alex is adding", "Alex and Sam are adding", "3 people are adding"; null for no one. */
export function addingPillText(userIds: readonly string[], names: MemberNames, currentUserId: string | null): string | null {
  const [first, second] = userIds.map((id) => nameOf(names, id, currentUserId));
  if (userIds.length === 0) return null;
  if (userIds.length === 1) return i18n.t('lists.presence.one', { name: first });
  if (userIds.length === 2) return i18n.t('lists.presence.two', { first, second });
  return i18n.t('lists.presence.many', { count: userIds.length });
}

/**
 * Sends at most once per `ms`: the first value at once, then, within the window, only the latest,
 * at its end.
 */
export function createThrottle<T>(send: (value: T) => void, ms: number = PRESENCE_THROTTLE_MS) {
  let lastSentAt = -Infinity;
  let pending: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    if (!pending) return;
    const { value } = pending;
    pending = null;
    lastSentAt = Date.now();
    send(value);
  };
  return {
    push(value: T) {
      pending = { value };
      if (timer) return;
      const wait = lastSentAt + ms - Date.now();
      if (wait <= 0) flush();
      else timer = setTimeout(flush, wait);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

/** Leaves still in progress, by topic. Realtime hands back an existing channel for a topic, so a join waits for these. */
const leaving = new Map<string, Promise<unknown>>();

export type ListPresenceSession = {
  /** Whether this user is adding now; tracked (throttled) once the channel is joined. */
  setAdding: (adding: boolean) => void;
  /** Leaves the channel, which drops this device's presence. */
  leave: () => void;
};

/**
 * Joins list `listId`'s presence channel as `userId`, tracking `adding`, and reports the other
 * members adding (`othersAdding`) whenever presence syncs.
 */
export function joinListPresence(
  listId: string,
  userId: string,
  adding: boolean,
  onOthers: (userIds: string[]) => void,
): ListPresenceSession {
  const topic = presenceTopic(listId);
  let current = adding;
  let left = false;
  let channel: RealtimeChannel | null = null;
  let joined = false;
  const throttle = createThrottle<boolean>((value) => {
    if (channel && joined && !left) void channel.track({ user_id: userId, adding: value } satisfies ListPresence);
  });

  const open = (retried = false) => {
    if (left) return;
    // Realtime hands back the channel already on a topic, and a joined one takes no new presence
    // callbacks (it throws). One still here is left over from a leave that never closed it, so it
    // goes first; if it won't, this list goes without presence rather than crashing.
    const stale = supabase.getChannels().find((c) => c.topic === `realtime:${topic}`);
    if (stale) {
      if (retried) {
        console.warn(`[presence] ${topic}: an earlier channel is still open`);
        return;
      }
      void Promise.resolve(supabase.removeChannel(stale))
        .catch(() => {})
        .then(() => open(true));
      return;
    }
    const ch = supabase.channel(topic, { config: { private: true, presence: { key: userId, enabled: true } } });
    channel = ch;
    ch.on('presence', { event: 'sync' }, () => {
      if (!left) onOthers(othersAdding(ch.presenceState(), userId));
    });
    ch.subscribe((status, err) => {
      if (left) return;
      if (status === 'SUBSCRIBED') {
        // Also after a rejoin, when the server has forgotten this device's presence.
        joined = true;
        throttle.push(current);
      } else {
        joined = false;
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') console.warn(`[presence] ${topic}: ${status}`, err);
      }
    });
  };

  const previous = leaving.get(topic);
  if (previous) void previous.then(() => open());
  else open();

  return {
    setAdding(next) {
      if (next === current) return;
      current = next;
      if (joined) throttle.push(next);
    },
    leave() {
      if (left) return;
      left = true;
      joined = false;
      throttle.cancel();
      if (!channel) return;
      const done = Promise.resolve(supabase.removeChannel(channel))
        .catch(() => {})
        .finally(() => {
          if (leaving.get(topic) === done) leaving.delete(topic);
        });
      leaving.set(topic, done);
    },
  };
}

/** Whether the device is online: null until the first network state, which counts as online. */
function useOnline(): boolean | null {
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => {
    const subscription = addNetworkStateListener((state) => setOnline(isOnline(state)));
    return () => subscription.remove();
  }, []);
  return online;
}

/**
 * The other members adding on list `listId`, while `watching` it (on screen, in the foreground) and
 * online; empty otherwise. Joins the list's channel as `userId` for as long as that holds, tracking
 * `adding`.
 */
export function useListPresence(listId: string, watching: boolean, userId: string | null, adding: boolean): string[] {
  const online = useOnline();
  const on = watching && online !== false && userId !== null && isSupabaseConfigured;
  const [others, setOthers] = useState<string[]>([]);
  const session = useRef<ListPresenceSession | null>(null);
  const addingRef = useRef(adding);

  useEffect(() => {
    if (!on || !userId) return;
    const joined = joinListPresence(listId, userId, addingRef.current, (next) =>
      setOthers((prev) => (prev.length === next.length && prev.every((id, i) => id === next[i]) ? prev : next)),
    );
    session.current = joined;
    return () => {
      joined.leave();
      session.current = null;
      setOthers([]);
    };
  }, [on, listId, userId]);

  // After the join above, so a session opened in the same commit gets the latest value too.
  useEffect(() => {
    addingRef.current = adding;
    session.current?.setAdding(adding);
  }, [adding]);

  return on ? others : [];
}

/**
 * Whether this user counts as adding: while the add field is `focused`, and for ADDING_TAIL_MS
 * after the last `noteAdd`.
 */
export function useAddingTail(focused: boolean): { adding: boolean; noteAdd: () => void } {
  const [tail, setTail] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const noteAdd = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setTail(true);
    timer.current = setTimeout(() => {
      timer.current = null;
      setTail(false);
    }, ADDING_TAIL_MS);
  }, []);
  return { adding: focused || tail, noteAdd };
}
