// Settings (board 10) and the screens it opens: Aisle colours, Siri adds to, Sync status and
// Developer. Rendered against the in-memory database; the device and user settings they write are
// read back from it.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ReactElement } from 'react';
import { AccessibilityInfo, Alert, Modal, Switch } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { db, households } from '@/db';
import type { AccountState } from '@/features/auth/account';
import { setDeletedHousehold } from '@/features/households/deleted-household-notice';
import { createList, ensureStarterData, getDefaultListId, setDefaultList, setListArchived } from '@/features/lists/lists';
import type { PendingSiriAdd } from '@/features/siri/app-group';
import { currentLanguage, initI18n } from '@/i18n';
import { resetDb } from '@/test/db';
import type { SyncStatus } from '@/sync/status';

import SettingsScreen from '@/app/(tabs)/settings/index';
import AisleColorsScreen from '@/app/(tabs)/settings/aisle-colors';
import LanguageScreen from '@/app/(tabs)/settings/language';
import DeveloperScreen from '@/app/(tabs)/settings/developer';
import SiriDefaultListScreen from '@/app/(tabs)/settings/siri';
import SyncStatusScreen from '@/app/(tabs)/settings/sync';

import {
  getAisleColorStyle,
  getAlwaysShowChecked,
  getItemRowStyle,
  getDeviceSetting,
  getKeepScreenOn,
  getPlanTab,
  PLAN_TAB_KEY,
  setAisleColorStyle,
  setDeviceSetting,
  setKeepScreenOn,
  setPlanTab,
} from '../device-settings';
import { getLanguageChoice, LANGUAGE_KEY, startupLanguage } from '../language';

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
    FadeInDown: builder,
    FadeOut: builder,
    LinearTransition: builder,
    useReducedMotion: () => false,
  };
});
jest.mock('expo-constants',() => ({ __esModule: true, default: { expoConfig: { version: '1.2.3' } } }));
// The screens' live queries, read again on every render.
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const { useEffect } = require('react');
  return {
    router: { push: (...args: unknown[]) => mockPush(...args), back: () => {} },
    // Focus is mount: a screen comes back into focus by rendering it again.
    useFocusEffect: (effect: () => void) => useEffect(effect, [effect]),
  };
});

const USER = 'user-1';
const mockAccount: { state: AccountState } = { state: { status: 'ready', account: { userId: 'user-1', email: 'jo@example.com' } } };
const mockSignOut = jest.fn(() => Promise.resolve());
jest.mock('@/features/auth/account', () => ({
  useAccountState: () => mockAccount.state,
  getAccount: () => (mockAccount.state.status === 'ready' ? mockAccount.state.account : null),
}));
// Sign-out's push and wipe are tested in sign-out.test.ts; here only that the button calls it.
jest.mock('@/features/auth/sign-out', () => ({
  ...jest.requireActual<object>('@/features/auth/sign-out'),
  signOutAndWipe: () => mockSignOut(),
}));

// Delete account's server work is tested in delete-account.test.ts; here only the screen's flow.
const mockDelete = {
  offline: false,
  households: null as unknown,
  run: jest.fn<() => Promise<void>>(),
};
jest.mock('@/features/auth/delete-account', () => ({
  ...jest.requireActual<object>('@/features/auth/delete-account'),
  isOffline: async () => mockDelete.offline,
  householdsForDeletion: async () => mockDelete.households,
  deleteAccount: () => mockDelete.run(),
}));

const synced: SyncStatus = {
  state: 'synced',
  label: 'Synced',
  tone: 'positive',
  pending: 0,
  rejected: 0,
  lastSuccessAt: null,
  lastError: null,
  canSyncNow: true,
};
const mockSync: { status: SyncStatus } = { status: synced };
jest.mock('@/features/settings/use-sync-status', () => ({ useSyncStatus: () => mockSync.status }));
const mockSyncNow = jest.fn(() => Promise.resolve({}));
jest.mock('@/sync/status', () => ({
  ...jest.requireActual<object>('@/sync/status'),
  syncNow: () => mockSyncNow(),
}));

const mockAppGroup: { adds: PendingSiriAdd[]; log: string; container: boolean; fail?: Error } = {
  adds: [],
  log: '',
  container: true,
};
const mockWriteSnapshot = jest.fn();
jest.mock('@/features/siri/app-group', () => ({
  getAppGroupContainer: () => (mockAppGroup.container ? {} : undefined),
  readPendingSiriAdds: () => {
    if (mockAppGroup.fail) throw mockAppGroup.fail;
    return [...mockAppGroup.adds];
  },
  readNativeLog: () => mockAppGroup.log,
  writeListSnapshot: (snapshot: unknown) => mockWriteSnapshot(snapshot),
}));

let tree: ReactTestRenderer | null = null;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  mockPush.mockClear();
  mockSignOut.mockClear();
  mockSyncNow.mockClear();
  mockWriteSnapshot.mockClear();
  mockAccount.state = { status: 'ready', account: { userId: USER, email: 'jo@example.com' } };
  mockSync.status = synced;
  Object.assign(mockAppGroup, { adds: [], log: '', container: true, fail: undefined });
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  jest.restoreAllMocks();
});

function render(element: ReactElement): ReactTestRenderer {
  act(() => {
    tree = create(element);
  });
  return tree!;
}

/** Renders the screen again, as a live query or a returning focus would. */
function rerender(element: ReactElement) {
  act(() => tree!.update(element));
}

const hosts = (root: ReactTestRenderer, match: (props: Record<string, unknown>) => boolean) =>
  root.root.findAll((n) => typeof n.type === 'string' && match(n.props));
const buttons = (root: ReactTestRenderer) => hosts(root, (p) => p.accessibilityRole === 'button');
const button = (root: ReactTestRenderer, label: string | RegExp) => {
  const found = buttons(root).filter((b) =>
    typeof label === 'string' ? b.props.accessibilityLabel === label : label.test(b.props.accessibilityLabel),
  );
  if (found.length !== 1) throw new Error(`${found.length} buttons labelled ${label}`);
  return found[0];
};
const click = (n: ReactTestInstance) => act(() => n.props.onClick({ nativeEvent: {} }));
const labelled = (root: ReactTestRenderer, label: string) => hosts(root, (p) => p.accessibilityLabel === label);
const headers = (root: ReactTestRenderer) =>
  hosts(root, (p) => p.accessibilityRole === 'header').map((n) => n.props.children);

/** Every string in the rendered host tree, joined with spaces. */
function textOf(root: ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object' && 'children' in node) walk((node as { children: unknown }).children);
  };
  walk(root.toJSON());
  return out.join(' ');
}

describe('Settings', () => {
  it('reads the account card as who is signed in and the sync status', () => {
    const root = render(<SettingsScreen />);
    expect(labelled(root, 'Signed in as jo@example.com, Synced')).toHaveLength(1);
    // The avatar's initial comes first, then the email.
    expect(textOf(root)).toMatch(/^J jo@example\.com Signed in/);
    expect(textOf(root)).toMatch(/Version\s+1\.2\.3/);
  });

  it('shows the Shopping, Aisles and General rows with their current values', () => {
    const root = render(<SettingsScreen />);
    expect(headers(root)).toEqual(expect.arrayContaining(['Shopping', 'Aisles', 'General', 'Households']));
    button(root, 'Siri adds to, Groceries');
    button(root, 'Store aisle order');
    button(root, 'Aisle colours, Whole row');
    button(root, 'Sync status, Synced');
  });

  it('opens each Shopping screen', () => {
    const root = render(<SettingsScreen />);
    click(button(root, /^Siri adds to/));
    click(button(root, 'Store aisle order'));
    click(button(root, /^Aisle colours/));
    click(button(root, /^Sync status/));
    expect(mockPush.mock.calls).toEqual([
      ['/settings/siri'],
      ['/category-order'],
      ['/settings/aisle-colors'],
      ['/settings/sync'],
    ]);
  });

  it('lists each household, opening its screen', () => {
    const householdId = db.select().from(households).get()!.id;
    const root = render(<SettingsScreen />);
    click(button(root, 'Personal, 1 list · 0 recipes'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/settings/households/[id]', params: { id: householdId } });
  });

  it('says "Deleted <household>" once, on coming back from deleting one', () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    setDeletedHousehold('Cabin');
    const root = render(<SettingsScreen />);
    // The name is set in bold, its own Text.
    expect(textOf(root)).toMatch(/Deleted\s+Cabin$/);
    expect(announce).toHaveBeenCalledWith('Deleted Cabin');
    // Taken once: focusing Settings again doesn't show it again.
    act(() => tree!.unmount());
    const again = render(<SettingsScreen />);
    expect(textOf(again)).not.toContain('Deleted');
  });

  it('shows no toast without a deleted household', () => {
    const root = render(<SettingsScreen />);
    expect(textOf(root)).not.toContain('Deleted');
  });

  it('hides Households with none on the device', () => {
    resetDb();
    const root = render(<SettingsScreen />);
    expect(headers(root)).not.toContain('Households');
    button(root, 'Siri adds to, —');
  });

  it('dev builds get the Developer row', () => {
    const root = render(<SettingsScreen />);
    click(button(root, 'Siri queue and log'));
    expect(mockPush).toHaveBeenCalledWith('/settings/developer');
  });

  it('picks up a new aisle colours choice on coming back', () => {
    button(render(<SettingsScreen />), 'Aisle colours, Whole row');
    setAisleColorStyle('header');
    act(() => tree?.unmount());
    button(render(<SettingsScreen />), 'Aisle colours, Header only');
  });

  it('Keep screen on is a switch, on by default, that turns the device setting off and on', () => {
    const root = render(<SettingsScreen />);
    expect(textOf(root)).toContain('Keep screen on While a list has items to get');
    const toggle = () => root.root.find((n) => n.type === Switch && n.props.accessibilityLabel === 'Keep screen on');
    expect(toggle().props.accessibilityHint).toBe('Stops the screen locking while a list has items to get');
    expect(toggle().props.value).toBe(true);
    act(() => toggle().props.onValueChange(false));
    expect(getKeepScreenOn()).toBe(false);
    expect(toggle().props.value).toBe(false);
    act(() => toggle().props.onValueChange(true));
    expect(getKeepScreenOn()).toBe(true);
    expect(toggle().props.value).toBe(true);
  });

  it('Keep screen on shows off when it was turned off before', () => {
    setKeepScreenOn(false);
    const root = render(<SettingsScreen />);
    expect(root.root.find((n) => n.type === Switch && n.props.accessibilityLabel === 'Keep screen on').props.value).toBe(false);
  });

  it('Meal plan > Plan tab is a switch, on by default, with its footnote, that turns the device setting off and on', () => {
    const root = render(<SettingsScreen />);
    expect(headers(root)).toContain('Meal plan');
    expect(textOf(root)).toContain('Plan tab Your week plan gets its own tab. Off, it lives in Recipes under This week.');
    const toggle = () => root.root.find((n) => n.type === Switch && n.props.accessibilityLabel === 'Plan tab');
    expect(toggle().props.value).toBe(true);
    act(() => toggle().props.onValueChange(false));
    expect(getPlanTab()).toBe(false);
    expect(getDeviceSetting(PLAN_TAB_KEY, null)).toBe(false);
    expect(toggle().props.value).toBe(false);
    act(() => toggle().props.onValueChange(true));
    expect(getPlanTab()).toBe(true);
    expect(toggle().props.value).toBe(true);
  });

  it('Plan tab shows off when it was turned off before, and follows a change made elsewhere', () => {
    setPlanTab(false);
    const root = render(<SettingsScreen />);
    const toggle = () => root.root.find((n) => n.type === Switch && n.props.accessibilityLabel === 'Plan tab');
    expect(toggle().props.value).toBe(false);
    act(() => setPlanTab(true));
    expect(toggle().props.value).toBe(true);
  });

  it('Always show checked items is a switch, off by default, that turns the device setting on and off', () => {
    const root = render(<SettingsScreen />);
    expect(textOf(root)).toContain("Always show checked items Otherwise they show once everything's checked");
    const toggle = () => root.root.find((n) => n.type === Switch && n.props.accessibilityLabel === 'Always show checked items');
    expect(toggle().props.value).toBe(false);
    act(() => toggle().props.onValueChange(true));
    expect(getAlwaysShowChecked()).toBe(true);
    expect(toggle().props.value).toBe(true);
    act(() => toggle().props.onValueChange(false));
    expect(getAlwaysShowChecked()).toBe(false);
  });

  describe('Households', () => {
    it('comes first, under the account card: one row per household with its counts and no switches', () => {
      db.insert(households).values({ id: 'h-cabin', name: 'Cabin', combineLanguages: true }).run();
      const root = render(<SettingsScreen />);
      expect(headers(root)[0]).toBe('Households');
      expect(textOf(root)).toContain(
        'Households Personal 1 list · 0 recipes Cabin 0 lists · 0 recipes Members, invites, Always have and name matching are in each household. Shopping',
      );
      expect(root.root.findAll((n) => n.type === Switch && /^Combine/.test(n.props.accessibilityLabel ?? ''))).toEqual([]);
    });
  });

  it('follows the Siri default list', () => {
    const other = createList('Costco');
    const root = render(<SettingsScreen />);
    button(root, 'Siri adds to, Groceries');
    act(() => setDefaultList(USER, other));
    rerender(<SettingsScreen />);
    button(root, 'Siri adds to, Costco');
  });

  it('Sign out signs out', async () => {
    const root = render(<SettingsScreen />);
    click(button(root, 'Sign out'));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('a failed sign out is logged, not thrown', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSignOut.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    const root = render(<SettingsScreen />);
    click(button(root, 'Sign out'));
    await act(async () => {});
    expect(warn).toHaveBeenCalledWith('[settings] sign out failed', expect.any(Error));
  });
});

describe('Delete account', () => {
  type AlertButton = { text: string; style?: string; onPress?: () => void };
  let alert: jest.SpiedFunction<typeof Alert.alert>;
  const alertCall = (i: number) => {
    const [title, message, buttons] = alert.mock.calls[i] as [string, string, AlertButton[] | undefined];
    return { title, message, buttons };
  };
  const press = async (i: number, text: string) => {
    await act(async () => alertCall(i).buttons!.find((b) => b.text === text)!.onPress!());
  };
  const tapDelete = async (root: ReactTestRenderer) => {
    click(button(root, 'Delete account'));
    await act(async () => {});
  };

  beforeEach(() => {
    alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    mockDelete.offline = false;
    mockDelete.households = [{ name: 'Personal', listCount: 1, recipeCount: 0, memberCount: 1 }];
    mockDelete.run.mockReset();
    mockDelete.run.mockImplementation(() => Promise.resolve());
  });

  it('is a danger button under Sign out, with the version under it, and a hint', () => {
    const root = render(<SettingsScreen />);
    const del = button(root, 'Delete account');
    expect(del.props.accessibilityHint).toBe('Deletes your account and data. Asks you first.');
    expect(textOf(root)).toMatch(/Sign out\s+Delete account\s+Version\s+1\.2\.3$/);
  });

  it('offline, says so and does nothing else', async () => {
    mockDelete.offline = true;
    await tapDelete(render(<SettingsScreen />));
    expect(alert.mock.calls).toEqual([["You're offline", 'Connect to the internet to delete your account.']]);
    expect(mockDelete.run).not.toHaveBeenCalled();
  });

  it('asks twice, then deletes behind the overlay', async () => {
    const pending: { resolve?: () => void } = {};
    mockDelete.run.mockImplementation(() => new Promise<void>((resolve) => (pending.resolve = resolve)));
    const root = render(<SettingsScreen />);
    await tapDelete(root);
    expect(alertCall(0).title).toBe('Delete your account?');
    expect(alertCall(0).message).toContain("Personal and its 1 list and 0 recipes will be deleted, because you're its only member.");
    expect(alertCall(0).buttons!.map((b) => [b.text, b.style])).toEqual([
      ['Cancel', 'cancel'],
      ['Delete account', 'destructive'],
    ]);
    await press(0, 'Delete account');
    expect(mockDelete.run).not.toHaveBeenCalled();
    expect(alertCall(1).title).toBe('Are you sure?');
    expect(alertCall(1).message).toBe('Your account will be deleted now.');
    expect(alertCall(1).buttons!.map((b) => [b.text, b.style])).toEqual([
      ['Cancel', 'cancel'],
      ['Delete', 'destructive'],
    ]);
    await press(1, 'Delete');
    expect(mockDelete.run).toHaveBeenCalledTimes(1);
    expect(root.root.findByType(Modal).props.visible).toBe(true);
    expect(textOf(root)).toContain('Deleting your account…');
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith('Deleting your account');
    await act(async () => pending.resolve!());
  });

  it('words the confirm without household lines when members could not be fetched', async () => {
    mockDelete.households = null;
    await tapDelete(render(<SettingsScreen />));
    expect(alertCall(0).message).toBe(
      "This can't be undone. Your account, your aisle order and your settings will be deleted.",
    );
  });

  it('a failure hides the overlay and says nothing was deleted', async () => {
    mockDelete.run.mockImplementation(() => Promise.reject(new Error('boom')));
    const root = render(<SettingsScreen />);
    await tapDelete(root);
    await press(0, 'Delete account');
    await press(1, 'Delete');
    expect(alertCall(2)).toEqual({
      title: "Couldn't delete your account",
      message: 'Nothing was deleted. Try again later.',
      buttons: undefined,
    });
    expect(root.root.findByType(Modal).props.visible).toBe(false);
  });

  it('Cancel deletes nothing', async () => {
    await tapDelete(render(<SettingsScreen />));
    expect(alertCall(0).buttons!.find((b) => b.text === 'Cancel')!.onPress).toBeUndefined();
    expect(mockDelete.run).not.toHaveBeenCalled();
  });
});

describe('Aisle colours', () => {
  it('ticks the saved choice, Whole row by default', () => {
    const root = render(<AisleColorsScreen />);
    expect(button(root, 'Whole row').props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
    expect(button(root, 'Header only').props.accessibilityState).toEqual(expect.objectContaining({ selected: false }));
  });

  it('saves a new choice on this device and moves the tick', () => {
    const root = render(<AisleColorsScreen />);
    click(button(root, 'Header only'));
    expect(getAisleColorStyle()).toBe('header');
    expect(button(root, 'Header only').props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
    expect(button(root, 'Whole row').props.accessibilityState).toEqual(expect.objectContaining({ selected: false }));
    click(button(root, 'Whole row'));
    expect(getAisleColorStyle()).toBe('rows');
  });

  it('saves the item row style on this device, Colour bands by default', () => {
    const root = render(<AisleColorsScreen />);
    expect(button(root, 'Colour bands').props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
    click(button(root, 'White rows'));
    expect(getItemRowStyle()).toBe('white');
    expect(button(root, 'White rows').props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
    expect(button(root, 'Colour bands').props.accessibilityState).toEqual(expect.objectContaining({ selected: false }));
  });

  it('opens on a choice saved earlier', () => {
    setAisleColorStyle('header');
    const root = render(<AisleColorsScreen />);
    expect(button(root, 'Header only').props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
  });
});

describe('Language', () => {
  // The rest of the suite runs in English.
  afterEach(() => {
    act(() => initI18n('en'));
  });

  it('shows the app language on the Settings row', () => {
    const root = render(<SettingsScreen />);
    expect(headers(root)).toEqual(expect.arrayContaining(['General']));
    click(button(root, 'Language, English'));
    expect(mockPush).toHaveBeenCalledWith('/settings/language');
  });

  it('follows the phone until a language is picked', () => {
    const root = render(<LanguageScreen />);
    expect(getLanguageChoice()).toBeNull();
    expect(button(root, 'Same as phone, English').props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
    expect(button(root, 'Español').props.accessibilityState).toEqual(expect.objectContaining({ selected: false }));
  });

  it('switches the app at once, saves the choice on this device, and goes back to the phone', () => {
    const root = render(<LanguageScreen />);
    click(button(root, 'Español'));
    expect(currentLanguage()).toBe('es');
    expect(getLanguageChoice()).toBe('es');
    expect(startupLanguage()).toBe('es');
    // The screen's own text follows: the phone row reads in Spanish now.
    expect(button(root, 'Español').props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
    button(root, 'Igual que el teléfono, English');

    click(button(root, 'Igual que el teléfono, English'));
    expect(currentLanguage()).toBe('en');
    expect(getLanguageChoice()).toBeNull();
    expect(button(root, 'Same as phone, English').props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
  });

  it('ignores a saved value it has no strings for', () => {
    setDeviceSetting(LANGUAGE_KEY, 'fr');
    expect(getLanguageChoice()).toBeNull();
    expect(startupLanguage()).toBe('en');
  });
});

describe('Siri adds to', () => {
  const selected = (root: ReactTestRenderer) =>
    buttons(root)
      .filter((b) => b.props.accessibilityState?.selected)
      .map((b) => b.props.accessibilityLabel);

  it('ticks the default list', () => {
    createList('Costco');
    const root = render(<SiriDefaultListScreen />);
    expect(buttons(root).map((b) => b.props.accessibilityLabel)).toEqual(['Groceries', 'Costco']);
    expect(selected(root)).toEqual(['Groceries']);
  });

  it('picking a list makes it the default and moves the tick', () => {
    const costco = createList('Costco');
    const root = render(<SiriDefaultListScreen />);
    click(button(root, 'Costco'));
    expect(getDefaultListId(USER)).toBe(costco);
    rerender(<SiriDefaultListScreen />);
    expect(selected(root)).toEqual(['Costco']);
  });

  it('names the household when there is more than one', () => {
    db.insert(households).values({ id: 'h2', name: 'Cabin' }).run();
    createList('Lake shop', 'h2');
    const root = render(<SiriDefaultListScreen />);
    expect(buttons(root).map((b) => b.props.accessibilityLabel)).toEqual(['Groceries, Personal', 'Lake shop, Cabin']);
  });

  it('leaves out archived lists', () => {
    const costco = createList('Costco');
    setListArchived(costco, true);
    const root = render(<SiriDefaultListScreen />);
    expect(buttons(root).map((b) => b.props.accessibilityLabel)).toEqual(['Groceries']);
  });

  it('says No lists with none', () => {
    resetDb();
    const root = render(<SiriDefaultListScreen />);
    expect(buttons(root)).toHaveLength(0);
    expect(labelled(root, 'No lists')).toHaveLength(1);
  });

  it('signed out, the rows are not buttons', () => {
    mockAccount.state = { status: 'signedOut' };
    const root = render(<SiriDefaultListScreen />);
    expect(buttons(root)).toHaveLength(0);
  });
});

describe('Sync status', () => {
  it('shows the status, what is waiting and when it last synced', () => {
    jest.useFakeTimers({ now: new Date('2026-10-12T12:00:00Z') });
    try {
      mockSync.status = { ...synced, pending: 3, lastSuccessAt: '2026-10-12T11:55:00Z' };
      const root = render(<SyncStatusScreen />);
      expect(labelled(root, 'Status, Synced')).toHaveLength(1);
      expect(labelled(root, 'Waiting to send, 3')).toHaveLength(1);
      expect(labelled(root, 'Last synced, 5 min ago')).toHaveLength(1);
      expect(labelled(root, 'Not accepted, 0')).toHaveLength(0);
      // The clock ticks every 30 s, so "N min ago" keeps up while nothing else changes.
      act(() => jest.advanceTimersByTime(60_000));
      expect(labelled(root, 'Last synced, 6 min ago')).toHaveLength(1);
    } finally {
      act(() => tree?.unmount());
      tree = null;
      jest.useRealTimers();
    }
  });

  it('shows rejected changes and the last error', () => {
    mockSync.status = {
      ...synced,
      state: 'error',
      label: 'Sync error',
      tone: 'danger',
      rejected: 2,
      lastError: 'Sending: boom',
    };
    const root = render(<SyncStatusScreen />);
    expect(labelled(root, 'Not accepted, 2')).toHaveLength(1);
    expect(labelled(root, 'Last error: Sending: boom')).toHaveLength(1);
    expect(labelled(root, 'Last synced, Never')).toHaveLength(1);
  });

  it('Sync now syncs', async () => {
    const root = render(<SyncStatusScreen />);
    click(button(root, 'Sync now'));
    await act(async () => {});
    expect(mockSyncNow).toHaveBeenCalledTimes(1);
  });

  it('a failed Sync now is logged, not thrown', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSyncNow.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    const root = render(<SyncStatusScreen />);
    click(button(root, 'Sync now'));
    await act(async () => {});
    expect(warn).toHaveBeenCalledWith('[sync] sync now failed', expect.any(Error));
  });

  it('while syncing, the button says so and is disabled', () => {
    mockSync.status = { ...synced, state: 'syncing', label: 'Syncing…', tone: 'pending', canSyncNow: false };
    const root = render(<SyncStatusScreen />);
    const b = button(root, 'Syncing…');
    expect(b.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    click(b);
    expect(mockSyncNow).not.toHaveBeenCalled();
  });

  it('offline, Sync now is disabled and explains changes are kept', () => {
    mockSync.status = { ...synced, state: 'offline', label: 'Offline', tone: 'pending', canSyncNow: false };
    const root = render(<SyncStatusScreen />);
    expect(button(root, 'Sync now').props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    expect(textOf(root)).toContain('Changes are kept on this phone');
  });
});

describe('Developer', () => {
  const add = (id: string, text: string, listId?: string): PendingSiriAdd =>
    ({
      ok: true,
      file: {},
      envelope: { id, source: 'siri', text, listId, createdAt: '2026-10-12T12:00:00Z', appVersion: '1' },
    }) as PendingSiriAdd;

  it('shows the queue newest first, naming each list', () => {
    const groceries = getDefaultListId(USER)!;
    mockAppGroup.adds = [
      add('019a4c10-0000-7000-8000-000000000001', 'milk', groceries),
      add('019a4c10-0000-7000-8000-000000000002', 'eggs', '019a4c10-0000-7000-8000-00000000c057'),
      add('019a4c10-0000-7000-8000-000000000003', 'bread'),
      { ok: false, file: {}, fileName: 'bad.json', error: 'SyntaxError' } as PendingSiriAdd,
    ];
    const root = render(<DeveloperScreen />);
    expect(headers(root)).toContain('Siri queue (4)');
    const rows = hosts(root, (p) => p.accessible === true && typeof p.accessibilityLabel === 'string')
      .map((n) => n.props.accessibilityLabel as string)
      .filter((l) => /^(milk|eggs|bread|Invalid)/.test(l));
    expect(rows).toEqual([
      'Invalid: bad.json, SyntaxError',
      expect.stringMatching(/^bread, Default list · /),
      expect.stringMatching(/^eggs, Costco · /),
      expect.stringMatching(/^milk, Groceries · /),
    ]);
  });

  it('says Nothing queued and shows the log', () => {
    mockAppGroup.log = 'line 1\nline 2\n';
    const root = render(<DeveloperScreen />);
    expect(headers(root)).toContain('Siri queue (0)');
    expect(labelled(root, 'Nothing queued')).toHaveLength(1);
    expect(textOf(root)).toContain('line 1\nline 2');
    expect(textOf(root)).toContain('available');
  });

  it('keeps only the last 20 log lines', () => {
    mockAppGroup.log = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const root = render(<DeveloperScreen />);
    expect(textOf(root)).toContain('line 11\n');
    expect(textOf(root)).not.toContain('line 10\n');
  });

  it('writes the test lists, then refreshes', () => {
    const root = render(<DeveloperScreen />);
    mockAppGroup.adds = [add('019a4c10-0000-7000-8000-000000000001', 'milk')];
    click(button(root, 'Write test lists (Groceries, Costco)'));
    expect(mockWriteSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ defaultListId: '019a4c10-0000-7000-8000-00000000a001' }),
    );
    expect(headers(root)).toContain('Siri queue (1)');
  });

  it('Refresh reads the queue again', () => {
    const root = render(<DeveloperScreen />);
    mockAppGroup.adds = [add('019a4c10-0000-7000-8000-000000000001', 'milk')];
    click(button(root, 'Refresh'));
    expect(headers(root)).toContain('Siri queue (1)');
  });

  it('shows an error reading the App Group, and a missing container', () => {
    mockAppGroup.fail = new Error('no entitlement');
    mockAppGroup.container = false;
    const root = render(<DeveloperScreen />);
    expect(textOf(root)).toContain('Error: no entitlement');
    expect(textOf(root)).toContain('missing (needs a development build)');
  });

  it('shows an error writing the test lists', () => {
    mockWriteSnapshot.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const root = render(<DeveloperScreen />);
    click(button(root, 'Write test lists (Groceries, Costco)'));
    expect(textOf(root)).toContain('Error: disk full');
  });
});
