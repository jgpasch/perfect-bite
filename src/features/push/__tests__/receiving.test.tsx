// Receiving pushes (spec 4.13): a tapped push opens its list once, after a pull when the list isn't
// here yet; anything but a list URL is ignored; a push while the app is open becomes an in-app banner,
// or nothing on that list's screen; and opening a list clears its delivered pushes.
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type * as Notifications from 'expo-notifications';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

import { clearNotifications, currentNotification } from '@/features/notifications/notifications';

import {
  dismissListPushes,
  foregroundBanner,
  getVisibleListId,
  handleForegroundPush,
  handlePushResponse,
  listIdFromUrl,
  markListVisible,
  onListUnavailable,
  pushKind,
  resetPushReceiving,
  startForegroundPushes,
  takeListUnavailable,
  usePushResponses,
} from '../receiving';

const mockRouter = { push: jest.fn(), navigate: jest.fn() };
jest.mock('expo-router', () => ({
  get router() {
    return mockRouter;
  },
}));

const mockLists = new Set<string>();
jest.mock('@/features/lists/lists', () => ({ getList: (id: string) => (mockLists.has(id) ? { id } : undefined) }));

const mockPull = jest.fn<() => Promise<void>>(async () => {});
jest.mock('@/sync/pull', () => ({ pullNow: () => mockPull() }));

let mockAccount: { userId: string } | null = { userId: 'u-sam' };
jest.mock('@/features/auth/account', () => ({ getAccount: () => mockAccount }));

let mockLastResponse: Notifications.NotificationResponse | null | undefined = undefined;
jest.mock('expo-notifications', () => ({
  useLastNotificationResponse: () => mockLastResponse,
  setNotificationHandler: jest.fn(),
  getPresentedNotificationsAsync: jest.fn(),
  dismissNotificationAsync: jest.fn(async () => {}),
}));
type FakeNotifications = {
  setNotificationHandler: jest.Mock<(handler: Notifications.NotificationHandler | null) => void>;
  getPresentedNotificationsAsync: jest.Mock<() => Promise<Notifications.Notification[]>>;
  dismissNotificationAsync: jest.Mock<(id: string) => Promise<void>>;
};
const mockNotifications = jest.requireMock<FakeNotifications>('expo-notifications');

const GROCERIES = '0b9e6a2c-1f4d-4c8e-9a51-3d7f2e6b8c10';
const HARDWARE = '5c2d8e1f-7a3b-4e9c-b6d0-1f2a3b4c5d6e';

function push(
  identifier: string,
  data: Record<string, unknown>,
  content: { title?: string | null; body?: string | null } = {},
): Notifications.Notification {
  return {
    date: 0,
    request: {
      identifier,
      content: { title: content.title ?? null, subtitle: null, body: content.body ?? null, data, sound: 'default' },
      trigger: null,
    },
  } as unknown as Notifications.Notification;
}

function tap(notification: Notifications.Notification): Notifications.NotificationResponse {
  return { notification, actionIdentifier: 'expo.modules.notifications.actions.DEFAULT' };
}

const added = (identifier: string, listId = GROCERIES) =>
  push(identifier, { url: `/list/${listId}`, kind: 'items_added', householdId: 'h-1' }, {
    title: 'Groceries',
    body: 'Alex added milk, eggs and 4 more',
  });

beforeEach(() => {
  resetPushReceiving();
  clearNotifications();
  mockLists.clear();
  mockRouter.push.mockClear();
  mockRouter.navigate.mockClear();
  mockPull.mockReset();
  mockPull.mockImplementation(async () => {});
  mockAccount = { userId: 'u-sam' };
  mockLastResponse = undefined;
  mockNotifications.setNotificationHandler.mockClear();
  mockNotifications.getPresentedNotificationsAsync.mockReset();
  mockNotifications.dismissNotificationAsync.mockClear();
});

describe('listIdFromUrl', () => {
  it('takes the id from a list URL', () => {
    expect(listIdFromUrl(`/list/${GROCERIES}`)).toBe(GROCERIES);
    expect(listIdFromUrl(`/list/${GROCERIES.toUpperCase()}`)).toBe(GROCERIES.toUpperCase());
  });

  it('ignores anything else', () => {
    expect(listIdFromUrl(undefined)).toBeNull();
    expect(listIdFromUrl(42)).toBeNull();
    expect(listIdFromUrl('')).toBeNull();
    expect(listIdFromUrl('/list/not-a-uuid')).toBeNull();
    expect(listIdFromUrl(`/list/${GROCERIES}/edit`)).toBeNull();
    expect(listIdFromUrl(`/recipe/${GROCERIES}`)).toBeNull();
    expect(listIdFromUrl(`https://evil.example/list/${GROCERIES}`)).toBeNull();
    expect(listIdFromUrl(`/list/${GROCERIES}?x=1`)).toBeNull();
  });
});

describe('pushKind', () => {
  it("maps the worker's kinds to the in-app ones", () => {
    expect(pushKind('items_added')).toBe('itemsAdded');
    expect(pushKind('shopping')).toBe('shopping');
    expect(pushKind('recipeImport')).toBeNull();
    expect(pushKind(undefined)).toBeNull();
  });
});

describe('a tapped push', () => {
  it('opens a list that is on the device, without a pull', async () => {
    mockLists.add(GROCERIES);
    await handlePushResponse(tap(added('n-1')));
    expect(mockPull).not.toHaveBeenCalled();
    expect(mockRouter.push).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/list/[id]', params: { id: GROCERIES } });
    expect(mockRouter.navigate).not.toHaveBeenCalled();
  });

  it('acts on each response id once', async () => {
    mockLists.add(GROCERIES);
    await handlePushResponse(tap(added('n-1')));
    await handlePushResponse(tap(added('n-1')));
    expect(mockRouter.push).toHaveBeenCalledTimes(1);
    await handlePushResponse(tap(added('n-2')));
    expect(mockRouter.push).toHaveBeenCalledTimes(2);
  });

  it('ignores an unknown URL', async () => {
    mockLists.add(GROCERIES);
    await handlePushResponse(tap(push('n-1', { url: 'https://example.com/list/x' })));
    await handlePushResponse(tap(push('n-2', { url: `/recipe/${GROCERIES}` })));
    await handlePushResponse(tap(push('n-3', {})));
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
    expect(mockPull).not.toHaveBeenCalled();
  });

  it('pulls first when the list is not here yet, then opens it', async () => {
    mockPull.mockImplementation(async () => void mockLists.add(GROCERIES));
    await handlePushResponse(tap(added('n-1')));
    expect(mockPull).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/list/[id]', params: { id: GROCERIES } });
    expect(takeListUnavailable()).toBe(false);
  });

  it('falls back to the Lists tab with a toast when the list is still missing', async () => {
    const listener = jest.fn();
    onListUnavailable(listener);
    await handlePushResponse(tap(added('n-1')));
    expect(mockPull).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(mockRouter.navigate).toHaveBeenCalledWith('/lists');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(takeListUnavailable()).toBe(true);
    // Taken once.
    expect(takeListUnavailable()).toBe(false);
  });

  it('falls back too when the pull fails', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockPull.mockRejectedValue(new Error('offline'));
    await handlePushResponse(tap(added('n-1')));
    expect(mockRouter.navigate).toHaveBeenCalledWith('/lists');
    expect(takeListUnavailable()).toBe(true);
  });
});

describe('usePushResponses', () => {
  function Probe({ ready }: { ready: boolean }) {
    usePushResponses(ready);
    return null;
  }
  const flush = () => act(async () => {});

  it('routes a cold-start response once, after sign-in', async () => {
    mockLists.add(GROCERIES);
    mockLastResponse = tap(added('cold'));
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(Probe, { ready: false }));
    });
    expect(mockRouter.push).not.toHaveBeenCalled();
    await act(async () => renderer.update(createElement(Probe, { ready: true })));
    await flush();
    expect(mockRouter.push).toHaveBeenCalledTimes(1);
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/list/[id]', params: { id: GROCERIES } });
    // Signing out and in again, or a re-render, doesn't open it again.
    await act(async () => renderer.update(createElement(Probe, { ready: false })));
    await act(async () => renderer.update(createElement(Probe, { ready: true })));
    await flush();
    expect(mockRouter.push).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('does nothing before a response is known or when there is none', async () => {
    mockLastResponse = null;
    let renderer!: ReturnType<typeof create>;
    await act(async () => {
      renderer = create(createElement(Probe, { ready: true }));
    });
    expect(mockRouter.push).not.toHaveBeenCalled();
    renderer.unmount();
  });
});

describe('a push while the app is open', () => {
  it('shows no OS banner and posts an in-app one', async () => {
    mockLists.add(GROCERIES);
    const behavior = await handleForegroundPush(added('n-1'));
    expect(behavior).toEqual({ shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false });
    const banner = currentNotification();
    expect(banner).toMatchObject({
      id: 'push-n-1',
      kind: 'itemsAdded',
      icon: 'plus',
      hue: 'green',
      tone: 'success',
      title: 'Groceries',
      body: 'Alex added milk, eggs and 4 more',
      hint: 'Opens Groceries',
    });
    banner!.onPress!();
    await act(async () => {});
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/list/[id]', params: { id: GROCERIES } });
  });

  it('gives "is shopping" its own kind and look', () => {
    const shopping = push('n-2', { url: `/list/${GROCERIES}`, kind: 'shopping' }, { title: 'Groceries', body: 'Alex is shopping' });
    expect(foregroundBanner(shopping)).toMatchObject({ kind: 'shopping', icon: 'cart', hue: 'blue', body: 'Alex is shopping' });
  });

  it("posts nothing on that list's screen, but does on another list's", async () => {
    const stop = markListVisible(GROCERIES);
    expect(getVisibleListId()).toBe(GROCERIES);
    const behavior = await handleForegroundPush(added('n-1'));
    expect(behavior.shouldShowBanner).toBe(false);
    expect(currentNotification()).toBeNull();

    await handleForegroundPush(added('n-2', HARDWARE));
    expect(currentNotification()?.id).toBe('push-n-2');

    stop();
    expect(getVisibleListId()).toBeNull();
  });

  it("leaving one list doesn't clear another that took over", () => {
    const stopGroceries = markListVisible(GROCERIES);
    markListVisible(HARDWARE);
    stopGroceries();
    expect(getVisibleListId()).toBe(HARDWARE);
  });

  it('posts nothing for other pushes or when signed out', async () => {
    expect(foregroundBanner(push('n-1', { url: `/list/${GROCERIES}`, kind: 'other' }))).toBeNull();
    expect(foregroundBanner(push('n-2', { url: '/elsewhere', kind: 'shopping' }))).toBeNull();
    mockAccount = null;
    const behavior = await handleForegroundPush(added('n-3'));
    expect(behavior.shouldShowList).toBe(false);
    expect(currentNotification()).toBeNull();
  });

  it('sets the handler at launch', () => {
    startForegroundPushes();
    expect(mockNotifications.setNotificationHandler).toHaveBeenCalledWith({ handleNotification: handleForegroundPush });
  });
});

describe('dismissListPushes', () => {
  it("clears only that list's delivered pushes", async () => {
    mockNotifications.getPresentedNotificationsAsync.mockResolvedValue([
      added('g-1'),
      added('h-1', HARDWARE),
      added('g-2'),
      push('other', { url: '/somewhere' }),
    ]);
    await dismissListPushes(GROCERIES);
    expect(mockNotifications.dismissNotificationAsync.mock.calls.map(([id]) => id)).toEqual(['g-1', 'g-2']);
  });

  it('never throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockNotifications.getPresentedNotificationsAsync.mockRejectedValue(new Error('no native module'));
    await expect(dismissListPushes(GROCERIES)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(mockNotifications.dismissNotificationAsync).not.toHaveBeenCalled();
  });
});
