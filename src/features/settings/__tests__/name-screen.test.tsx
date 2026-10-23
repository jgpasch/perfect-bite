// Settings > Name (spec 4.7, board 10): the fields prefilled from the members' names cache, when Save
// is enabled, the save to `profiles` and the names reload, and the offline and failure errors.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { db, householdMemberNames, households } from '@/db';
import { ensureStarterData } from '@/features/lists/lists';
import { resetDb } from '@/test/db';
import { queriesFor, respondTo, respondToRpc, resetSupabase, rpcCallsFor } from '@/test/fake-supabase';

import NameScreen from '@/app/(tabs)/settings/name';

import { canSaveName, getMyName, saveMyName, SaveNameError } from '../name';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));

const mockBack = jest.fn();
jest.mock('expo-router', () => {
  const { createElement, Fragment } = require('react');
  const Toolbar = Object.assign(
    function PassThrough({ children }: { children?: unknown }) {
      return createElement(Fragment, null, children);
    },
    {
      Button: function Host({ children, ...props }: { children?: unknown }) {
        return createElement('ToolbarButton', props, children);
      },
      View: function Host({ children, ...props }: { children?: unknown }) {
        return createElement('ToolbarView', props, children);
      },
    },
  );
  return { Stack: { Toolbar }, router: { back: () => mockBack() } };
});

const USER = 'user-1';
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1', email: 'jo@example.com' }) }));

// `gate` holds the save at the connection check, to see it in progress.
const mockNetwork: { offline: boolean; gate: Promise<void> | null } = { offline: false, gate: null };
jest.mock('@/features/auth/delete-account', () => ({
  isOffline: async () => {
    if (mockNetwork.gate) await mockNetwork.gate;
    return mockNetwork.offline;
  },
}));

let householdId: string;
let tree: ReactTestRenderer | null = null;

beforeEach(() => {
  resetDb();
  resetSupabase();
  ensureStarterData(USER);
  householdId = db.select().from(households).get()!.id;
  mockBack.mockClear();
  mockNetwork.offline = false;
  mockNetwork.gate = null;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  jest.restoreAllMocks();
});

function cacheName(firstName: string, lastName: string | null, userId = USER, inHousehold = householdId) {
  db.insert(householdMemberNames)
    .values({ householdId: inHousehold, userId, firstName, lastName, joinedAt: '2026-10-01T00:00:00Z' })
    .run();
}

function open() {
  act(() => {
    tree = create(<NameScreen />);
  });
}

const field = (label: string) =>
  tree!.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && 'onChangeText' in n.props);
const type = (label: string, text: string) => act(() => field(label).props.onChangeText(text));
const saveButton = () => tree!.root.find((n) => n.type === ('ToolbarButton' as never) && n.props.children === 'Save');
const spinner = () => tree!.root.find((n) => n.type === ('ToolbarView' as never));
const textOf = (n: ReactTestInstance): string =>
  n.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
const alerts = () =>
  tree!.root.findAll((n) => n.type === ('Text' as never) && n.props.accessibilityRole === 'alert').map(textOf);
async function tapSave() {
  await act(async () => {
    saveButton().props.onPress();
  });
}

describe('canSaveName', () => {
  const saved = { firstName: 'Sam', lastName: 'Lee' };

  it('needs a change', () => {
    expect(canSaveName({ firstName: 'Sam', lastName: 'Lee' }, saved)).toBe(false);
    // Spaces around a name aren't a change: they're trimmed on save.
    expect(canSaveName({ firstName: ' Sam ', lastName: 'Lee  ' }, saved)).toBe(false);
    expect(canSaveName({ firstName: 'Samuel', lastName: 'Lee' }, saved)).toBe(true);
    expect(canSaveName({ firstName: 'Sam', lastName: '' }, saved)).toBe(true);
    expect(canSaveName({ firstName: 'Sam', lastName: 'Lee' }, { firstName: 'Sam', lastName: null })).toBe(true);
    expect(canSaveName({ firstName: 'Sam', lastName: '  ' }, { firstName: 'Sam', lastName: null })).toBe(false);
  });

  it('needs a first name of 1–50 characters after trimming', () => {
    expect(canSaveName({ firstName: '', lastName: 'Lee' }, null)).toBe(false);
    expect(canSaveName({ firstName: '   ', lastName: 'Lee' }, null)).toBe(false);
    expect(canSaveName({ firstName: 'A', lastName: '' }, null)).toBe(true);
    expect(canSaveName({ firstName: 'a'.repeat(50), lastName: '' }, null)).toBe(true);
    expect(canSaveName({ firstName: 'a'.repeat(51), lastName: '' }, null)).toBe(false);
    expect(canSaveName({ firstName: `  ${'a'.repeat(50)}  `, lastName: '' }, null)).toBe(true);
  });

  it('allows a last name of up to 50 characters', () => {
    expect(canSaveName({ firstName: 'Sam', lastName: 'b'.repeat(50) }, saved)).toBe(true);
    expect(canSaveName({ firstName: 'Sam', lastName: 'b'.repeat(51) }, saved)).toBe(false);
  });
});

describe('getMyName', () => {
  it("reads the user's own row from any household, skipping a blank first name", () => {
    cacheName('Alex', 'Rivera', 'user-2');
    expect(getMyName(USER)).toBeNull();
    cacheName('', null, USER, 'other-household-a');
    expect(getMyName(USER)).toBeNull();
    cacheName('Sam', 'Lee', USER, 'other-household-b');
    expect(getMyName(USER)).toEqual({ firstName: 'Sam', lastName: 'Lee' });
    expect(getMyName(null)).toBeNull();
  });
});

describe('saveMyName', () => {
  it('updates the profile trimmed, a blank last name as null, then reloads every household', async () => {
    db.insert(households).values({ id: 'h2', name: 'Cabin' }).run();
    await saveMyName(USER, '  Sam ', '   ');
    expect(queriesFor('profiles').map((q) => q.ops)).toEqual([
      [
        ['update', { first_name: 'Sam', last_name: null }],
        ['eq', 'user_id', USER],
      ],
    ]);
    expect(rpcCallsFor('get_household_members').map((c) => c.args?.p_household_id).sort()).toEqual(
      [householdId, 'h2'].sort(),
    );
  });

  it('throws offline without calling the server', async () => {
    mockNetwork.offline = true;
    await expect(saveMyName(USER, 'Sam', 'Lee')).rejects.toMatchObject({ kind: 'offline' });
    expect(queriesFor('profiles')).toEqual([]);
    expect(rpcCallsFor('get_household_members')).toEqual([]);
  });

  it('throws failed when the server refuses, and reloads nothing', async () => {
    respondTo('profiles', { error: { message: 'new row violates check constraint' } });
    const err = await saveMyName(USER, 'Sam', 'Lee').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SaveNameError);
    expect(err).toMatchObject({ kind: 'failed', message: 'new row violates check constraint' });
    expect(rpcCallsFor('get_household_members')).toEqual([]);
  });
});

describe('Name screen', () => {
  it('prefills the fields from the cache, with given and family name autofill', () => {
    cacheName('Sam', 'Lee');
    open();
    expect(field('First name').props.value).toBe('Sam');
    expect(field('First name').props.textContentType).toBe('givenName');
    expect(field('Last name').props.value).toBe('Lee');
    expect(field('Last name').props.textContentType).toBe('familyName');
    expect(field('Last name').props.placeholder).toBe('Optional');
    // Nothing changed yet.
    expect(saveButton().props.disabled).toBe(true);
  });

  it('starts empty with no cached name, and enables Save once there is a first name', () => {
    open();
    expect(field('First name').props.value).toBe('');
    expect(field('Last name').props.value).toBe('');
    expect(saveButton().props.disabled).toBe(true);
    type('Last name', 'Lee');
    expect(saveButton().props.disabled).toBe(true);
    type('First name', '   ');
    expect(saveButton().props.disabled).toBe(true);
    type('First name', 'Sam');
    expect(saveButton().props.disabled).toBe(false);
  });

  it('disables Save when the edit goes back to the saved name or clears the first name', () => {
    cacheName('Sam', null);
    open();
    type('Last name', 'Lee');
    expect(saveButton().props.disabled).toBe(false);
    type('Last name', '');
    expect(saveButton().props.disabled).toBe(true);
    type('First name', '');
    expect(saveButton().props.disabled).toBe(true);
  });

  it('saves to the profile, reloads the names and goes back', async () => {
    cacheName('Sam', null);
    respondToRpc('get_household_members', {
      data: [{ user_id: USER, first_name: 'Samuel', last_name: 'Lee', joined_at: '2026-10-01T00:00:00Z' }],
    });
    open();
    type('First name', ' Samuel ');
    type('Last name', 'Lee');
    await tapSave();
    expect(queriesFor('profiles')[0].ops[0]).toEqual(['update', { first_name: 'Samuel', last_name: 'Lee' }]);
    expect(getMyName(USER)).toEqual({ firstName: 'Samuel', lastName: 'Lee' });
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(alerts()).toEqual([]);
  });

  it('offline: says so inline, keeps the edits and stays', async () => {
    cacheName('Sam', 'Lee');
    mockNetwork.offline = true;
    open();
    type('First name', 'Samuel');
    await tapSave();
    expect(alerts()).toEqual(["You're offline. Connect to the internet to save your name."]);
    expect(field('First name').props.value).toBe('Samuel');
    expect(saveButton().props.disabled).toBe(false);
    expect(saveButton().props.hidden).toBe(false);
    expect(mockBack).not.toHaveBeenCalled();
    expect(queriesFor('profiles')).toEqual([]);
    // Editing again clears the error.
    type('First name', 'Sammy');
    expect(alerts()).toEqual([]);
  });

  it('a failed save says so inline, keeps the edits and the cached name', async () => {
    cacheName('Sam', 'Lee');
    respondTo('profiles', { error: { message: 'boom' } });
    open();
    type('Last name', 'Leigh');
    await tapSave();
    expect(alerts()).toEqual(["Couldn't save your name. Try again."]);
    expect(field('Last name').props.value).toBe('Leigh');
    expect(getMyName(USER)).toEqual({ firstName: 'Sam', lastName: 'Lee' });
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('shows a spinner in place of Save while saving', async () => {
    cacheName('Sam', 'Lee');
    let release = () => {};
    mockNetwork.gate = new Promise<void>((resolve) => (release = resolve));
    open();
    expect(spinner().props.hidden).toBe(true);
    type('First name', 'Samuel');
    act(() => saveButton().props.onPress());
    expect(spinner().props.hidden).toBe(false);
    expect(saveButton().props.hidden).toBe(true);
    expect(field('First name').props.editable).toBe(false);
    await act(async () => release());
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});
