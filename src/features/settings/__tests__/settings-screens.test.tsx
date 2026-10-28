// Settings (board 10) and the screens it opens: Aisle colours, Siri adds to, Sync status and
// Developer. Rendered against the in-memory database; the device and user settings they write are
// read back from it.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ReactElement } from 'react';
import { AccessibilityInfo, Alert, Modal, StyleSheet, Switch, Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { db, householdMemberNames, households } from '@/db';
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
import { COOK_VIEW_STYLE_KEY, getCookViewStyle, setCookViewStyle } from '@/features/recipes/cook-style';
import { getRecipeViewStyle, RECIPE_VIEW_STYLE_KEY, setRecipeViewStyle } from '@/features/recipes/view-style';
import { getPlanCellStyle, PLAN_CELL_STYLE_KEY, setPlanCellStyle } from '@/features/meal-plan/cell-style';
import { ADD_HINT_SEEN_KEY, ADD_TAP_COUNT_KEY } from '@/features/tabs/add-hint';
import { FONT_SET_KEY, getFontSetSetting, loadFontSet, setFontSetSetting } from '../font-set';
import { getLanguageChoice, LANGUAGE_KEY, startupLanguage } from '../language';
import * as deviceSettings from '../device-settings';
import FontSetsSheet from '@/app/font-sets';
import { applyFontSet, getFontSet } from '@/hooks/font-set';

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
  quarantined: 0,
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
  applyFontSet('bricolage');
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

  it('shows the cached full name over the email, the initial from the first name, and opens Name (spec 4.7)', () => {
    const householdId = db.select().from(households).get()!.id;
    db.insert(householdMemberNames)
      .values([
        { householdId, userId: 'user-2', firstName: 'Alex', lastName: null, joinedAt: '2026-10-01T00:00:00Z' },
        { householdId, userId: USER, firstName: 'Sam', lastName: 'Lee', joinedAt: '2026-10-01T00:00:00Z' },
      ])
      .run();
    const root = render(<SettingsScreen />);
    expect(textOf(root)).toMatch(/^S Sam Lee jo@example\.com Synced/);
    expect(textOf(root)).not.toContain('Signed in');
    const card = button(root, 'Signed in as Sam Lee, jo@example.com, Synced');
    expect(card.props.accessibilityHint).toBe('Edits your name');
    click(card);
    expect(mockPush).toHaveBeenCalledWith('/settings/name');
  });

  it('shows a single cached name without a trailing space', () => {
    const householdId = db.select().from(households).get()!.id;
    db.insert(householdMemberNames)
      .values({ householdId, userId: USER, firstName: 'Cher', lastName: null, joinedAt: '2026-10-01T00:00:00Z' })
      .run();
    const root = render(<SettingsScreen />);
    expect(textOf(root)).toMatch(/^C Cher jo@example\.com/);
    button(root, 'Signed in as Cher, jo@example.com, Synced');
  });

  it('shows the email as before while no name is cached, still opening Name', () => {
    const householdId = db.select().from(households).get()!.id;
    // Another member's name doesn't count as the user's.
    db.insert(householdMemberNames)
      .values({ householdId, userId: 'user-2', firstName: 'Alex', lastName: 'Rivera', joinedAt: '2026-10-01T00:00:00Z' })
      .run();
    const root = render(<SettingsScreen />);
    expect(textOf(root)).toMatch(/^J jo@example\.com Signed in/);
    click(button(root, 'Signed in as jo@example.com, Synced'));
    expect(mockPush).toHaveBeenCalledWith('/settings/name');
  });

  it('shows the Shopping, Aisles and General rows with their current values', () => {
    const root = render(<SettingsScreen />);
    expect(headers(root)).toEqual(expect.arrayContaining(['Shopping', 'Aisles', 'General', 'Households']));
    button(root, 'Siri adds to, Groceries');
    button(root, 'Aisle colours, Whole row');
    button(root, 'Sync status, Synced');
  });

  it('has no top-level aisle order entry: it is in each household (spec 4.3.3)', () => {
    const root = render(<SettingsScreen />);
    const labels = buttons(root).map((b) => b.props.accessibilityLabel as string);
    expect(labels.filter((l) => /aisle order/i.test(l))).toEqual([]);
    expect(textOf(root)).toContain('Members, invites, Always have, aisle order and name matching are in each household.');
  });

  it('opens each Shopping screen', () => {
    const root = render(<SettingsScreen />);
    click(button(root, /^Siri adds to/));
    click(button(root, /^Aisle colours/));
    click(button(root, /^Sync status/));
    expect(mockPush.mock.calls).toEqual([['/settings/siri'], ['/settings/aisle-colors'], ['/settings/sync']]);
  });

  it('has a Notifications row after Siri adds to, opening its screen (spec 4.13)', () => {
    const root = render(<SettingsScreen />);
    const labels = buttons(root).map((b) => b.props.accessibilityLabel as string);
    const siri = labels.findIndex((l) => l.startsWith('Siri adds to'));
    expect(labels[siri + 1]).toBe('Notifications');
    expect(labels.indexOf('Notifications')).toBeLessThan(labels.findIndex((l) => l.startsWith('Aisle colours')));
    click(button(root, 'Notifications'));
    expect(mockPush).toHaveBeenCalledWith('/settings/notifications');
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

  it('Meal plan > Plan tab is a switch, off by default, with its footnote, that turns the device setting on and off', () => {
    const root = render(<SettingsScreen />);
    expect(headers(root)).toContain('Meal plan');
    expect(textOf(root)).toContain('Plan tab Your week plan gets its own tab. Off, it lives in Recipes under This week.');
    const toggle = () => root.root.find((n) => n.type === Switch && n.props.accessibilityLabel === 'Plan tab');
    expect(toggle().props.value).toBe(false);
    act(() => toggle().props.onValueChange(true));
    expect(getPlanTab()).toBe(true);
    expect(getDeviceSetting(PLAN_TAB_KEY, null)).toBe(true);
    expect(toggle().props.value).toBe(true);
    act(() => toggle().props.onValueChange(false));
    expect(getPlanTab()).toBe(false);
    expect(toggle().props.value).toBe(false);
  });

  it('Plan tab shows on when it was turned on before, and follows a change made elsewhere', () => {
    setPlanTab(true);
    const root = render(<SettingsScreen />);
    const toggle = () => root.root.find((n) => n.type === Switch && n.props.accessibilityLabel === 'Plan tab');
    expect(toggle().props.value).toBe(true);
    act(() => setPlanTab(false));
    expect(toggle().props.value).toBe(false);
  });

  describe('Meal plan > Grid cells', () => {
    const control = (root: ReactTestRenderer) => {
      const found = labelled(root, 'Grid cell style');
      expect(found).toHaveLength(1);
      expect(found[0].props.accessibilityRole).toBe('tablist');
      return found[0];
    };
    const segments = (root: ReactTestRenderer) =>
      control(root).findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'tab');
    const states = (root: ReactTestRenderer) =>
      segments(root).map((s) => [s.props.accessibilityLabel, s.props.accessibilityState.selected]);

    it('follows Plan tab as the last row of Meal plan, Split photo selected until Stacked is picked', () => {
      const root = render(<SettingsScreen />);
      expect(textOf(root)).toContain(
        'Meal plan Plan tab Your week plan gets its own tab. Off, it lives in Recipes under This week. Grid cells Split photo Stacked General',
      );
      expect(states(root)).toEqual([
        ['Split photo', true],
        ['Stacked', false],
      ]);
      expect(getDeviceSetting(PLAN_CELL_STYLE_KEY, null)).toBeNull();
    });

    it('saves plan.cellStyle and selects the picked style', () => {
      const root = render(<SettingsScreen />);
      click(segments(root)[1]);
      expect(getDeviceSetting(PLAN_CELL_STYLE_KEY, null)).toBe('stacked');
      expect(getPlanCellStyle()).toBe('stacked');
      expect(states(root)).toEqual([
        ['Split photo', false],
        ['Stacked', true],
      ]);
      click(segments(root)[0]);
      expect(getDeviceSetting(PLAN_CELL_STYLE_KEY, null)).toBe('split');
      expect(getPlanCellStyle()).toBe('split');
      expect(states(root)[0]).toEqual(['Split photo', true]);
    });

    it('shows a style saved before, and follows a change made elsewhere', () => {
      setPlanCellStyle('stacked');
      const root = render(<SettingsScreen />);
      expect(states(root).find(([, selected]) => selected)?.[0]).toBe('Stacked');
      act(() => setPlanCellStyle('split'));
      expect(states(root).find(([, selected]) => selected)?.[0]).toBe('Split photo');
    });

    it('an unknown saved value shows Split photo', () => {
      setDeviceSetting(PLAN_CELL_STYLE_KEY, 'mosaic');
      const root = render(<SettingsScreen />);
      expect(states(root)).toEqual([
        ['Split photo', true],
        ['Stacked', false],
      ]);
    });

    it('in Spanish', () => {
      initI18n('es');
      try {
        const root = render(<SettingsScreen />);
        expect(labelled(root, 'Estilo de las celdas de la cuadrícula')).toHaveLength(1);
        expect(textOf(root)).toContain('Celdas de la cuadrícula Foto dividida Apiladas');
      } finally {
        initI18n('en');
      }
    });
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

  describe('Design trials', () => {
    it('comes after General and before Developer, with a Fonts row showing the current set', () => {
      const root = render(<SettingsScreen />);
      const all = headers(root);
      expect(all.indexOf('Design trials')).toBe(all.indexOf('General') + 1);
      expect(all.indexOf('Developer')).toBe(all.indexOf('Design trials') + 1);
      expect(textOf(root)).toContain('Design trials Fonts Bricolage Grotesque');
      click(button(root, 'Fonts, Bricolage Grotesque'));
      expect(mockPush).toHaveBeenCalledWith('/font-sets');
    });

    it('shows a set picked before, and follows a switch at once', () => {
      setFontSetSetting('youngSerif');
      const root = render(<SettingsScreen />);
      button(root, 'Fonts, Young Serif');
      act(() => setFontSetSetting('jakarta'));
      button(root, 'Fonts, Plus Jakarta Sans');
    });

    it("re-renders Settings' own text in the new fonts", () => {
      const root = render(<SettingsScreen />);
      const familyOf = (text: string) =>
        StyleSheet.flatten(root.root.find((n) => n.type === Text && n.props.children === text).props.style).fontFamily;
      expect(familyOf('Design trials')).toBe('Figtree');
      act(() => setFontSetSetting('nunito'));
      expect(familyOf('Design trials')).toBe('Nunito Sans');
    });

    it('has no Plan grid row: Fonts, then Recipe view, even with a plan.gridStyle saved', () => {
      deviceSettings.setDeviceSetting('plan.gridStyle', 'photo');
      const root = render(<SettingsScreen />);
      expect(textOf(root)).toContain('Design trials Fonts Bricolage Grotesque Recipe view Standard Title on photo Cook view Cards Sheet');
      expect(textOf(root)).not.toContain('Plan grid');
      expect(labelled(root, 'Plan grid style')).toHaveLength(0);
      // Meal plan's Grid cells and Design trials' Recipe view and Cook view are the screen's only segmented controls.
      expect(
        root.root
          .findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'tablist')
          .map((n) => n.props.accessibilityLabel),
      ).toEqual(['Grid cell style', 'Recipe view style', 'Cook view style']);
    });

    describe('Cook view', () => {
      const segments = (root: ReactTestRenderer) => {
        const found = labelled(root, 'Cook view style');
        expect(found).toHaveLength(1);
        return found[0].findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'tab');
      };
      const states = (root: ReactTestRenderer) =>
        segments(root).map((s) => [s.props.accessibilityLabel, s.props.accessibilityState.selected]);

      it('follows Recipe view, Cards selected until Sheet is picked, and saves cook.viewStyle', () => {
        const root = render(<SettingsScreen />);
        expect(textOf(root)).toContain('Title on photo Cook view Cards Sheet');
        expect(states(root)).toEqual([
          ['Cards', true],
          ['Sheet', false],
        ]);
        expect(deviceSettings.getDeviceSetting(COOK_VIEW_STYLE_KEY, null)).toBeNull();
        click(segments(root)[1]);
        expect(deviceSettings.getDeviceSetting(COOK_VIEW_STYLE_KEY, null)).toBe('sheet');
        expect(getCookViewStyle()).toBe('sheet');
        expect(states(root)[1]).toEqual(['Sheet', true]);
        act(() => setCookViewStyle('cards'));
        expect(states(root)[0]).toEqual(['Cards', true]);
      });
    });

    describe('Recipe view', () => {
      const control = (root: ReactTestRenderer) => {
        const found = labelled(root, 'Recipe view style');
        expect(found).toHaveLength(1);
        expect(found[0].props.accessibilityRole).toBe('tablist');
        return found[0];
      };
      const segments = (root: ReactTestRenderer) =>
        control(root).findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'tab');
      const states = (root: ReactTestRenderer) =>
        segments(root).map((s) => [s.props.accessibilityLabel, s.props.accessibilityState.selected]);

      it('follows Fonts, Standard selected until Title on photo is picked', () => {
        const root = render(<SettingsScreen />);
        expect(textOf(root)).toContain('Fonts Bricolage Grotesque Recipe view Standard Title on photo');
        expect(states(root)).toEqual([
          ['Standard', true],
          ['Title on photo', false],
        ]);
        expect(deviceSettings.getDeviceSetting(RECIPE_VIEW_STYLE_KEY, null)).toBeNull();
      });

      it('saves recipe.viewStyle and selects the picked style', () => {
        const root = render(<SettingsScreen />);
        click(segments(root)[1]);
        expect(deviceSettings.getDeviceSetting(RECIPE_VIEW_STYLE_KEY, null)).toBe('titleOnPhoto');
        expect(getRecipeViewStyle()).toBe('titleOnPhoto');
        expect(states(root)).toEqual([
          ['Standard', false],
          ['Title on photo', true],
        ]);
        click(segments(root)[0]);
        expect(deviceSettings.getDeviceSetting(RECIPE_VIEW_STYLE_KEY, null)).toBe('standard');
        expect(getRecipeViewStyle()).toBe('standard');
      });

      it('shows a style saved before, and follows a change made elsewhere', () => {
        setRecipeViewStyle('titleOnPhoto');
        const root = render(<SettingsScreen />);
        expect(states(root).find(([, selected]) => selected)?.[0]).toBe('Title on photo');
        act(() => setRecipeViewStyle('standard'));
        expect(states(root).find(([, selected]) => selected)?.[0]).toBe('Standard');
      });

      it('an unknown saved value shows Standard', () => {
        deviceSettings.setDeviceSetting(RECIPE_VIEW_STYLE_KEY, 'magazine');
        const root = render(<SettingsScreen />);
        expect(states(root)[0]).toEqual(['Standard', true]);
      });

      it('in Spanish', () => {
        initI18n('es');
        try {
          const root = render(<SettingsScreen />);
          expect(labelled(root, 'Estilo de la vista de receta')).toHaveLength(1);
          expect(textOf(root)).toContain('Vista de receta Estándar Título en la foto');
        } finally {
          initI18n('en');
        }
      });
    });
  });

  describe('Households', () => {
    it('comes first, under the account card: one row per household with its counts and no switches', () => {
      db.insert(households).values({ id: 'h-cabin', name: 'Cabin', combineLanguages: true }).run();
      const root = render(<SettingsScreen />);
      expect(headers(root)[0]).toBe('Households');
      expect(textOf(root)).toContain(
        'Households Personal 1 list · 0 recipes Cabin 0 lists · 0 recipes Members, invites, Always have, aisle order and name matching are in each household. Shopping',
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

describe('Fonts (Design trials)', () => {
  const SAMPLE = '· Chicken tacos with lime crema';
  const rows = (root: ReactTestRenderer) => buttons(root).filter((b) => b.props.accessibilityLabel.includes(SAMPLE));
  const ticked = (root: ReactTestRenderer) =>
    rows(root)
      .filter((b) => b.props.accessibilityState?.selected)
      .map((b) => b.props.accessibilityLabel);
  const styleOf = (root: ReactTestRenderer, text: string) =>
    StyleSheet.flatten(root.root.find((n) => n.type === Text && n.props.children === text).props.style);

  it('the setting is bricolage until another set is saved, and bricolage for anything unknown', () => {
    expect(getFontSetSetting()).toBe('bricolage');
    setDeviceSetting(FONT_SET_KEY, 'fraunces');
    expect(getFontSetSetting()).toBe('fraunces');
    setDeviceSetting(FONT_SET_KEY, 'Comic Sans');
    expect(getFontSetSetting()).toBe('bricolage');
    setDeviceSetting(FONT_SET_KEY, 7);
    expect(getFontSetSetting()).toBe('bricolage');
  });

  it('saving a set puts it in use', () => {
    setFontSetSetting('jakarta');
    expect(getDeviceSetting(FONT_SET_KEY, null)).toBe('jakarta');
    expect(getFontSet()).toBe('jakarta');
  });

  it('loadFontSet puts the saved set in use at startup', () => {
    setDeviceSetting(FONT_SET_KEY, 'nunito');
    expect(getFontSet()).toBe('bricolage');
    loadFontSet();
    expect(getFontSet()).toBe('nunito');
  });

  it('loadFontSet falls back to bricolage when the settings table is not there yet', () => {
    // A set saved and in use, so only the failed read can bring it back to bricolage.
    setFontSetSetting('nunito');
    const read = jest.spyOn(deviceSettings, 'getDeviceSetting').mockImplementation(() => {
      throw new Error('no such table: device_settings');
    });
    expect(() => loadFontSet()).not.toThrow();
    expect(read).toHaveBeenCalledWith(FONT_SET_KEY, null);
    expect(getFontSet()).toBe('bricolage');
  });

  it('lists the five sets, each named in its display face over a sample in its body face, bricolage ticked', () => {
    const root = render(<FontSetsSheet />);
    expect(headers(root)).toEqual(['Fonts']);
    expect(rows(root).map((b) => b.props.accessibilityLabel)).toEqual([
      `Bricolage Grotesque, Figtree ${SAMPLE}`,
      `Fraunces, Figtree ${SAMPLE}`,
      `Young Serif, Instrument Sans ${SAMPLE}`,
      `Plus Jakarta Sans, Plus Jakarta Sans ${SAMPLE}`,
      `Nunito, Nunito Sans ${SAMPLE}`,
    ]);
    expect(ticked(root)).toEqual([`Bricolage Grotesque, Figtree ${SAMPLE}`]);
    expect(styleOf(root, 'Fraunces')).toMatchObject({ fontFamily: 'Fraunces', fontWeight: '700' });
    expect(styleOf(root, 'Young Serif')).toMatchObject({ fontFamily: 'Young Serif', fontWeight: '400' });
    expect(styleOf(root, 'Nunito')).toMatchObject({ fontFamily: 'Nunito', fontWeight: '900' });
    expect(styleOf(root, `Instrument Sans ${SAMPLE}`)).toMatchObject({ fontFamily: 'Instrument Sans', fontWeight: '400' });
    expect(styleOf(root, `Nunito Sans ${SAMPLE}`)).toMatchObject({ fontFamily: 'Nunito Sans' });
    expect(textOf(root)).toContain('Only this device changes. Every screen switches at once.');
  });

  it('picking a set saves it, switches the fonts at once and moves the tick, keeping the sheet open', () => {
    const root = render(<FontSetsSheet />);
    click(button(root, `Young Serif, Instrument Sans ${SAMPLE}`));
    expect(getDeviceSetting(FONT_SET_KEY, null)).toBe('youngSerif');
    expect(getFontSet()).toBe('youngSerif');
    expect(ticked(root)).toEqual([`Young Serif, Instrument Sans ${SAMPLE}`]);
    // The sheet's own title is now in the new display face.
    expect(styleOf(root, 'Fonts')).toMatchObject({ fontFamily: 'Young Serif', fontWeight: '400', fontSize: 30 });
    click(button(root, `Bricolage Grotesque, Figtree ${SAMPLE}`));
    expect(getDeviceSetting(FONT_SET_KEY, null)).toBe('bricolage');
    expect(ticked(root)).toEqual([`Bricolage Grotesque, Figtree ${SAMPLE}`]);
    expect(styleOf(root, 'Fonts')).toMatchObject({ fontFamily: 'Bricolage Grotesque', fontWeight: '800' });
  });

  it('ticks a set picked before', () => {
    setFontSetSetting('nunito');
    const root = render(<FontSetsSheet />);
    expect(ticked(root)).toEqual([`Nunito, Nunito Sans ${SAMPLE}`]);
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
    expect(labelled(root, "1 change couldn't be applied")).toHaveLength(0);
  });

  it("counts server changes that couldn't be applied", () => {
    mockSync.status = { ...synced, quarantined: 1 };
    expect(labelled(render(<SyncStatusScreen />), "1 change couldn't be applied")).toHaveLength(1);
    act(() => tree?.unmount());
    mockSync.status = { ...synced, quarantined: 4 };
    expect(labelled(render(<SyncStatusScreen />), "4 changes couldn't be applied")).toHaveLength(1);
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

  it('Show the + hint again clears the seen flag, sets the count to 3, and says so', () => {
    setDeviceSetting(ADD_HINT_SEEN_KEY, true);
    setDeviceSetting(ADD_TAP_COUNT_KEY, 1);
    const root = render(<DeveloperScreen />);
    expect(textOf(root)).not.toContain('The + hint will show after your next add');
    click(button(root, 'Show the + hint again'));
    expect(getDeviceSetting(ADD_HINT_SEEN_KEY, 'unset')).toBe('unset');
    expect(getDeviceSetting(ADD_TAP_COUNT_KEY, 0)).toBe(3);
    expect(textOf(root)).toContain('The + hint will show after your next add');
  });
});
