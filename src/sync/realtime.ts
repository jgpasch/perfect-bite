// Realtime (spec 7.2): while the app is in the foreground and online, listen for changes to the
// user's households, their own preference tables, their memberships and the catalog.
//
// - Events don't write to SQLite themselves. Each one schedules a cursor pull of what it touched
//   (one household, the user's tables, or the catalog), so remote changes take the pull's path
//   (LWW, Combine on clash) and the screens' live queries show them like local writes. Events
//   within REALTIME_BATCH_MS of the first share one pull.
// - The one exception is a delete of the user's category order rows: the server hard-deletes
//   those, so there's nothing to pull, and the event's key is applied directly. (A household's
//   custom categories and overrides are household data, on its channel; Reset to default writes a
//   null override rather than deleting one.)
// - Channels: one per household (each table filtered to it), one for the user's rows and
//   memberships, one for the catalog. A membership event does a full pull, which reads the user's
//   households again; channels follow it (added and removed). Every channel catches up with a pull
//   once it's subscribed, covering changes made since the last pull or while it was rejoining.
// - Leaving the foreground or going offline closes every channel; coming back opens them again
//   (on reconnect, as new channels).
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { addNetworkStateListener } from 'expo-network';
import { AppState } from 'react-native';

import { isOnline } from '@/features/categories/catch-up';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

import { applyRemoteDelete, mergeScopes, onMemberships, pullNow, type PullScope } from './pull';

/** How long after an event its pull waits for more events to share it. */
export const REALTIME_BATCH_MS = 300;

/** Household tables, each filtered to one household. */
export const HOUSEHOLD_TABLES = [
  'households',
  'categories',
  'household_category_overrides',
  'household_staples',
  'lists',
  'recipes',
  'list_items',
  'recipe_ingredients',
  'list_item_contributions',
  'ingredient_usage',
  'ingredient_unit_usage',
] as const;

/** The user's own tables, by the column naming the user. */
export const USER_TABLES: Record<string, string> = {
  user_category_order: 'user_id',
  user_settings: 'user_id',
};

type Payload = RealtimePostgresChangesPayload<Record<string, unknown>>;
type Binding = { table: string; filter?: string };

/** Starts Realtime for `userId`. Returns a cleanup that closes every channel. */
export function startRealtime(userId: string): () => void {
  if (!isSupabaseConfigured) return () => {};

  let foreground = AppState.currentState === 'active';
  let online: boolean | null = null;
  /** The user's households, from the last full pull; null until one has run. */
  let households: string[] | null = null;
  const channels = new Map<string, RealtimeChannel>();
  let generation = 0;

  let scheduled: PullScope | 'all' | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (scope: PullScope | 'all') => {
    scheduled = mergeScopes(scheduled, scope);
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const next = scheduled;
      scheduled = null;
      if (next) void pullNow(next === 'all' ? {} : { scope: next });
    }, REALTIME_BATCH_MS);
  };

  const open = (key: string, scope: PullScope, bindings: Binding[], onChange: (table: string, payload: Payload) => void) => {
    // A fresh topic each time, so a channel being closed never answers for its replacement.
    const channel = supabase.channel(`sync:${key}:${++generation}`);
    for (const { table, filter } of bindings) {
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) },
        (payload: Payload) => {
          // A message already on its way when the channel closed.
          if (channels.get(key) === channel) onChange(table, payload);
        },
      );
    }
    channel.subscribe((status, err) => {
      if (channels.get(key) !== channel) return;
      if (status === 'SUBSCRIBED') schedule(scope);
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') console.warn(`[realtime] ${key}: ${status}`, err);
    });
    channels.set(key, channel);
  };

  const close = (key: string) => {
    const channel = channels.get(key);
    if (!channel) return;
    channels.delete(key);
    void supabase.removeChannel(channel);
  };

  const openUser = () =>
    open(
      'user',
      { user: true },
      [
        { table: 'household_members', filter: `user_id=eq.${userId}` },
        ...Object.entries(USER_TABLES).map(([table, column]) => ({ table, filter: `${column}=eq.${userId}` })),
      ],
      (table, payload) => {
        // Deletes can't be filtered, so they arrive for everyone's rows; only the user's count.
        const old = payload.old as Record<string, unknown>;
        if (table === 'household_members') {
          if (payload.eventType !== 'DELETE' || old.user_id === userId) schedule('all');
        } else if (payload.eventType === 'DELETE') {
          if (old.user_id === userId) applyRemoteDelete(table, old, userId);
        } else {
          schedule({ user: true });
        }
      },
    );

  const openHousehold = (householdId: string) =>
    open(
      `household:${householdId}`,
      { households: [householdId] },
      HOUSEHOLD_TABLES.map((table) => ({
        table,
        filter: `${table === 'households' ? 'id' : 'household_id'}=eq.${householdId}`,
      })),
      () => schedule({ households: [householdId] }),
    );

  const openCatalog = () => open('catalog', { catalog: true }, [{ table: 'ingredients' }], () => schedule({ catalog: true }));

  /** Opens and closes channels to match the app's state and the user's households. */
  const sync = () => {
    if (!foreground || online === false) {
      for (const key of [...channels.keys()]) close(key);
      return;
    }
    const wanted = new Set(['user', 'catalog', ...(households ?? []).map((id) => `household:${id}`)]);
    for (const key of [...channels.keys()]) if (!wanted.has(key)) close(key);
    if (!channels.has('user')) openUser();
    if (!channels.has('catalog')) openCatalog();
    for (const id of households ?? []) if (!channels.has(`household:${id}`)) openHousehold(id);
  };

  const app = AppState.addEventListener('change', (next) => {
    foreground = next === 'active';
    sync();
  });
  const network = addNetworkStateListener((state) => {
    const now = isOnline(state);
    const reconnected = online === false && now;
    online = now;
    // The old sockets may be dead without knowing it; start over.
    if (reconnected) for (const key of [...channels.keys()]) close(key);
    sync();
  });
  const stopMemberships = onMemberships(userId, (next) => {
    households = next;
    sync();
  });
  sync();

  return () => {
    app.remove();
    network.remove();
    stopMemberships();
    if (timer) clearTimeout(timer);
    timer = null;
    scheduled = null;
    for (const key of [...channels.keys()]) close(key);
  };
}
