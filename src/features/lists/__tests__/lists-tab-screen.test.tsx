// The List tab (spec 4.1, board E): the current list itself (last opened on this device, else the
// Siri default, else the first open list), switching when another screen picks one, moving on when it
// is deleted or archived, and the empty state with New list and the Your lists button.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Alert } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import ListTab from '@/app/(tabs)/lists/index';
import type { MyInvite } from '@/features/households/invites';
import { resetDb } from '@/test/db';

import { setCurrentList } from '../current-list';
import {
  createList,
  deleteList,
  ensureStarterData,
  getDefaultListId,
  listsWithCountsQuery,
  setDefaultList,
  setLastOpenedList,
  setListArchived,
} from '../lists';

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
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));
// Remembering the list is real (a device setting); the Siri snapshot write is not.
jest.mock('@/features/siri/list-snapshot', () => ({
  recordListOpened: (listId: string) => require('@/features/lists/lists').setLastOpenedList(listId),
}));
// The list itself has its own tests; here it's a marker carrying its id.
jest.mock('@/features/lists/list-screen', () => {
  const { createElement } = require('react');
  return { ListScreen: (props: object) => createElement('ListScreen', props) };
});
const mockInvites: { current: MyInvite[] } = { current: [] };
jest.mock('@/features/households/my-invites', () => ({ useMyInvites: () => mockInvites.current }));
// The cards themselves have their own tests (invite-cards.test.tsx); here, a marker with the invites.
jest.mock('@/features/households/invite-cards', () => {
  const { createElement } = require('react');
  return { InviteWelcome: (props: object) => createElement('InviteWelcome', props) };
});

const mockPush = jest.fn();
const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({
  router: {
    push: (...args: unknown[]) => mockPush(...args),
    navigate: (...args: unknown[]) => mockNavigate(...args),
    back: jest.fn(),
  },
}));

const USER = 'user-1';
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));

let groceries: string;
let tree: ReactTestRenderer | null = null;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  groceries = getDefaultListId(USER)!;
  mockInvites.current = [];
  mockPush.mockClear();
  mockNavigate.mockClear();
});

afterEach(() => {
  const shown = tree;
  tree = null;
  act(() => shown?.unmount());
  jest.restoreAllMocks();
});

function render() {
  act(() => {
    tree = create(<ListTab />);
  });
}
/** Re-renders, as the live query would after a write. */
const refresh = () => act(() => tree!.update(<ListTab />));

const textOf = (n: ReactTestInstance): string =>
  n.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
const lines = () => tree!.root.findAll((n) => n.type === ('Text' as never)).map(textOf);
/** The id of the list on screen, or null for the empty state. */
const shown = () => {
  const screens = tree!.root.findAll((n) => n.type === ('ListScreen' as never));
  expect(screens.length).toBeLessThanOrEqual(1);
  return screens[0]?.props.id ?? null;
};
const pressable = (label: string) =>
  tree!.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && 'onPress' in n.props);
const hasPressable = (label: string) =>
  tree!.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && 'onPress' in n.props).length > 0;
const press = (n: ReactTestInstance) =>
  act(() => {
    n.props.onPress();
  });
const listIdByName = (name: string) => listsWithCountsQuery().all().find((l) => l.name === name)!.id;
/** Answers the next name prompt with `name`. */
const answerPrompt = (name: string) =>
  jest.spyOn(Alert, 'prompt').mockImplementation((_title, _message, buttons) => {
    (buttons as { text: string; onPress?: (v: string) => void }[]).find((b) => b.text === 'Create')!.onPress!(name);
  });

describe('which list the tab shows', () => {
  test('with nothing opened yet, the Siri default list', () => {
    const costco = createList('Costco');
    setDefaultList(USER, costco);
    render();
    expect(shown()).toBe(costco);
  });

  test('the list last opened on this device wins over the default', () => {
    const costco = createList('Costco');
    setLastOpenedList(costco);
    render();
    expect(shown()).toBe(costco);
  });

  test('an archived last-opened list falls back to the default, and an archived default to the first', () => {
    const costco = createList('Costco');
    const target = createList('Target');
    setLastOpenedList(target);
    setDefaultList(USER, costco);
    setListArchived(target, true);
    render();
    expect(shown()).toBe(costco);
    setListArchived(costco, true);
    refresh();
    expect(shown()).toBe(groceries);
  });

  test('picking a list elsewhere switches to it without a re-render from the data', () => {
    const costco = createList('Costco');
    render();
    expect(shown()).toBe(groceries);
    act(() => setCurrentList(costco));
    expect(shown()).toBe(costco);
    act(() => setCurrentList(groceries));
    expect(shown()).toBe(groceries);
  });

  test('a new list screen per list, so its state starts afresh', () => {
    const costco = createList('Costco');
    render();
    const first = tree!.root.find((n) => n.type === ('ListScreen' as never));
    act(() => setCurrentList(costco));
    const second = tree!.root.find((n) => n.type === ('ListScreen' as never));
    expect(second).not.toBe(first);
  });

  test('deleting the current list moves on to the next one', () => {
    const costco = createList('Costco');
    setLastOpenedList(costco);
    render();
    expect(shown()).toBe(costco);
    act(() => deleteList(costco));
    refresh();
    expect(shown()).toBe(groceries);
  });

  test('archiving the current list moves on too', () => {
    const costco = createList('Costco');
    render();
    act(() => setCurrentList(costco));
    act(() => setListArchived(costco, true));
    refresh();
    expect(shown()).toBe(groceries);
  });
});

describe('with no open lists', () => {
  test('"No lists yet." and New list, without the Your lists button when there is nothing else', () => {
    deleteList(groceries);
    render();
    expect(shown()).toBeNull();
    expect(lines()).toContain('No lists yet.');
    expect(hasPressable('Your lists')).toBe(false);
  });

  test('New list asks for a name, makes it current and shows it', () => {
    deleteList(groceries);
    const prompt = answerPrompt('Costco');
    render();
    press(pressable('New list'));
    expect(prompt.mock.calls[0][0]).toBe('New list');
    const costco = listIdByName('Costco');
    expect(mockNavigate).toHaveBeenCalledWith('/lists');
    refresh();
    expect(shown()).toBe(costco);
  });

  test('a blank name makes nothing', () => {
    deleteList(groceries);
    answerPrompt('  ');
    render();
    press(pressable('New list'));
    expect(listsWithCountsQuery().all()).toHaveLength(0);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  test('with only archived lists, "Your lists" opens the sheet', () => {
    setListArchived(groceries, true);
    render();
    expect(lines()).toContain('No lists yet.');
    press(pressable('Your lists'));
    expect(mockPush).toHaveBeenCalledWith('/lists-sheet');
  });

  const invite = (i: number): MyInvite => ({
    id: `inv${i}`,
    householdId: `h${i}`,
    householdName: 'Beach house',
    invitedBy: 'Sam',
    memberCount: 3,
  });

  test('with invites waiting, the invite cards instead of "No lists yet."', () => {
    deleteList(groceries);
    mockInvites.current = [invite(0), invite(1)];
    render();
    const welcome = tree!.root.findAll((n) => n.type === ('InviteWelcome' as never));
    expect(welcome).toHaveLength(1);
    expect(welcome[0].props.invites).toEqual(mockInvites.current);
    expect(lines()).not.toContain('No lists yet.');
    expect(hasPressable('New list')).toBe(false);
    expect(welcome[0].props.footer).toBeNull();
  });

  test('with invites waiting and archived lists, the cards carry the Your lists button', () => {
    setListArchived(groceries, true);
    mockInvites.current = [invite(0)];
    render();
    const welcome = tree!.root.find((n) => n.type === ('InviteWelcome' as never));
    expect(welcome.props.footer).not.toBeNull();
  });
});
