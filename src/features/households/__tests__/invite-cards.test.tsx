// The List tab's invite cards (spec 4.7, mockups A and C): the cards shown with no lists while
// invites are waiting, Start my own list, the invite pinned on a list with Not now, and the
// "You're in" card after a join.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Alert } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { db, households, lists } from '@/db';
import { LAST_OPENED_LIST_KEY } from '@/features/lists/lists';
import { getDeviceSetting } from '@/features/settings/device-settings';
import { resetDb } from '@/test/db';
import { respondToRpc, resetSupabase, rpcCallsFor } from '@/test/fake-supabase';

import { InviteWelcome, ListInviteCards } from '../invite-cards';
import { clearMyInvites, getMyInvites, HIDDEN_INVITES_KEY, startMyInvites } from '../my-invites';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const builder: object = new Proxy({}, { get: () => () => builder });
  return {
    __esModule: true,
    default: { View, createAnimatedComponent: (c: unknown) => c },
    FadeIn: builder,
    FadeOut: builder,
    LinearTransition: builder,
    useReducedMotion: () => false,
  };
});
jest.mock('@/features/siri/list-snapshot', () => ({
  recordListOpened: (listId: string) => require('@/features/lists/lists').setLastOpenedList(listId),
}));
jest.mock('@/features/push/ask', () => ({ notePushMoment: jest.fn() }));
jest.mock('@/features/categories/catch-up', () => ({ startCatchUpTriggers: () => () => {}, isOnline: () => true }));
jest.mock('expo-router', () => ({ router: { push: jest.fn(), navigate: jest.fn(), back: jest.fn() } }));
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));

/** The pull after a join brings the household in with one list, as the server would. */
const mockPullNow = jest.fn(async () => {
  const { db: d, households: h, lists: l } = require('@/db');
  d.insert(h).values({ id: 'h2', name: 'Paschal Home' }).onConflictDoNothing().run();
  d.insert(l).values({ id: 'l2', householdId: 'h2', name: 'Shared groceries', position: 1 }).onConflictDoNothing().run();
  return { pulled: 1, households: [] };
});
jest.mock('@/sync/pull', () => ({ pullNow: () => mockPullNow() }));

const ROW = { id: 'i1', household_id: 'h2', household_name: 'Paschal Home', invited_by: 'Sam', member_count: 3 };
const ROW2 = { id: 'i2', household_id: 'h3', household_name: 'Lake Cabin', invited_by: 'Riley', member_count: 5 };

const flush = () => act(() => new Promise((resolve) => setImmediate(resolve)));

let tree: ReactTestRenderer | null = null;
let stop: (() => void) | null = null;
let warn: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  resetDb();
  resetSupabase();
  mockPullNow.mockClear();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  const shown = tree;
  tree = null;
  act(() => shown?.unmount());
  stop?.();
  stop = null;
  clearMyInvites();
  jest.restoreAllMocks();
  warn.mockRestore();
});

/** Fills the invites store, as sign-in does. */
async function startWith(rows: unknown[]) {
  respondToRpc('my_invites', { data: rows });
  stop = startMyInvites();
  await flush();
}

function render(element: React.ReactElement) {
  act(() => {
    tree = create(element);
  });
}
const rerender = (element: React.ReactElement) => act(() => tree!.update(element));

const textOf = (n: ReactTestInstance): string =>
  n.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
const lines = () => tree!.root.findAll((n) => n.type === ('Text' as never)).map(textOf);
const pressable = (label: string) =>
  tree!.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && 'onPress' in n.props);
const hasPressable = (label: string) =>
  tree!.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && 'onPress' in n.props).length > 0;
const press = (n: ReactTestInstance) =>
  act(() => {
    n.props.onPress();
  });

describe('with no lists (mockup A)', () => {
  test('one invite: who, where, the pitch, Join, Decline and Start my own list', async () => {
    await startWith([ROW]);
    render(<InviteWelcome invites={getMyInvites()} />);
    expect(lines()).toEqual(
      expect.arrayContaining(["You're invited", 'Sam invited you to', 'Paschal Home', '3 members', 'Start my own list']),
    );
    expect(hasPressable('Join Paschal Home')).toBe(true);
    expect(hasPressable('Decline invite to Paschal Home')).toBe(true);
    expect(lines()).toContain('You can join later from Your lists.');
  });

  test('two invites: a card each and "Start my own list instead"', async () => {
    await startWith([ROW, ROW2]);
    render(<InviteWelcome invites={getMyInvites()} />);
    expect(lines()).toEqual(
      expect.arrayContaining([
        '2 invites waiting',
        'Join one or both. Each keeps its own lists.',
        'Paschal Home',
        'From Sam · 3 members',
        'Lake Cabin',
        'From Riley · 5 members',
        'Start my own list instead',
      ]),
    );
    expect(hasPressable('Decline invite to Lake Cabin')).toBe(true);
  });

  test('Join accepts, pulls, opens the household list and shows "You\'re in" there', async () => {
    await startWith([ROW]);
    respondToRpc('accept_invite_by_id', { data: [{ household_id: 'h2', household_name: 'Paschal Home', already_member: false }] });
    render(<InviteWelcome invites={getMyInvites()} />);
    press(pressable('Join Paschal Home'));
    await flush();
    expect(rpcCallsFor('accept_invite_by_id')).toHaveLength(1);
    expect(mockPullNow).toHaveBeenCalled();
    expect(getMyInvites()).toEqual([]);
    expect(getDeviceSetting(LAST_OPENED_LIST_KEY, null)).toBe('l2');

    rerender(<ListInviteCards householdId="h2" onMessage={() => {}} />);
    expect(lines()).toEqual(
      expect.arrayContaining(["You're in Paschal Home", "Sam's lists and recipes are yours now. Tap the list's name to switch."]),
    );
    press(pressable('Dismiss'));
    expect(lines()).not.toContain("You're in Paschal Home");
  });

  test('Start my own list makes the personal household and Groceries, and opens it', async () => {
    await startWith([ROW]);
    render(<InviteWelcome invites={getMyInvites()} />);
    press(pressable('Start my own list'));
    const groceries = db.select().from(lists).all();
    expect(groceries.map((l) => l.name)).toEqual(['Groceries']);
    expect(db.select().from(households).all().map((h) => h.name)).toEqual(['Personal']);
    expect(getDeviceSetting(LAST_OPENED_LIST_KEY, null)).toBe(groceries[0].id);
    // The invite stays waiting, to show on the list.
    expect(getMyInvites()).toHaveLength(1);
  });

  test('Decline asks first, then declines', async () => {
    await startWith([ROW]);
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      (buttons as { text: string; onPress?: () => void }[]).find((b) => b.text === 'Decline')!.onPress!();
    });
    render(<InviteWelcome invites={getMyInvites()} />);
    press(pressable('Decline invite to Paschal Home'));
    await flush();
    expect(alert.mock.calls[0][0]).toBe('Decline the invite to Paschal Home?');
    expect(rpcCallsFor('decline_invite')).toHaveLength(1);
    expect(getMyInvites()).toEqual([]);
  });
});

describe('on a list (mockup C)', () => {
  const cards = (onMessage: (m: string) => void = () => {}) => <ListInviteCards householdId="h1" onMessage={onMessage} />;

  test('nothing waiting, nothing shown', async () => {
    await startWith([]);
    render(cards());
    expect(tree!.toJSON()).toBeNull();
  });

  test('the first waiting invite is pinned, with Not now, Decline and Join', async () => {
    await startWith([ROW, ROW2]);
    render(cards());
    expect(lines()).toEqual(expect.arrayContaining(['Sam invited you to Paschal Home', '3 members · their lists join yours']));
    expect(lines()).not.toContain('Riley invited you to Lake Cabin');
    expect(hasPressable('Not now')).toBe(true);
    expect(hasPressable('Decline invite to Paschal Home')).toBe(true);
    expect(hasPressable('Join')).toBe(true);
  });

  test('Not now puts it away on this device, and the next one takes its place', async () => {
    await startWith([ROW, ROW2]);
    render(cards());
    press(pressable('Not now'));
    expect(getDeviceSetting(HIDDEN_INVITES_KEY, [])).toEqual(['i1']);
    expect(lines()).toContain('Riley invited you to Lake Cabin');
    press(pressable('Not now'));
    expect(tree!.toJSON()).toBeNull();
    // Still waiting, for the Your lists sheet.
    expect(getMyInvites()).toHaveLength(2);
  });

  test('a failed Join says why in the list\'s toast and keeps the card', async () => {
    await startWith([ROW]);
    respondToRpc('accept_invite_by_id', { error: { message: 'Network request failed' } });
    const onMessage = jest.fn();
    render(cards(onMessage));
    press(pressable('Join'));
    await flush();
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(lines()).toContain('Sam invited you to Paschal Home');
  });
});
