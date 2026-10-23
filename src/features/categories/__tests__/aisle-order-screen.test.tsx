// Aisle order (spec 4.3.3, board 12): long-press and drag, or VoiceOver's Move up / Move down,
// reorders the aisles in a draft; the screen saves the household's order or the user's own with
// its button, and asks before dropping unsaved moves.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AccessibilityInfo, Alert, type AlertButton } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { db, householdCategoryOrder, households, userHouseholdCategoryOrder } from '@/db';
import { Sizes, Spacing } from '@/constants/theme';
import { initI18n } from '@/i18n';
import { SYSTEM_CATEGORIES } from '@/shared';
import { resetDb } from '@/test/db';
import { seedCatalog } from '@/test/seed';

import CategoryOrderScreen from '@/app/category-order';

import { AisleOrderList, type AisleOrderItem } from '../aisle-order-list';
import { createCategory, getAisleOrder, getOrderedCategories } from '../categories';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('@/db/live-query', () => ({
  useLiveQueryOn: (query: { all: () => unknown[] }) => ({ data: query.all(), error: undefined }),
}));
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'user-1' }) }));
jest.mock('react-native-worklets', () => ({ scheduleOnRN: (fn: (...a: unknown[]) => void, ...args: unknown[]) => fn(...args) }));

// Reanimated, run on the JS thread: shared values keep their value across renders, and animated
// reactions run when a test calls `mockFlushReactions` (the UI thread's frame, in effect).
type Reaction = { prepare: () => unknown; react: (next: unknown, previous: unknown) => void; previous: unknown };
const mockReactions = new Set<Reaction>();
function mockFlushReactions() {
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;
    for (const r of mockReactions) {
      const next = r.prepare();
      if (next !== r.previous) {
        const previous = r.previous;
        r.previous = next;
        r.react(next, previous);
        changed = true;
      }
    }
    if (!changed) return;
  }
}
jest.mock('react-native-reanimated', () => {
  const { useEffect, useRef } = require('react');
  const { ScrollView, View } = require('react-native');
  const shared = (initial: unknown) => {
    const box = { value: initial, get: () => box.value, set: (v: unknown) => void (box.value = v) };
    return box;
  };
  const useShared = (initial: unknown) => {
    const ref = useRef(null);
    if (!ref.current) ref.current = shared(initial);
    return ref.current;
  };
  return {
    __esModule: true,
    default: { View, ScrollView },
    measure: () => null,
    scrollTo: () => {},
    useAnimatedRef: () => useRef(null),
    useAnimatedStyle: (fn: () => object) => fn(),
    useFrameCallback: () => {},
    useReducedMotion: () => true,
    useScrollOffset: () => useShared(0),
    useSharedValue: useShared,
    withSpring: (value: unknown) => value,
    useAnimatedReaction: (prepare: () => unknown, react: (n: unknown, p: unknown) => void) => {
      const ref = useRef(null);
      if (!ref.current) ref.current = { prepare, react, previous: null };
      ref.current.prepare = prepare;
      ref.current.react = react;
      useEffect(() => {
        const reaction = ref.current;
        mockReactions.add(reaction);
        return () => void mockReactions.delete(reaction);
      }, []);
    },
  };
});
// Each row's gesture renders as a host element carrying the callbacks the row gave it.
jest.mock('react-native-gesture-handler', () => {
  const { createElement, Fragment } = require('react');
  const pan = () => {
    const callbacks: Record<string, unknown> = {};
    const self: object = new Proxy(
      {},
      {
        get: (_, key: string) =>
          key === 'callbacks'
            ? callbacks
            : (arg: unknown) => {
                if (typeof arg === 'function') callbacks[key] = arg;
                return self;
              },
      },
    );
    return self;
  };
  return {
    Gesture: { Pan: pan },
    GestureDetector: ({ gesture, children }: { gesture: unknown; children: unknown }) =>
      createElement('GestureDetector', { gesture }, children),
    GestureHandlerRootView: ({ children }: { children: unknown }) => createElement(Fragment, null, children),
  };
});
const mockBack = jest.fn();
const mockDispatch = jest.fn();
let mockParams: { householdId?: string } = {};
jest.mock('expo-router', () => {
  const { createElement, Fragment } = require('react');
  const passThrough = ({ children }: { children?: unknown }) => createElement(Fragment, null, children);
  const Toolbar = Object.assign(passThrough, {
    Button: ({ children, ...props }: { children?: unknown }) => createElement('ToolbarButton', props, children),
  });
  return {
    router: { back: () => mockBack() },
    Stack: { Toolbar },
    useLocalSearchParams: () => mockParams,
    useNavigation: () => ({ dispatch: mockDispatch }),
  };
});
// What the screen last asked `usePreventRemove` for: whether to block leaving, and what to do then.
const mockPreventRemove: { prevent: boolean; callback: ((e: { data: { action: unknown } }) => void) | null } = {
  prevent: false,
  callback: null,
};
jest.mock('expo-router/react-navigation', () => ({
  usePreventRemove: (prevent: boolean, callback: (e: { data: { action: unknown } }) => void) => {
    mockPreventRemove.prevent = prevent;
    mockPreventRemove.callback = callback;
  },
}));

const USER = 'user-1';
const HOME = 'household-home';
const CABIN = 'household-cabin';
const SLOT = Sizes.aisleRow + Spacing.sm;

let tree: ReactTestRenderer | null = null;
let announce: jest.SpiedFunction<typeof AccessibilityInfo.announceForAccessibility>;
let alert: jest.SpiedFunction<typeof Alert.alert>;

beforeEach(() => {
  announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
  alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  mockBack.mockClear();
  mockDispatch.mockClear();
  mockPreventRemove.prevent = false;
  mockPreventRemove.callback = null;
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  mockReactions.clear();
  announce.mockRestore();
  alert.mockRestore();
});

/** The rows, in the order they're drawn (which is the order given), by accessibility label. */
const rows = (root: ReactTestRenderer) =>
  root.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityHint === 'Touch and hold, then drag to move');
const rowLabels = (root: ReactTestRenderer) => rows(root).map((r) => r.props.accessibilityLabel as string);
const a11yAction = (row: ReactTestInstance, actionName: string) =>
  act(() => row.props.onAccessibilityAction({ nativeEvent: { actionName } }));
type PanCallbacks = Record<'onStart' | 'onUpdate' | 'onFinalize', (e?: unknown) => void>;
const gestureFor = (root: ReactTestRenderer, index: number): PanCallbacks =>
  (root.root.findAll((n) => (n.type as string) === 'GestureDetector')[index].props.gesture as { callbacks: PanCallbacks }).callbacks;
const scrollEnabled = (root: ReactTestRenderer) =>
  root.root.find((n) => typeof n.type === 'string' && 'scrollEnabled' in n.props).props.scrollEnabled;

describe('AisleOrderList', () => {
  const aisles: AisleOrderItem[] = [
    { id: 'a', name: 'Produce', slug: 'produce' },
    { id: 'b', name: 'Bakery', slug: 'bakery' },
    { id: 'c', name: 'Dairy', slug: 'dairy' },
    { id: 'd', name: 'Costco', slug: null },
  ];

  function render(onMove = jest.fn()) {
    act(() => {
      tree = create(<AisleOrderList aisles={aisles} onMove={onMove} />);
    });
    act(() => mockFlushReactions());
    return { root: tree!, onMove };
  }

  it('reads each row as its name and place, with no household line', () => {
    const { root } = render();
    expect(rowLabels(root)).toEqual(['Produce, 1 of 4', 'Bakery, 2 of 4', 'Dairy, 3 of 4', 'Costco, 4 of 4']);
    // One text per row: the name.
    const texts = root.root.findAll((n) => typeof n.type === 'string' && typeof n.props.children === 'string');
    expect(texts.map((n) => n.props.children)).toEqual(['Produce', 'Bakery', 'Dairy', 'Costco']);
  });

  it('offers Move up / Move down, leaving them out at the ends', () => {
    const { root } = render();
    const names = rows(root).map((r) => r.props.accessibilityActions.map((a: { name: string }) => a.name));
    expect(names).toEqual([['moveDown'], ['moveUp', 'moveDown'], ['moveUp', 'moveDown'], ['moveUp']]);
  });

  it('VoiceOver Move down / Move up moves by one and announces the new place', () => {
    const { root, onMove } = render();
    a11yAction(rows(root)[1], 'moveDown');
    expect(onMove).toHaveBeenLastCalledWith(1, 2);
    expect(announce).toHaveBeenLastCalledWith('Moved to 3 of 4');
    a11yAction(rows(root)[1], 'moveUp');
    expect(onMove).toHaveBeenLastCalledWith(1, 0);
    expect(announce).toHaveBeenLastCalledWith('Moved to 1 of 4');
  });

  it('a drag drops the row where it was let go, once', () => {
    const { root, onMove } = render();
    const pan = gestureFor(root, 0);
    act(() => pan.onStart());
    expect(scrollEnabled(root)).toBe(false);
    act(() => pan.onUpdate({ translationY: SLOT * 2.2, absoluteY: 300 }));
    act(() => mockFlushReactions());
    act(() => pan.onFinalize());
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith(0, 2);
    expect(scrollEnabled(root)).toBe(true);
  });

  it('a drag can move a row up, and never past the ends', () => {
    const { root, onMove } = render();
    const pan = gestureFor(root, 2);
    act(() => pan.onStart());
    act(() => pan.onUpdate({ translationY: -SLOT * 10, absoluteY: 0 }));
    act(() => mockFlushReactions());
    act(() => pan.onFinalize());
    expect(onMove).toHaveBeenCalledWith(2, 0);
  });

  it('a drag let go in its own slot moves nothing', () => {
    const { root, onMove } = render();
    const pan = gestureFor(root, 1);
    act(() => pan.onStart());
    act(() => pan.onUpdate({ translationY: SLOT * 0.3, absoluteY: 200 }));
    act(() => mockFlushReactions());
    act(() => pan.onFinalize());
    expect(onMove).not.toHaveBeenCalled();
    expect(scrollEnabled(root)).toBe(true);
  });

  it('a press that never became a drag does nothing on release', () => {
    const { root, onMove } = render();
    act(() => gestureFor(root, 1).onFinalize());
    expect(onMove).not.toHaveBeenCalled();
  });
});

describe('the Aisle order screen', () => {
  beforeEach(() => {
    resetDb();
    seedCatalog();
    mockParams = { householdId: HOME };
    db.insert(households).values({ id: HOME, name: 'Home', createdAt: new Date(1) }).run();
  });

  function render() {
    act(() => {
      tree = create(<CategoryOrderScreen />);
    });
    return tree!;
  }
  /** Names from the database, in the user's order for Home. */
  const storedOrder = () => getOrderedCategories(USER, HOME).map((c) => c.name);
  const names = SYSTEM_CATEGORIES.map((c) => c.name);
  const ids = SYSTEM_CATEGORIES.map((c) => c.id);
  /** The aisle names on screen, in order. */
  const shownNames = (root: ReactTestRenderer) => rowLabels(root).map((l) => l.split(',')[0]);
  const texts = (root: ReactTestRenderer) =>
    root.root.findAll((n) => typeof n.type === 'string' && typeof n.props.children === 'string').map((n) => n.props.children);
  const hostByLabel = (root: ReactTestRenderer, label: string) =>
    root.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityLabel === label);
  const button = (root: ReactTestRenderer, label: string) => {
    const [host] = hostByLabel(root, label);
    if (!host) throw new Error(`no ${label}`);
    return host;
  };
  const press = (host: ReactTestInstance) => act(() => host.props.onClick({ nativeEvent: {} }));
  const isOff = (host: ReactTestInstance) => host.props.accessibilityState.disabled === true;
  const selectedTab = (root: ReactTestRenderer) =>
    root.root.find((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'tab' && n.props.accessibilityState.selected)
      .props.accessibilityLabel;
  const householdRows = () => db.select().from(householdCategoryOrder).all();
  const myRows = () => db.select().from(userHouseholdCategoryOrder).all();
  /** Re-reads the database, as the live queries would after a write. */
  const refresh = () => act(() => tree!.update(<CategoryOrderScreen />));
  /** Presses a button of the last alert. */
  const answer = (text: string) => {
    const buttons = (alert.mock.calls.at(-1)?.[2] ?? []) as AlertButton[];
    const choice = buttons.find((b) => b.text === text);
    if (!choice) throw new Error(`no ${text}`);
    act(() => choice.onPress?.());
  };

  it('shows the title and every system aisle in the default order', () => {
    const root = render();
    const header = root.root.find((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'header');
    expect(header.props.children).toBe('Aisle order');
    expect(shownNames(root)).toEqual(names);
  });

  it('with no order of their own: following the household, on Household order, with its footnote', () => {
    const root = render();
    expect(texts(root)).toEqual(
      expect.arrayContaining(['Following household aisle order', 'Used by members who follow the household order.']),
    );
    expect(texts(root)).not.toContain('Only you see this order.');
    expect(selectedTab(root)).toBe('Household order');
    expect(isOff(button(root, 'Save household order'))).toBe(true);
    expect(hostByLabel(root, 'Use household order')).toHaveLength(0);
  });

  it('with an order of their own: using it, on My order, with its footnote and Use household order', () => {
    db.insert(userHouseholdCategoryOrder).values({ userId: USER, householdId: HOME, categoryIds: [ids[3]] }).run();
    const root = render();
    expect(texts(root)).toEqual(expect.arrayContaining(['Using your own aisle order', 'Only you see this order.']));
    expect(selectedTab(root)).toBe('My order');
    expect(shownNames(root)[0]).toBe(names[3]);
    expect(isOff(button(root, 'Save my order'))).toBe(true);
    expect(hostByLabel(root, 'Use household order')).toHaveLength(1);
  });

  it('Household order shows the household order even while the user uses their own', () => {
    db.insert(householdCategoryOrder).values({ householdId: HOME, categoryIds: [ids[2]] }).run();
    db.insert(userHouseholdCategoryOrder).values({ userId: USER, householdId: HOME, categoryIds: [ids[3]] }).run();
    const root = render();
    press(button(root, 'Household order'));
    expect(selectedTab(root)).toBe('Household order');
    expect(shownNames(root)[0]).toBe(names[2]);
    expect(texts(root)).toContain('Used by members who follow the household order.');
    // Still using their own: choosing a side changes nothing.
    expect(texts(root)).toContain('Using your own aisle order');
    expect(alert).not.toHaveBeenCalled();
  });

  it('Household order shows the default when the household has none', () => {
    db.insert(userHouseholdCategoryOrder).values({ userId: USER, householdId: HOME, categoryIds: [ids[3]] }).run();
    const root = render();
    press(button(root, 'Household order'));
    expect(shownNames(root)).toEqual(names);
  });

  it('My order without an own order starts from the order the user uses now, and creates nothing', () => {
    db.insert(householdCategoryOrder).values({ householdId: HOME, categoryIds: [ids[4], ids[1]] }).run();
    const root = render();
    press(button(root, 'My order'));
    expect(selectedTab(root)).toBe('My order');
    expect(shownNames(root).slice(0, 2)).toEqual([names[4], names[1]]);
    expect(texts(root)).toContain('Only you see this order.');
    expect(texts(root)).toContain('Following household aisle order');
    expect(myRows()).toEqual([]);
    expect(hostByLabel(root, 'Use household order')).toHaveLength(0);
    // And back: still nothing written.
    press(button(root, 'Household order'));
    expect(myRows()).toEqual([]);
    expect(householdRows()).toEqual([expect.objectContaining({ categoryIds: [ids[4], ids[1]] })]);
  });

  it('a VoiceOver move changes the draft only, and turns Save on', () => {
    const root = render();
    a11yAction(rows(root)[0], 'moveDown');
    expect(shownNames(root).slice(0, 2)).toEqual([names[1], names[0]]);
    expect(householdRows()).toEqual([]);
    expect(myRows()).toEqual([]);
    expect(isOff(button(root, 'Save household order'))).toBe(false);
    expect(mockPreventRemove.prevent).toBe(true);
  });

  it('a drag changes the draft only', () => {
    const root = render();
    act(() => mockFlushReactions());
    const pan = gestureFor(root, 0);
    act(() => pan.onStart());
    act(() => pan.onUpdate({ translationY: SLOT * 3, absoluteY: 300 }));
    act(() => mockFlushReactions());
    act(() => pan.onFinalize());
    expect(shownNames(root).slice(0, 4)).toEqual([names[1], names[2], names[3], names[0]]);
    expect(householdRows()).toEqual([]);
    expect(storedOrder()).toEqual(names);
  });

  it('moving an aisle back where it was turns Save off again', () => {
    const root = render();
    a11yAction(rows(root)[0], 'moveDown');
    a11yAction(rows(root)[1], 'moveUp');
    expect(shownNames(root)).toEqual(names);
    expect(isOff(button(root, 'Save household order'))).toBe(true);
    expect(mockPreventRemove.prevent).toBe(false);
  });

  it('Save household order writes the whole order, for everyone following it, and leaves the user’s side alone', () => {
    const root = render();
    a11yAction(rows(root)[0], 'moveDown');
    press(button(root, 'Save household order'));
    const expected = [ids[1], ids[0], ...ids.slice(2)];
    expect(householdRows()).toEqual([expect.objectContaining({ householdId: HOME, categoryIds: expected })]);
    expect(myRows()).toEqual([]);
    expect(getAisleOrder(USER, HOME).source).toBe('household');
    expect(texts(root)).toContain('Following household aisle order');
    expect(shownNames(root).slice(0, 2)).toEqual([names[1], names[0]]);
    expect(isOff(button(root, 'Save household order'))).toBe(true);
    expect(mockPreventRemove.prevent).toBe(false);
  });

  it('saving the household order never deletes the user’s own', () => {
    db.insert(userHouseholdCategoryOrder).values({ userId: USER, householdId: HOME, categoryIds: [ids[3]] }).run();
    const root = render();
    press(button(root, 'Household order'));
    a11yAction(rows(root)[0], 'moveDown');
    press(button(root, 'Save household order'));
    expect(householdRows()).toEqual([expect.objectContaining({ categoryIds: [ids[1], ids[0], ...ids.slice(2)] })]);
    expect(myRows()).toEqual([expect.objectContaining({ userId: USER, householdId: HOME, categoryIds: [ids[3]] })]);
    expect(texts(root)).toContain('Using your own aisle order');
    expect(getAisleOrder(USER, HOME).categories[0].id).toBe(ids[3]);
  });

  it('Save my order writes the whole order as the user’s own, and leaves the household’s alone', () => {
    db.insert(householdCategoryOrder).values({ householdId: HOME, categoryIds: [ids[2]] }).run();
    const root = render();
    press(button(root, 'My order'));
    a11yAction(rows(root)[0], 'moveDown');
    press(button(root, 'Save my order'));
    const household = getAisleOrder('someone-else', HOME).categories.map((c) => c.id);
    expect(myRows()).toEqual([
      expect.objectContaining({ userId: USER, householdId: HOME, categoryIds: [household[1], household[0], ...household.slice(2)] }),
    ]);
    expect(householdRows()).toEqual([expect.objectContaining({ categoryIds: [ids[2]] })]);
    expect(texts(root)).toContain('Using your own aisle order');
    expect(hostByLabel(root, 'Use household order')).toHaveLength(1);
    expect(isOff(button(root, 'Save my order'))).toBe(true);
  });

  it('Use household order deletes the user’s own order, without asking', () => {
    db.insert(householdCategoryOrder).values({ householdId: HOME, categoryIds: [ids[2]] }).run();
    db.insert(userHouseholdCategoryOrder).values({ userId: USER, householdId: HOME, categoryIds: [ids[3]] }).run();
    const root = render();
    press(button(root, 'Use household order'));
    refresh();
    expect(alert).not.toHaveBeenCalled();
    expect(myRows()).toEqual([]);
    expect(householdRows()).toHaveLength(1);
    expect(texts(root)).toContain('Following household aisle order');
    expect(hostByLabel(root, 'Use household order')).toHaveLength(0);
    // My order now starts from the household's.
    expect(shownNames(root)[0]).toBe(names[2]);
  });

  it('switching sides with unsaved moves asks; Keep editing keeps the side and the draft', () => {
    const root = render();
    a11yAction(rows(root)[0], 'moveDown');
    press(button(root, 'My order'));
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert.mock.calls[0][0]).toBe('Discard your changes?');
    const buttons = alert.mock.calls[0][2] as AlertButton[];
    expect(buttons.map((b) => [b.text, b.style])).toEqual([
      ['Keep editing', 'cancel'],
      ['Discard', 'destructive'],
    ]);
    answer('Keep editing');
    expect(selectedTab(root)).toBe('Household order');
    expect(shownNames(root).slice(0, 2)).toEqual([names[1], names[0]]);
    expect(isOff(button(root, 'Save household order'))).toBe(false);
  });

  it('switching sides with unsaved moves: Discard drops them and switches, saving nothing', () => {
    const root = render();
    a11yAction(rows(root)[0], 'moveDown');
    press(button(root, 'My order'));
    answer('Discard');
    expect(selectedTab(root)).toBe('My order');
    expect(shownNames(root)).toEqual(names);
    expect(isOff(button(root, 'Save my order'))).toBe(true);
    expect(householdRows()).toEqual([]);
    expect(myRows()).toEqual([]);
    expect(mockPreventRemove.prevent).toBe(false);
  });

  it('switching sides with nothing moved asks nothing', () => {
    const root = render();
    press(button(root, 'My order'));
    press(button(root, 'Household order'));
    expect(alert).not.toHaveBeenCalled();
  });

  it('leaving (Done, swipe down) is blocked only while there are unsaved moves', () => {
    const root = render();
    expect(mockPreventRemove.prevent).toBe(false);
    a11yAction(rows(root)[0], 'moveDown');
    expect(mockPreventRemove.prevent).toBe(true);
    const action = { type: 'GO_BACK' };
    act(() => mockPreventRemove.callback!({ data: { action } }));
    expect(alert.mock.calls.at(-1)?.[0]).toBe('Discard your changes?');
    answer('Keep editing');
    expect(mockDispatch).not.toHaveBeenCalled();
    act(() => mockPreventRemove.callback!({ data: { action } }));
    answer('Discard');
    expect(mockDispatch).toHaveBeenCalledWith(action);
    expect(householdRows()).toEqual([]);
  });

  it("shows one household's aisles: the system ones plus its own custom ones, last", () => {
    db.insert(households).values({ id: CABIN, name: 'Cabin', createdAt: new Date(2) }).run();
    createCategory(HOME, 'Costco');
    createCategory(CABIN, 'Farm stand');
    const root = render();
    const count = SYSTEM_CATEGORIES.length + 1;
    expect(rowLabels(root)).toEqual([
      ...SYSTEM_CATEGORIES.map((c, i) => `${c.name}, ${i + 1} of ${count}`),
      `Costco, ${count} of ${count}`,
    ]);
    // No household names under the aisles.
    const texts = root.root.findAll((n) => typeof n.type === 'string' && typeof n.props.children === 'string');
    expect(texts.map((n) => n.props.children)).not.toEqual(expect.arrayContaining(['Home']));
    expect(texts.map((n) => n.props.children)).not.toEqual(expect.arrayContaining(['Farm stand']));
  });

  it("without a household id it borrows no household's custom aisles and saves nothing", () => {
    createCategory(HOME, 'Costco');
    mockParams = {};
    const root = render();
    expect(rowLabels(root)).toHaveLength(SYSTEM_CATEGORIES.length);
    expect(rowLabels(root).some((l) => l.startsWith('Costco'))).toBe(false);
    a11yAction(rows(root)[0], 'moveDown');
    expect(isOff(button(root, 'Save household order'))).toBe(true);
    press(button(root, 'Save household order'));
    expect(db.select().from(userHouseholdCategoryOrder).all()).toEqual([]);
    expect(householdRows()).toEqual([]);
  });

  it('opens on the household it is given, and saves to that household only', () => {
    db.insert(households).values({ id: CABIN, name: 'Cabin', createdAt: new Date(2) }).run();
    createCategory(CABIN, 'Farm stand');
    mockParams = { householdId: CABIN };
    const root = render();
    expect(rowLabels(root).at(-1)).toMatch(/^Farm stand, \d+ of/);
    press(button(root, 'My order'));
    a11yAction(rows(root)[0], 'moveDown');
    press(button(root, 'Save my order'));
    expect(db.select().from(userHouseholdCategoryOrder).all().map((r) => r.householdId)).toEqual([CABIN]);
    expect(storedOrder()).toEqual(SYSTEM_CATEGORIES.map((c) => c.name));
  });

  it("follows the household order when the user has none, and the user's own over it", () => {
    const ids = SYSTEM_CATEGORIES.map((c) => c.id);
    db.insert(householdCategoryOrder).values({ householdId: HOME, categoryIds: [ids[2], ids[0], ids[1]] }).run();
    let root = render();
    expect(rowLabels(root)[0]).toMatch(new RegExp(`^${SYSTEM_CATEGORIES[2].name}, 1 of`));
    db.insert(userHouseholdCategoryOrder).values({ userId: USER, householdId: HOME, categoryIds: [ids[1]] }).run();
    act(() => tree!.unmount());
    root = render();
    expect(rowLabels(root)[0]).toMatch(new RegExp(`^${SYSTEM_CATEGORIES[1].name}, 1 of`));
  });

  it('is in Spanish with the app in Spanish (spec 4.15)', () => {
    initI18n('es');
    try {
      const root = render();
      const header = root.root.find((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'header');
      expect(header.props.children).toBe('Orden de pasillos');
      const texts = root.root.findAll((n) => typeof n.type === 'string' && typeof n.props.children === 'string');
      expect(texts.map((n) => n.props.children)).toEqual(
        expect.arrayContaining([
          'Sigues el orden de pasillos del hogar',
          'Lo usan los miembros que siguen el orden del hogar.',
          'Orden del hogar',
          'Mi orden',
          'Guardar orden del hogar',
        ]),
      );
      expect(root.root.find((n) => (n.type as string) === 'ToolbarButton').props.children).toBe('Listo');
      const spanishRows = root.root.findAll(
        (n) => typeof n.type === 'string' && n.props.accessibilityHint === 'Mantén presionado y arrastra para mover',
      );
      const count = SYSTEM_CATEGORIES.length;
      expect(spanishRows[0].props.accessibilityLabel).toBe(`Frutas y verduras, 1 de ${count}`);
      expect(spanishRows[1].props.accessibilityActions).toEqual([
        { name: 'moveUp', label: 'Subir' },
        { name: 'moveDown', label: 'Bajar' },
      ]);
      a11yAction(spanishRows[0], 'moveDown');
      expect(announce).toHaveBeenLastCalledWith(`Movido a 2 de ${count}`);
    } finally {
      act(() => tree?.unmount());
      tree = null;
      initI18n('en');
    }
  });

  it('Done closes it', () => {
    const root = render();
    const done = root.root.find((n) => (n.type as string) === 'ToolbarButton');
    expect(done.props.children).toBe('Done');
    act(() => done.props.onPress());
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});
