// Aisle order (spec 4.3.3, board 12): long-press and drag, or VoiceOver's Move up / Move down,
// reorders the aisles, and the screen saves the user's order to the database.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AccessibilityInfo } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { db, households } from '@/db';
import { Sizes, Spacing } from '@/constants/theme';
import { SYSTEM_CATEGORIES } from '@/shared';
import { resetDb } from '@/test/db';

import CategoryOrderScreen from '@/app/category-order';

import { AisleOrderList, type AisleOrderItem } from '../aisle-order-list';
import { createCategory, getOrderedCategories, loadCatalogSeed } from '../categories';

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
jest.mock('expo-router', () => {
  const { createElement, Fragment } = require('react');
  const passThrough = ({ children }: { children?: unknown }) => createElement(Fragment, null, children);
  const Toolbar = Object.assign(passThrough, {
    Button: ({ children, ...props }: { children?: unknown }) => createElement('ToolbarButton', props, children),
  });
  return { router: { back: () => mockBack() }, Stack: { Toolbar } };
});

const USER = 'user-1';
const SLOT = Sizes.aisleRow + Spacing.sm;

let tree: ReactTestRenderer | null = null;
let announce: jest.SpiedFunction<typeof AccessibilityInfo.announceForAccessibility>;

beforeEach(() => {
  announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
  mockBack.mockClear();
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  mockReactions.clear();
  announce.mockRestore();
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
    { id: 'd', name: 'Costco', slug: null, household: 'Test home' },
  ];

  function render(onMove = jest.fn()) {
    act(() => {
      tree = create(<AisleOrderList aisles={aisles} onMove={onMove} />);
    });
    act(() => mockFlushReactions());
    return { root: tree!, onMove };
  }

  it('reads each row as its name, household and place', () => {
    const { root } = render();
    expect(rowLabels(root)).toEqual([
      'Produce, 1 of 4',
      'Bakery, 2 of 4',
      'Dairy, 3 of 4',
      'Costco, Test home, 4 of 4',
    ]);
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
    loadCatalogSeed();
  });

  function render() {
    act(() => {
      tree = create(<CategoryOrderScreen />);
    });
    return tree!;
  }
  /** Names from the database, in the user's order. */
  const storedOrder = (householdIds: string[] = []) => getOrderedCategories(USER, householdIds).map((c) => c.name);

  it('shows the title and every system aisle in the default order', () => {
    const root = render();
    const header = root.root.find((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'header');
    expect(header.props.children).toBe('Aisle order');
    expect(rowLabels(root).map((l) => l.split(',')[0])).toEqual(SYSTEM_CATEGORIES.map((c) => c.name));
  });

  it('a VoiceOver move is saved as the user’s order and shown', () => {
    const root = render();
    const [first, second] = SYSTEM_CATEGORIES.map((c) => c.name);
    a11yAction(rows(root)[0], 'moveDown');
    expect(storedOrder().slice(0, 2)).toEqual([second, first]);
    act(() => tree!.update(<CategoryOrderScreen />));
    expect(rowLabels(root).slice(0, 2)).toEqual([
      `${second}, 1 of ${SYSTEM_CATEGORIES.length}`,
      `${first}, 2 of ${SYSTEM_CATEGORIES.length}`,
    ]);
  });

  it('a drag is saved too', () => {
    const root = render();
    act(() => mockFlushReactions());
    const names = SYSTEM_CATEGORIES.map((c) => c.name);
    const pan = gestureFor(root, 0);
    act(() => pan.onStart());
    act(() => pan.onUpdate({ translationY: SLOT * 3, absoluteY: 300 }));
    act(() => mockFlushReactions());
    act(() => pan.onFinalize());
    expect(storedOrder().slice(0, 4)).toEqual([names[1], names[2], names[3], names[0]]);
  });

  it('includes custom aisles of every household, naming the household when there are several', () => {
    db.insert(households).values([
      { id: 'h1', name: 'Home' },
      { id: 'h2', name: 'Cabin' },
    ]).run();
    createCategory(USER, 'h1', 'Costco');
    createCategory(USER, 'h2', 'Costco');
    const root = render();
    const labels = rowLabels(root);
    expect(labels).toHaveLength(SYSTEM_CATEGORIES.length + 2);
    expect(labels.filter((l) => l.startsWith('Costco,'))).toEqual([
      expect.stringMatching(/^Costco, Home, \d+ of/),
      expect.stringMatching(/^Costco, Cabin, \d+ of/),
    ]);
  });

  it('with one household, a custom aisle has no household line', () => {
    db.insert(households).values({ id: 'h1', name: 'Home' }).run();
    createCategory(USER, 'h1', 'Costco');
    const root = render();
    expect(rowLabels(root).find((l) => l.startsWith('Costco,'))).toMatch(/^Costco, \d+ of/);
  });

  it('Done closes it', () => {
    const root = render();
    const done = root.root.find((n) => (n.type as string) === 'ToolbarButton');
    expect(done.props.children).toBe('Done');
    act(() => done.props.onPress());
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});
