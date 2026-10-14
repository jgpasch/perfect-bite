// The Your lists sheet (spec 4.1, 4.7, boards G and H): invites first, then a row per list with its
// count, Siri mark and the current one ticked; tapping switches and closes. New list, Edit to reorder,
// households, archived lists, and each row's long-press actions.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ActionSheetIOS, Alert } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import ListsSheet from '@/app/lists-sheet';
import { db, households, lists, userSettings } from '@/db';
import type { MyInvite } from '@/features/households/invites';
import { getDeviceSetting } from '@/features/settings/device-settings';
import { initI18n } from '@/i18n';
import { resetDb } from '@/test/db';

import { addItem, setItemChecked } from '../items';
import {
  createList,
  deleteList,
  ensureStarterData,
  getDefaultListId,
  getList,
  LAST_OPENED_LIST_KEY,
  listsWithCountsQuery,
  setLastOpenedList,
  setListArchived,
} from '../lists';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => {
  const { createElement } = require('react');
  return { Icon: (props: object) => createElement('Icon', props) };
});
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
jest.mock('react-native-safe-area-context', () => {
  const { createElement } = require('react');
  return {
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('SafeAreaView', null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));
// Remembering the list is real (a device setting); the Siri snapshot write is not.
jest.mock('@/features/siri/list-snapshot', () => ({
  recordListOpened: (listId: string) => require('@/features/lists/lists').setLastOpenedList(listId),
}));
jest.mock('@expo/ui/swift-ui', () => {
  const { createElement } = require('react');
  const host = (type: string) =>
    function Host({ children, ...props }: { children?: unknown }) {
      return createElement(type, props, children);
    };
  return {
    Host: host('SwiftHost'),
    List: Object.assign(host('SwiftList'), { ForEach: host('SwiftForEach') }),
    Section: host('SwiftSection'),
    Text: host('SwiftText'),
  };
});
jest.mock('@expo/ui/swift-ui/modifiers', () => ({
  deleteDisabled: () => ({ deleteDisabled: true }),
  environment: (key: string, value: unknown) => ({ environment: [key, value] }),
}));
// Invites: a scripted store, with join and decline as mocks. The row itself is tested with the
// household screens; here it's a marker carrying its props.
const mockInvites: { current: MyInvite[] } = { current: [] };
const mockJoin = jest.fn<(invite: MyInvite) => Promise<{ ok: true } | { ok: false; message: string }>>();
const mockDecline = jest.fn<(invite: MyInvite) => Promise<{ ok: true } | { ok: false; message: string }>>();
jest.mock('@/features/households/my-invites', () => ({
  useMyInvites: () => mockInvites.current,
  joinMyInvite: (invite: MyInvite) => mockJoin(invite),
  declineMyInvite: (invite: MyInvite) => mockDecline(invite),
  declineInvitePrompt: (invite: MyInvite) => ({ title: `Decline ${invite.householdName}?`, message: 'They can send a new one.' }),
}));
jest.mock('@/features/households/invite-row', () => {
  const { createElement } = require('react');
  return { InviteRow: (props: object) => createElement('InviteRow', props) };
});

const mockBack = jest.fn();
jest.mock('expo-router', () => {
  const { createElement, Fragment } = require('react');
  const passThrough = () =>
    function PassThrough({ children }: { children?: unknown }) {
      return createElement(Fragment, null, children);
    };
  const host = (type: string) =>
    function Host({ children, ...props }: { children?: unknown }) {
      return createElement(type, props, children);
    };
  const Toolbar = Object.assign(passThrough(), {
    Button: host('ToolbarButton'),
    Menu: host('ToolbarMenu'),
    MenuAction: host('ToolbarMenuAction'),
  });
  return {
    Stack: { Toolbar },
    router: { back: () => mockBack(), push: jest.fn(), navigate: jest.fn() },
  };
});

const USER = 'user-1';
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));

type Button = { text: string; onPress?: (value?: string) => void };

let groceries: string;
let tree: ReactTestRenderer | null = null;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  groceries = getDefaultListId(USER)!;
  mockInvites.current = [];
  mockBack.mockClear();
  mockJoin.mockReset();
  mockDecline.mockReset();
});

afterEach(() => {
  const shown = tree;
  tree = null;
  act(() => shown?.unmount());
  jest.restoreAllMocks();
});

function render() {
  act(() => {
    tree = create(<ListsSheet />);
  });
}
/** Re-renders, as the live query would after a write. */
const refresh = () => act(() => tree!.update(<ListsSheet />));

const textOf = (n: ReactTestInstance): string =>
  n.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
const lines = () => tree!.root.findAll((n) => n.type === ('Text' as never)).map(textOf);
const all = (type: string, root: ReactTestInstance = tree!.root) => root.findAll((n) => n.type === (type as never));
/** Composite (Pressable) elements with an onPress, outermost first. */
const pressables = () => tree!.root.findAll((n) => typeof n.type !== 'string' && 'onPress' in n.props);
/** Each list row (they carry `selected`), outermost element per row, in order. */
const rowNodes = () => {
  const seen = new Set<string>();
  return pressables().filter((n) => {
    const label = n.props.accessibilityLabel as string | undefined;
    if (!label || n.props.accessibilityState?.selected === undefined || seen.has(label)) return false;
    seen.add(label);
    return true;
  });
};
const rows = () => rowNodes().map((n) => n.props.accessibilityLabel as string);
const row = (name: string) => rowNodes().find((n) => (n.props.accessibilityLabel as string).startsWith(`${name},`))!;
const pressable = (label: string) => pressables().find((n) => n.props.accessibilityLabel === label)!;
const icons = (n: ReactTestInstance) => all('Icon', n).map((i) => i.props.name);
const toolbarButton = (match: string) =>
  all('ToolbarButton').find((b) => b.props.children === match || b.props.accessibilityLabel === match);
const press = (n: ReactTestInstance) =>
  act(() => {
    n.props.onPress();
  });
const listIdByName = (name: string) => listsWithCountsQuery().all().find((l) => l.name === name)!.id;
const lastOpened = () => getDeviceSetting<string | null>(LAST_OPENED_LIST_KEY, null);
/** Answers the next name prompt's `button` with `name`. */
const answerPrompt = (button: 'Create' | 'Save', name: string) =>
  jest.spyOn(Alert, 'prompt').mockImplementation((_title, _message, buttons) => {
    (buttons as Button[]).find((b) => b.text === button)!.onPress!(name);
  });
/** Records the action sheet; returns its calls. */
const spySheet = () => jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
/** Records alerts and returns the buttons of the last one. */
const spyAlert = () => {
  const box: { buttons: Button[] } = { buttons: [] };
  const spy = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, b) => {
    box.buttons = b as Button[];
  });
  return {
    spy,
    buttons: () => box.buttons.map((b) => b.text),
    tap: (text: string) => box.buttons.find((b) => b.text === text)!.onPress!(),
  };
};

describe('the rows', () => {
  test('a row per list with its count, the Siri default marked, the current one ticked', () => {
    addItem(groceries, 'milk', USER);
    addItem(groceries, 'eggs', USER);
    const costco = createList('Costco');
    const done = addItem(costco, 'rice', USER)!;
    setItemChecked(done.itemId, true, USER);
    render();
    expect(lines()[0]).toBe('Your lists');
    expect(rows()).toEqual(['Groceries, 2 items to get, Siri list, current', 'Costco, all done']);
    expect(lines()).toEqual(expect.arrayContaining(['Groceries', '2', 'Costco', 'Done']));
    expect(row('Groceries').props.accessibilityState).toEqual({ selected: true });
    expect(row('Costco').props.accessibilityState).toEqual({ selected: false });
    expect(icons(row('Groceries'))).toEqual(['mic.fill', 'checkmark']);
    expect(icons(row('Costco'))).toEqual([]);
  });

  test('the list last opened on this device is the ticked one', () => {
    const costco = createList('Costco');
    setLastOpenedList(costco);
    render();
    expect(rows()).toEqual(['Groceries, all done, Siri list', 'Costco, all done, current']);
    expect(icons(row('Costco'))).toEqual(['checkmark']);
  });

  test('an emoji shows before the name', () => {
    db.update(lists).set({ emoji: '🛒' }).run();
    render();
    expect(lines()).toContain('🛒 Groceries');
  });

  test('tapping a list makes it current and closes the sheet', () => {
    const costco = createList('Costco');
    render();
    press(row('Costco'));
    expect(lastOpened()).toBe(costco);
    expect(mockBack).toHaveBeenCalledTimes(1);
    // The tick follows at once.
    expect(rows()).toEqual(['Groceries, all done, Siri list', 'Costco, all done, current']);
  });
});

describe('New list', () => {
  test('one household: the toolbar + asks for a name, makes it current and closes', () => {
    const prompt = answerPrompt('Create', 'Costco');
    render();
    expect(all('ToolbarMenu')).toHaveLength(0);
    press(toolbarButton('New list')!);
    expect(prompt.mock.calls[0][0]).toBe('New list');
    const costco = listIdByName('Costco');
    expect(getList(costco)!.householdId).toBe(getList(groceries)!.householdId);
    expect(lastOpened()).toBe(costco);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('a blank name makes nothing and stays open', () => {
    answerPrompt('Create', '  ');
    render();
    press(toolbarButton('New list')!);
    expect(listsWithCountsQuery().all()).toHaveLength(1);
    expect(mockBack).not.toHaveBeenCalled();
  });
});

describe('Edit', () => {
  test('shows with two or more lists and switches to drag-to-reorder', () => {
    render();
    expect(toolbarButton('Edit')).toBeUndefined();
    act(() => tree!.unmount());
    createList('Costco');
    render();
    const edit = () => toolbarButton('Edit') ?? toolbarButton('Done')!;
    press(edit());
    expect(all('SwiftText').map((t) => t.props.children)).toEqual(['Groceries', 'Costco']);
    expect(all('SwiftList')[0].props.modifiers).toEqual([{ environment: ['editMode', 'active'] }]);
    expect(toolbarButton('New list')!.props.hidden).toBe(true);
    expect(rows()).toEqual([]);
    // Drag Costco above Groceries.
    act(() => all('SwiftForEach')[0].props.onMove([1], 0));
    expect(listsWithCountsQuery().all().map((l) => l.name)).toEqual(['Costco', 'Groceries']);
    refresh();
    // Drag it back down: SwiftUI's destination is the index to insert before.
    act(() => all('SwiftForEach')[0].props.onMove([0], 2));
    expect(listsWithCountsQuery().all().map((l) => l.name)).toEqual(['Groceries', 'Costco']);
    expect(edit().props.children).toBe('Done');
    press(edit());
    expect(all('SwiftList')).toHaveLength(0);
    expect(toolbarButton('New list')!.props.hidden).toBe(false);
  });

  test('archived lists are left out of reordering', () => {
    const costco = createList('Costco');
    createList('Target');
    setListArchived(costco, true);
    render();
    press(toolbarButton('Edit')!);
    expect(all('SwiftText').map((t) => t.props.children)).toEqual(['Groceries', 'Target']);
  });
});

describe('several households', () => {
  beforeEach(() => {
    db.insert(households).values({ id: 'h-friends', name: 'Friends', createdAt: new Date('2100-01-01') }).run();
    db.insert(households).values({ id: 'h-zoo', name: 'Zoo', createdAt: new Date('2100-01-02') }).run();
    createList('Potluck', 'h-friends');
  });

  const groupHeaders = () =>
    tree!.root
      .findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'header')
      .map((h) => h.props.accessibilityLabel ?? textOf(h));

  test('a group per household, the first one first, and "No lists" for an empty one', () => {
    render();
    expect(groupHeaders()).toEqual(['Your lists', 'Personal', 'Friends', 'Zoo']);
    expect(rows()).toEqual(['Groceries, all done, Siri list, current', 'Potluck, all done']);
    expect(lines().filter((l) => l === 'No lists')).toHaveLength(1);
  });

  test('New list asks which household, then makes it there', () => {
    answerPrompt('Create', 'BBQ');
    render();
    expect(toolbarButton('New list')).toBeUndefined();
    const menu = all('ToolbarMenu')[0];
    expect(menu.props.title).toBe('New list in');
    expect(menu.props.accessibilityLabel).toBe('New list');
    expect(all('ToolbarMenuAction', menu).map((a) => a.props.children)).toEqual(['Personal', 'Friends', 'Zoo']);
    press(all('ToolbarMenuAction', menu).find((a) => a.props.children === 'Friends')!);
    const bbq = listIdByName('BBQ');
    expect(getList(bbq)!.householdId).toBe('h-friends');
    expect(lastOpened()).toBe(bbq);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  test('reordering keeps each household in its own section, skipping empty ones', () => {
    createList('Costco');
    render();
    press(toolbarButton('Edit')!);
    expect(all('SwiftSection').map((s) => s.props.title)).toEqual(['Personal', 'Friends']);
    expect(all('ToolbarMenu')[0].props.hidden).toBe(true);
  });
});

describe("a row's actions (long-press)", () => {
  test('Rename, Make default for Siri, Archive and Delete; the default list has no Make default', () => {
    createList('Costco');
    const sheet = spySheet();
    render();
    act(() => row('Costco').props.onLongPress());
    expect(sheet.mock.calls[0][0]).toEqual({
      title: 'Costco',
      options: ['Rename', 'Make default for Siri', 'Archive', 'Delete', 'Cancel'],
      destructiveButtonIndex: 3,
      cancelButtonIndex: 4,
    });
    act(() => row('Groceries').props.onLongPress());
    expect(sheet.mock.calls[1][0].options).toEqual(['Rename', 'Archive', 'Delete', 'Cancel']);
  });

  test('VoiceOver gets the same actions as a custom action', () => {
    createList('Costco');
    const sheet = spySheet();
    render();
    expect(row('Costco').props.accessibilityActions).toEqual([{ name: 'longpress', label: 'More actions' }]);
    act(() => row('Costco').props.onAccessibilityAction({ nativeEvent: { actionName: 'longpress' } }));
    expect(sheet.mock.calls[0][0].title).toBe('Costco');
  });

  test('Make default for Siri moves the mark, not the tick', () => {
    const costco = createList('Costco');
    // The list screen records itself when shown.
    setLastOpenedList(groceries);
    const sheet = spySheet();
    render();
    act(() => row('Costco').props.onLongPress());
    act(() => sheet.mock.calls[0][1](1));
    expect(db.select().from(userSettings).get()!.defaultListId).toBe(costco);
    refresh();
    expect(rows()).toEqual(['Groceries, all done, current', 'Costco, all done, Siri list']);
  });

  test('Rename asks for the new name', () => {
    const costco = createList('Costco');
    const prompt = answerPrompt('Save', "Sam's");
    const sheet = spySheet();
    render();
    act(() => row('Costco').props.onLongPress());
    act(() => sheet.mock.calls[0][1](0));
    expect(prompt.mock.calls[0][0]).toBe('Rename list');
    expect(prompt.mock.calls[0][4]).toBe('Costco');
    expect(getList(costco)!.name).toBe("Sam's");
  });

  test('Archive moves it under Archived lists', () => {
    const costco = createList('Costco');
    const sheet = spySheet();
    render();
    act(() => row('Costco').props.onLongPress());
    act(() => sheet.mock.calls[0][1](2));
    expect(getList(costco)!.archivedAt).not.toBeNull();
    refresh();
    expect(rows()).toEqual(['Groceries, all done, Siri list, current']);
    expect(lines()).toContain('Archived lists (1)');
  });

  test('Delete asks first', () => {
    const costco = createList('Costco');
    const sheet = spySheet();
    const alert = spyAlert();
    render();
    act(() => row('Costco').props.onLongPress());
    act(() => sheet.mock.calls[0][1](3));
    expect(alert.spy.mock.calls[0].slice(0, 2)).toEqual(['Delete “Costco”?', 'Its items are deleted too.']);
    expect(getList(costco)).toBeDefined();
    act(() => alert.tap('Delete'));
    expect(getList(costco)).toBeUndefined();
  });

  test('Cancel does nothing', () => {
    const costco = createList('Costco');
    const sheet = spySheet();
    const alert = spyAlert();
    render();
    act(() => row('Costco').props.onLongPress());
    act(() => sheet.mock.calls[0][1](4));
    expect(alert.spy).not.toHaveBeenCalled();
    expect(getList(costco)!.archivedAt).toBeNull();
  });
});

describe('archived lists', () => {
  test('hidden under "Archived lists (N)", which opens to show them faded', () => {
    const costco = createList('Costco');
    setListArchived(costco, true);
    render();
    expect(rows()).toEqual(['Groceries, all done, Siri list, current']);
    const header = pressable('Archived lists, 1');
    expect(header.props.accessibilityState).toEqual({ expanded: false });
    expect(lines()).toContain('Archived lists (1)');
    press(header);
    expect(pressable('Archived lists, 1').props.accessibilityState).toEqual({ expanded: true });
    expect(rows()).toEqual(['Groceries, all done, Siri list, current', 'Costco, all done, archived']);
    const archived = row('Costco');
    expect(archived.props.accessibilityHint).toBe('Unarchive or delete');
    expect(archived.props.onLongPress).toBeUndefined();
    expect(archived.props.accessibilityActions).toBeUndefined();
    press(pressable('Archived lists, 1'));
    expect(rows()).toEqual(['Groceries, all done, Siri list, current']);
  });

  test('no Archived header without archived lists', () => {
    render();
    expect(lines().some((l) => l.startsWith('Archived lists'))).toBe(false);
  });

  test('tapping one offers Unarchive and Delete, and does not switch to it', () => {
    const costco = createList('Costco');
    setListArchived(costco, true);
    const sheet = spySheet();
    const alert = spyAlert();
    render();
    press(pressable('Archived lists, 1'));
    press(row('Costco'));
    expect(mockBack).not.toHaveBeenCalled();
    expect(sheet.mock.calls[0][0]).toEqual({
      title: 'Costco',
      options: ['Unarchive', 'Delete', 'Cancel'],
      destructiveButtonIndex: 1,
      cancelButtonIndex: 2,
    });
    act(() => sheet.mock.calls[0][1](1));
    act(() => alert.tap('Delete'));
    expect(getList(costco)).toBeUndefined();
  });

  test('Unarchive brings it back', () => {
    const costco = createList('Costco');
    setListArchived(costco, true);
    const sheet = spySheet();
    render();
    press(pressable('Archived lists, 1'));
    press(row('Costco'));
    act(() => sheet.mock.calls[0][1](0));
    expect(getList(costco)!.archivedAt).toBeNull();
    refresh();
    expect(rows()).toEqual(['Groceries, all done, Siri list, current', 'Costco, all done']);
  });

  test('with only archived lists the sheet still shows them, and no Edit', () => {
    setListArchived(groceries, true);
    render();
    expect(rows()).toEqual([]);
    expect(toolbarButton('Edit')).toBeUndefined();
    press(pressable('Archived lists, 1'));
    expect(rows()).toEqual(['Groceries, all done, archived']);
  });
});

describe('invites', () => {
  const invite: MyInvite = { id: 'inv1', householdId: 'h9', householdName: 'Beach house', invitedBy: 'Sam', memberCount: 3 };
  const inviteRow = () => all('InviteRow')[0];

  test('a row per invite under "Invite", above the lists', () => {
    mockInvites.current = [invite, { ...invite, id: 'inv2', householdName: 'Cabin' }];
    render();
    expect(all('InviteRow').map((r) => r.props.invite.id)).toEqual(['inv1', 'inv2']);
    expect(inviteRow().props.busy).toBeNull();
    const ordered = lines();
    expect(ordered.indexOf('Invite')).toBeGreaterThan(ordered.indexOf('Your lists'));
    expect(ordered.indexOf('Invite')).toBeLessThan(ordered.indexOf('Groceries'));
  });

  test('no Invite group without invites', () => {
    render();
    expect(all('InviteRow')).toHaveLength(0);
    expect(lines()).not.toContain('Invite');
  });

  test('Join shows it busy until it settles', async () => {
    mockInvites.current = [invite, { ...invite, id: 'inv2' }];
    let settle!: (r: { ok: true }) => void;
    mockJoin.mockImplementation(() => new Promise((resolve) => (settle = resolve)));
    render();
    act(() => inviteRow().props.onJoin());
    expect(mockJoin).toHaveBeenCalledWith(invite);
    expect(all('InviteRow').map((r) => r.props.busy)).toEqual(['join', null]);
    await act(async () => settle({ ok: true }));
    expect(inviteRow().props.busy).toBeNull();
  });

  test('a failed join shows its message as a toast', async () => {
    mockInvites.current = [invite];
    mockJoin.mockResolvedValue({ ok: false, message: 'That invite has expired.' });
    render();
    await act(async () => inviteRow().props.onJoin());
    expect(lines()).toContain('That invite has expired.');
    expect(inviteRow().props.busy).toBeNull();
  });

  test('Decline asks first, then shows it busy until it settles', async () => {
    mockInvites.current = [invite];
    let settle!: (r: { ok: true }) => void;
    mockDecline.mockImplementation(() => new Promise((resolve) => (settle = resolve)));
    const alert = spyAlert();
    render();
    act(() => inviteRow().props.onDecline());
    expect(alert.spy.mock.calls[0].slice(0, 2)).toEqual(['Decline Beach house?', 'They can send a new one.']);
    expect(mockDecline).not.toHaveBeenCalled();
    act(() => alert.tap('Decline'));
    expect(mockDecline).toHaveBeenCalledWith(invite);
    expect(inviteRow().props.busy).toBe('decline');
    await act(async () => settle({ ok: true }));
    expect(inviteRow().props.busy).toBeNull();
  });

  test('cancelling the decline keeps the invite', () => {
    mockInvites.current = [invite];
    const alert = spyAlert();
    render();
    act(() => inviteRow().props.onDecline());
    // Cancel has no handler of its own: the alert just closes.
    expect(alert.buttons()).toEqual(['Cancel', 'Decline']);
    expect(mockDecline).not.toHaveBeenCalled();
    expect(inviteRow().props.busy).toBeNull();
  });

  test('a failed decline shows its message as a toast', async () => {
    mockInvites.current = [invite];
    mockDecline.mockResolvedValue({ ok: false, message: "Couldn't reach the server." });
    const alert = spyAlert();
    render();
    act(() => inviteRow().props.onDecline());
    await act(async () => alert.tap('Decline'));
    expect(lines()).toContain("Couldn't reach the server.");
  });

  test('with an invite and no lists, the invite still shows', () => {
    deleteList(groceries);
    mockInvites.current = [invite];
    render();
    expect(all('InviteRow')).toHaveLength(1);
    expect(rows()).toEqual([]);
  });
});

describe('Your lists in Spanish', () => {
  afterEach(() => {
    act(() => tree?.unmount());
    tree = null;
    initI18n('en');
  });

  test('the title, rows and toolbar', () => {
    addItem(groceries, 'leche', USER);
    createList('Costco');
    initI18n('es');
    render();
    expect(lines()[0]).toBe('Tus listas');
    expect(rows()).toEqual(['Groceries, 1 artículo por comprar, lista de Siri, actual', 'Costco, todo listo']);
    expect(lines()).toEqual(expect.arrayContaining(['1', 'Listo']));
    expect(toolbarButton('Nueva lista')).toBeDefined();
    expect(toolbarButton('Editar')).toBeDefined();
    expect(row('Costco').props.accessibilityActions).toEqual([{ name: 'longpress', label: 'Más acciones' }]);
  });

  test('a row’s actions, with Eliminar as the destructive one', () => {
    createList('Costco');
    const sheet = spySheet();
    initI18n('es');
    render();
    act(() => row('Costco').props.onLongPress());
    expect(sheet.mock.calls[0][0]).toEqual({
      title: 'Costco',
      options: ['Cambiar nombre', 'Hacer predeterminada para Siri', 'Archivar', 'Eliminar', 'Cancelar'],
      destructiveButtonIndex: 3,
      cancelButtonIndex: 4,
    });
    const alert = spyAlert();
    act(() => sheet.mock.calls[0][1](3));
    expect(alert.spy.mock.calls[0].slice(0, 2)).toEqual(['¿Eliminar “Costco”?', 'También se eliminan sus artículos.']);
    expect(alert.buttons()).toEqual(['Cancelar', 'Eliminar']);
  });

  test('New list asks in Spanish', () => {
    const prompt = jest.spyOn(Alert, 'prompt').mockImplementation(() => {});
    initI18n('es');
    render();
    press(toolbarButton('Nueva lista')!);
    expect(prompt.mock.calls[0][0]).toBe('Nueva lista');
    expect((prompt.mock.calls[0][2] as Button[]).map((b) => b.text)).toEqual(['Cancelar', 'Crear']);
  });

  test('archived lists, and several households', () => {
    const costco = createList('Costco');
    setListArchived(costco, true);
    initI18n('es');
    render();
    expect(lines()).toContain('Listas archivadas (1)');
    press(pressable('Listas archivadas, 1'));
    expect(row('Costco').props.accessibilityLabel).toBe('Costco, todo listo, archivada');
    expect(row('Costco').props.accessibilityHint).toBe('Desarchivar o eliminar');
    const sheet = spySheet();
    press(row('Costco'));
    expect(sheet.mock.calls[0][0].options).toEqual(['Desarchivar', 'Eliminar', 'Cancelar']);
    expect(sheet.mock.calls[0][0].destructiveButtonIndex).toBe(1);
  });
});
