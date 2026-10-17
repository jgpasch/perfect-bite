// Settings > Notifications (spec 4.13): the permission card's three states, the switches and quiet
// hours saving to notification_settings with the device's time zone, quiet-hours validation, and
// the controls disabled offline. Also the row that opens it from Settings.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createElement } from 'react';
import { Alert, AppState, Linking, Switch, Text, type AppStateStatus } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { queriesFor, resetSupabase, respondTo } from '@/test/fake-supabase';
import { resetDb } from '@/test/db';
import type { PushPermission } from '@/features/push/registration';
import { resetNotificationSettings } from '@/features/push/settings';

import NotificationSettingsScreen from '@/app/(tabs)/settings/notifications';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('@/features/auth/account', () => ({
  getAccount: () => ({ userId: 'user-1', email: 'jo@example.com' }),
}));

const mockPermission: { now: PushPermission; afterRequest: PushPermission } = { now: 'granted', afterRequest: 'granted' };
const mockRequest = jest.fn(async () => {
  mockPermission.now = mockPermission.afterRequest;
  return mockPermission.afterRequest;
});
jest.mock('@/features/push/registration', () => ({
  getPushPermission: async () => mockPermission.now,
  requestPushPermission: () => mockRequest(),
}));

// The network: online unless a test says otherwise, and a listener to report changes to.
const mockNetwork: { online: boolean; listener?: (state: object) => void } = { online: true };
const networkState = () => ({ isConnected: mockNetwork.online, isInternetReachable: mockNetwork.online });
jest.mock('expo-network', () => ({
  getNetworkStateAsync: async () => networkState(),
  addNetworkStateListener: (listener: (state: object) => void) => {
    mockNetwork.listener = listener;
    return { remove: () => {} };
  },
}));

jest.mock('@expo/ui/swift-ui', () => {
  const { createElement: h } = require('react');
  return {
    Host: ({ children }: { children?: unknown }) => h('SwiftHost', null, children),
    DatePicker: (props: object) => h('SwiftDatePicker', props),
  };
});
jest.mock('@expo/ui/swift-ui/modifiers', () => ({
  datePickerStyle: (style: string) => ({ datePickerStyle: style }),
  labelsHidden: () => ({ labelsHidden: true }),
  disabled: (value?: boolean) => ({ disabled: value }),
}));

let tree: ReactTestRenderer | null = null;
let appStateListener: ((next: AppStateStatus) => void) | undefined;
let timeZone = 'America/Mexico_City';

const flush = () => act(async () => new Promise<void>((resolve) => setImmediate(resolve)));

async function render() {
  await act(async () => {
    tree = create(createElement(NotificationSettingsScreen));
  });
  await flush();
  return tree!.root;
}

function texts(root: ReactTestInstance): string[] {
  return root.findAllByType(Text).map((t) => [t.props.children].flat().join(''));
}

function switchNamed(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find((n) => n.type === Switch && n.props.accessibilityLabel === label);
}

function pickers(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll((n) => (n.type as unknown) === 'SwiftDatePicker');
}

function picker(root: ReactTestInstance, testID: string): ReactTestInstance {
  return root.find((n) => (n.type as unknown) === 'SwiftDatePicker' && n.props.testID === testID);
}

function buttonNamed(root: ReactTestInstance, label: string): ReactTestInstance {
  return root.find((n) => n.props.accessibilityRole === 'button' && n.props.accessibilityLabel === label && typeof n.type !== 'string');
}

const upserts = () => queriesFor('notification_settings').filter((q) => q.ops[0][0] === 'upsert');
const sent = (i: number) => upserts()[i].ops[0][1] as Record<string, unknown>;
const at = (h: number, m: number) => new Date(2026, 9, 17, h, m);
const row = (r: Partial<Record<string, unknown>> = {}) => ({
  data: { items_added: true, shopping: true, quiet_hours_start: null, quiet_hours_end: null, ...r },
});

beforeEach(() => {
  resetDb();
  resetSupabase();
  resetNotificationSettings();
  mockPermission.now = 'granted';
  mockPermission.afterRequest = 'granted';
  mockRequest.mockClear();
  mockNetwork.online = true;
  mockNetwork.listener = undefined;
  timeZone = 'America/Mexico_City';
  jest
    .spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions')
    .mockImplementation(() => ({ timeZone }) as Intl.ResolvedDateTimeFormatOptions);
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    appStateListener = listener as (next: AppStateStatus) => void;
    return { remove: () => {} } as unknown as ReturnType<typeof AppState.addEventListener>;
  });
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  jest.restoreAllMocks();
});

describe('the permission', () => {
  it('undetermined: explains, and Turn on notifications asks, then shows the settings', async () => {
    mockPermission.now = 'undetermined';
    respondTo('notification_settings', row());
    const root = await render();
    expect(texts(root)).toEqual(
      expect.arrayContaining(['Stay in the loop', 'Know when someone in your household adds to a list or starts shopping.']),
    );
    expect(root.findAllByType(Switch)).toHaveLength(0);
    expect(root.findAll((n) => n.props.accessibilityLabel === 'Open Settings')).toHaveLength(0);

    await act(async () => buttonNamed(root, 'Turn on notifications').props.onPress());
    await flush();
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(texts(root)).not.toContain('Stay in the loop');
    expect(root.findAllByType(Switch).map((s) => s.props.accessibilityLabel)).toEqual([
      'Items added to lists',
      'Someone starts shopping',
      'Quiet hours',
    ]);
  });

  it('undetermined, then declined: the card says they are off and offers Settings', async () => {
    mockPermission.now = 'undetermined';
    mockPermission.afterRequest = 'denied';
    const root = await render();
    await act(async () => buttonNamed(root, 'Turn on notifications').props.onPress());
    await flush();
    expect(texts(root)).toContain('Notifications are off for Perfect Bite. Turn them on in Settings.');
    expect(root.findAllByType(Switch)).toHaveLength(0);
  });

  it('denied: says notifications are off and Open Settings opens them', async () => {
    mockPermission.now = 'denied';
    const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
    const root = await render();
    expect(texts(root)).toEqual(
      expect.arrayContaining(['Notifications are off', 'Notifications are off for Perfect Bite. Turn them on in Settings.']),
    );
    expect(root.findAll((n) => n.props.accessibilityLabel === 'Turn on notifications')).toHaveLength(0);
    expect(root.findAllByType(Switch)).toHaveLength(0);
    await act(async () => buttonNamed(root, 'Open Settings').props.onPress());
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('denied, then allowed in iOS Settings: back in the app the card is gone', async () => {
    mockPermission.now = 'denied';
    const root = await render();
    mockPermission.now = 'granted';
    await act(async () => {
      appStateListener?.('background');
      appStateListener?.('active');
    });
    await flush();
    expect(texts(root)).not.toContain('Notifications are off');
    expect(root.findAllByType(Switch)).toHaveLength(3);
  });

  it('granted: no card, the switches with the loaded values', async () => {
    respondTo('notification_settings', row({ items_added: false }));
    const root = await render();
    expect(texts(root)).not.toContain('Stay in the loop');
    expect(texts(root)).not.toContain('Notifications are off');
    expect(switchNamed(root, 'Items added to lists').props.value).toBe(false);
    expect(switchNamed(root, 'Someone starts shopping').props.value).toBe(true);
    expect(switchNamed(root, 'Quiet hours').props.value).toBe(false);
    expect(pickers(root)).toHaveLength(0);
  });

  it('unavailable (a simulator): says so, with no button and no settings', async () => {
    mockPermission.now = 'unavailable';
    const root = await render();
    expect(texts(root)).toContain('Notifications work on a phone, not on this device.');
    expect(root.findAll((n) => n.props.accessibilityRole === 'button')).toHaveLength(0);
    expect(root.findAllByType(Switch)).toHaveLength(0);
  });
});

describe('saving', () => {
  it('turning off "Someone starts shopping" upserts the row with the time zone', async () => {
    respondTo('notification_settings', row());
    const root = await render();
    await act(async () => switchNamed(root, 'Someone starts shopping').props.onValueChange(false));
    await flush();
    expect(sent(0)).toEqual({
      user_id: 'user-1',
      items_added: true,
      shopping: false,
      quiet_hours_start: null,
      quiet_hours_end: null,
      time_zone: 'America/Mexico_City',
    });
    expect(switchNamed(root, 'Someone starts shopping').props.value).toBe(false);
  });

  it('turning off "Items added to lists" keeps shopping as loaded', async () => {
    respondTo('notification_settings', row({ shopping: false }));
    const root = await render();
    await act(async () => switchNamed(root, 'Items added to lists').props.onValueChange(false));
    await flush();
    expect(sent(0)).toMatchObject({ items_added: false, shopping: false });
  });

  it('a failed save puts the switch back and says so', async () => {
    respondTo('notification_settings', row(), { error: { message: 'Failed to fetch' } });
    const root = await render();
    await act(async () => switchNamed(root, 'Items added to lists').props.onValueChange(false));
    await flush();
    expect(switchNamed(root, 'Items added to lists').props.value).toBe(true);
    expect(Alert.alert).toHaveBeenCalledWith("Couldn't save your notification settings", 'Something went wrong. Try again.');
  });

  it('each save sends the time zone the device has then', async () => {
    respondTo('notification_settings', row());
    const root = await render();
    await act(async () => switchNamed(root, 'Items added to lists').props.onValueChange(false));
    await flush();
    timeZone = 'Asia/Tokyo';
    await act(async () => switchNamed(root, 'Items added to lists').props.onValueChange(true));
    await flush();
    expect([sent(0).time_zone, sent(1).time_zone]).toEqual(['America/Mexico_City', 'Asia/Tokyo']);
  });
});

describe('quiet hours', () => {
  it('turning them on starts at 22:00 to 07:00, with two compact time pickers', async () => {
    respondTo('notification_settings', row());
    const root = await render();
    await act(async () => switchNamed(root, 'Quiet hours').props.onValueChange(true));
    await flush();
    expect(sent(0)).toMatchObject({ quiet_hours_start: '22:00', quiet_hours_end: '07:00', time_zone: 'America/Mexico_City' });
    const [from, to] = pickers(root);
    expect([from.props.title, to.props.title]).toEqual(['Quiet hours from', 'Quiet hours to']);
    expect([from.props.selection.getHours(), from.props.selection.getMinutes()]).toEqual([22, 0]);
    expect([to.props.selection.getHours(), to.props.selection.getMinutes()]).toEqual([7, 0]);
    expect(from.props.displayedComponents).toEqual(['hourAndMinute']);
    expect(from.props.modifiers).toEqual([{ datePickerStyle: 'compact' }, { labelsHidden: true }, { disabled: false }]);
    expect(texts(root)).toContain('Times are in your phone’s time zone (America/Mexico_City).');
  });

  it('shows saved quiet hours, and a new start time saves', async () => {
    respondTo('notification_settings', row({ quiet_hours_start: '23:00:00', quiet_hours_end: '06:30:00' }));
    const root = await render();
    expect(picker(root, 'quiet-hours-end').props.selection.getMinutes()).toBe(30);
    await act(async () => picker(root, 'quiet-hours-start').props.onDateChange(at(21, 15)));
    await flush();
    expect(sent(0)).toMatchObject({ quiet_hours_start: '21:15', quiet_hours_end: '06:30' });
    expect(picker(root, 'quiet-hours-start').props.selection.getHours()).toBe(21);
  });

  it("doesn't allow the start to equal the end: nothing is saved and it says why", async () => {
    respondTo('notification_settings', row({ quiet_hours_start: '22:00:00', quiet_hours_end: '07:00:00' }));
    const root = await render();
    await act(async () => picker(root, 'quiet-hours-end').props.onDateChange(at(22, 0)));
    await flush();
    expect(upserts()).toHaveLength(0);
    expect(texts(root)).toContain('Quiet hours need different start and end times.');
    // The picker shows the saved time again.
    expect(picker(root, 'quiet-hours-end').props.selection.getHours()).toBe(7);

    // A valid time clears the message.
    await act(async () => picker(root, 'quiet-hours-end').props.onDateChange(at(6, 0)));
    await flush();
    expect(sent(0)).toMatchObject({ quiet_hours_start: '22:00', quiet_hours_end: '06:00' });
    expect(texts(root)).not.toContain('Quiet hours need different start and end times.');
  });

  it('turning them off sends nulls and hides the pickers', async () => {
    respondTo('notification_settings', row({ quiet_hours_start: '22:00:00', quiet_hours_end: '07:00:00' }));
    const root = await render();
    await act(async () => switchNamed(root, 'Quiet hours').props.onValueChange(false));
    await flush();
    expect(sent(0)).toMatchObject({ quiet_hours_start: null, quiet_hours_end: null });
    expect(pickers(root)).toHaveLength(0);
  });
});

describe('offline', () => {
  it('disables every control with "Needs a connection", and enables them again online', async () => {
    respondTo('notification_settings', row({ quiet_hours_start: '22:00:00', quiet_hours_end: '07:00:00' }));
    const root = await render();
    await act(async () => mockNetwork.listener?.({ isConnected: false, isInternetReachable: false }));
    expect(texts(root)).toContain('Needs a connection');
    expect(root.findAllByType(Switch).map((s) => s.props.disabled)).toEqual([true, true, true]);
    expect(pickers(root).map((p) => p.props.modifiers[2])).toEqual([{ disabled: true }, { disabled: true }]);

    await act(async () => mockNetwork.listener?.({ isConnected: true, isInternetReachable: true }));
    expect(texts(root)).not.toContain('Needs a connection');
    expect(root.findAllByType(Switch).map((s) => s.props.disabled)).toEqual([false, false, false]);
  });

  it('opened offline: the defaults, disabled, then loaded once back online', async () => {
    mockNetwork.online = false;
    respondTo('notification_settings', { error: { message: 'Failed to fetch' } }, row({ shopping: false }));
    const root = await render();
    expect(texts(root)).toContain('Needs a connection');
    expect(root.findAllByType(Switch).map((s) => [s.props.value, s.props.disabled])).toEqual([
      [true, true],
      [true, true],
      [false, true],
    ]);
    await act(async () => mockNetwork.listener?.({ isConnected: true, isInternetReachable: true }));
    await flush();
    expect(switchNamed(root, 'Someone starts shopping').props).toMatchObject({ value: false, disabled: false });
    expect(queriesFor('notification_settings')).toHaveLength(2);
  });
});
