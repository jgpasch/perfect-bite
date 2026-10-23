// Receiving push notifications (spec 4.13). A tapped push opens its list or recipe, after a pull when
// it isn't on this device yet, or the Recipes tab. One that arrives while the app is open shows no OS
// banner: it becomes an in-app banner (spec 4.11), or nothing when its list is already on screen.
// Opening a list clears its pushes from Notification Center.
import { router } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { recipeHue } from '@/domain/aisle-color';
import { getAccount } from '@/features/auth/account';
import { getList } from '@/features/lists/lists';
import { notify, type AppNotification, type NotificationKind } from '@/features/notifications/notifications';
import { getRecipe } from '@/features/recipes/recipes';
import { i18n } from '@/i18n';
import { pullNow } from '@/sync/pull';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const LIST_URL = new RegExp(`^/list/(${UUID})$`, 'i');
const RECIPE_URL = new RegExp(`^/recipe/(${UUID})$`, 'i');

/** Where a push's `data.url` goes: a list, a recipe, or the Recipes tab (a failed share import). */
export type PushTarget = { kind: 'list'; id: string } | { kind: 'recipe'; id: string } | { kind: 'recipes' };

/** The in-app route a push's `data.url` opens, or null when it isn't one of the three allowed. */
export function pushTarget(url: unknown): PushTarget | null {
  if (typeof url !== 'string') return null;
  if (url === '/recipes') return { kind: 'recipes' };
  const list = LIST_URL.exec(url)?.[1];
  if (list) return { kind: 'list', id: list };
  const recipe = RECIPE_URL.exec(url)?.[1];
  if (recipe) return { kind: 'recipe', id: recipe };
  return null;
}

/** The list a push's `data.url` opens, or null when it isn't a list URL. */
export function listIdFromUrl(url: unknown): string | null {
  const target = pushTarget(url);
  return target?.kind === 'list' ? target.id : null;
}

function pushData(notification: Notifications.Notification): Record<string, unknown> {
  const data = notification.request.content.data;
  return data && typeof data === 'object' ? data : {};
}

/** The in-app kind for a push's `data.kind` (the worker's names), or null for anything else. */
export function pushKind(kind: unknown): NotificationKind | null {
  if (kind === 'items_added') return 'itemsAdded';
  if (kind === 'shopping') return 'shopping';
  if (kind === 'recipe_import') return 'recipeImport';
  return null;
}

// --- The list on screen ---

let visibleListId: string | null = null;

/** The list screen showing `listId` says so while it's on screen. Returns the function to call when it isn't. */
export function markListVisible(listId: string): () => void {
  visibleListId = listId;
  return () => {
    if (visibleListId === listId) visibleListId = null;
  };
}

export function getVisibleListId(): string | null {
  return visibleListId;
}

// --- "That list isn't available" ---

let listUnavailable = false;
const unavailableListeners = new Set<() => void>();

/** True once after a tapped push's list couldn't be found; the List tab shows the toast. */
export function takeListUnavailable(): boolean {
  const was = listUnavailable;
  listUnavailable = false;
  return was;
}

export function onListUnavailable(listener: () => void): () => void {
  unavailableListeners.add(listener);
  return () => void unavailableListeners.delete(listener);
}

function reportListUnavailable(): void {
  listUnavailable = true;
  for (const listener of [...unavailableListeners]) listener();
}

// --- Opening a push's list ---

/**
 * Opens a push's list. A list not on this device yet (shared moments ago) gets a pull first; if it's
 * still missing (deleted, or the user left that household), the Lists tab opens with a toast.
 */
export async function openPushedList(listId: string): Promise<void> {
  if (!getList(listId)) {
    try {
      await pullNow();
    } catch (err) {
      console.warn('[push] pulling for a tapped list failed', err);
    }
  }
  if (getList(listId)) {
    router.push({ pathname: '/list/[id]', params: { id: listId } });
    return;
  }
  router.navigate('/lists');
  reportListUnavailable();
}

/**
 * Opens a recipe-ready push's recipe. One not on this device yet (imported on the server moments ago)
 * gets a pull first; if it's still missing (deleted, or the user left that household), the Recipes
 * tab opens.
 */
export async function openPushedRecipe(recipeId: string): Promise<void> {
  if (!getRecipe(recipeId)) {
    try {
      await pullNow();
    } catch (err) {
      console.warn('[push] pulling for a tapped recipe failed', err);
    }
  }
  if (getRecipe(recipeId)) {
    router.push({ pathname: '/recipe/[id]', params: { id: recipeId } });
    return;
  }
  router.navigate('/recipes');
}

/** Opens where a push goes. */
export function openPushTarget(target: PushTarget): Promise<void> {
  if (target.kind === 'list') return openPushedList(target.id);
  if (target.kind === 'recipe') return openPushedRecipe(target.id);
  router.navigate('/recipes');
  return Promise.resolve();
}

// The response ids already acted on, so a re-render or a cold start's response opens its list once.
const handledResponses = new Set<string>();

/** Acts on a tapped push once: opens its list, recipe or the Recipes tab, ignores any other URL. */
export async function handlePushResponse(response: Notifications.NotificationResponse): Promise<void> {
  const id = response.notification.request.identifier;
  if (handledResponses.has(id)) return;
  handledResponses.add(id);
  const target = pushTarget(pushData(response.notification).url);
  if (!target) return;
  await openPushTarget(target);
}

/** Root layout: handles the last tapped push (a cold start or a tap while running) once `ready`. */
export function usePushResponses(ready: boolean): void {
  const response = Notifications.useLastNotificationResponse();
  useEffect(() => {
    if (ready && response) void handlePushResponse(response);
  }, [ready, response]);
}

/** For tests: forgets the handled responses, the visible list and the pending toast. */
export function resetPushReceiving(): void {
  handledResponses.clear();
  visibleListId = null;
  listUnavailable = false;
  unavailableListeners.clear();
}

// --- Pushes while the app is open ---

const ICONS: Record<'itemsAdded' | 'shopping', Pick<AppNotification, 'icon' | 'hue'>> = {
  itemsAdded: { icon: 'plus', hue: 'green' },
  shopping: { icon: 'cart', hue: 'blue' },
};

/**
 * A recipe-import push while the app is open: the recipe tile for ready (opens the recipe), the rose
 * warning tile for failed (opens the Recipes tab and its imports card), as the sheet's imports look
 * (spec 4.10).
 */
function recipeImportBanner(notification: Notifications.Notification, target: PushTarget): AppNotification | null {
  const { identifier, content } = notification.request;
  const base = { id: `push-${identifier}`, kind: 'recipeImport' as const, title: content.title ?? '', body: content.body ?? undefined };
  if (target.kind === 'recipe') {
    return {
      ...base,
      icon: 'fork.knife',
      hue: recipeHue(target.id),
      tone: 'success',
      hint: i18n.t('notifications.opensRecipe'),
      onPress: () => void openPushedRecipe(target.id),
    };
  }
  if (target.kind === 'recipes') {
    return {
      ...base,
      icon: 'exclamationmark.triangle.fill',
      hue: 'rose',
      tone: 'warning',
      hint: i18n.t('notifications.opensImports'),
      onPress: () => void openPushTarget(target),
    };
  }
  return null;
}

/**
 * The in-app banner for a push that arrived while the app is open, or null: not one of ours, signed
 * out, or its list is the one on screen (the realtime update shows the change there).
 */
export function foregroundBanner(notification: Notifications.Notification): AppNotification | null {
  const data = pushData(notification);
  const kind = pushKind(data.kind);
  if (kind === 'recipeImport') {
    const target = pushTarget(data.url);
    if (!target || !getAccount()) return null;
    return recipeImportBanner(notification, target);
  }
  const listId = listIdFromUrl(data.url);
  if ((kind !== 'itemsAdded' && kind !== 'shopping') || !listId) return null;
  if (!getAccount() || visibleListId === listId) return null;
  const { title, body } = notification.request.content;
  const name = title ?? '';
  return {
    id: `push-${notification.request.identifier}`,
    kind,
    ...ICONS[kind],
    tone: 'success',
    title: name,
    body: body ?? undefined,
    hint: name ? i18n.t('notifications.opens', { name }) : undefined,
    onPress: () => void openPushedList(listId),
  };
}

const SILENT: Notifications.NotificationBehavior = {
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

/** No OS banner while the app is open: a household push shows in the app instead. */
export async function handleForegroundPush(notification: Notifications.Notification): Promise<Notifications.NotificationBehavior> {
  const banner = foregroundBanner(notification);
  if (banner) notify(banner);
  return SILENT;
}

/** Once, at launch: pushes arriving while the app is open go through `handleForegroundPush`. */
export function startForegroundPushes(): void {
  if (Platform.OS === 'web') return;
  Notifications.setNotificationHandler({ handleNotification: handleForegroundPush });
}

// --- Clearing a list's pushes ---

/** Removes the pushes for `listId` from Notification Center, best effort. */
export async function dismissListPushes(listId: string): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    const mine = presented.filter((n) => listIdFromUrl(pushData(n).url) === listId);
    await Promise.all(mine.map((n) => Notifications.dismissNotificationAsync(n.request.identifier)));
  } catch (err) {
    console.warn('[push] clearing delivered notifications failed', err);
  }
}
