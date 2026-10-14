// As added's drag (spec 4.6): long-press and move to reorder rows of different heights; long-press and
// let go without moving is the row's long-press (Select mode) instead.
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import * as Haptics from 'expo-haptics';
import { Text, type FlatList } from 'react-native';
import type { AnimatedRef } from 'react-native-reanimated';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { LONG_PRESS_MS, ReorderableRows, type ReorderableRow } from '../reorderable-rows';

jest.mock('@/global.css', () => ({}));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(), ImpactFeedbackStyle: { Light: 'light' } }));
jest.mock('react-native-worklets', () => ({ scheduleOnRN: (fn: (...a: unknown[]) => void, ...args: unknown[]) => fn(...args) }));

// Reanimated, run on the JS thread: shared values keep their value across renders, animated reactions
// run when a test calls `mockFlushReactions` (the UI thread's frame, in effect), and springs land at once.
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
  const { View } = require('react-native');
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
    default: { View },
    measure: () => null,
    scrollTo: () => {},
    useAnimatedRef: () => useRef(null),
    useAnimatedStyle: (fn: () => object) => fn(),
    useFrameCallback: () => {},
    useReducedMotion: () => false,
    useScrollOffset: () => useShared(0),
    useSharedValue: useShared,
    withSpring: (value: unknown, _config: unknown, done?: (finished: boolean) => void) => (done?.(true), value),
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
// Each row's gesture renders as a host element carrying what the row set on it.
jest.mock('react-native-gesture-handler', () => {
  const { createElement } = require('react');
  const pan = () => {
    const settings: Record<string, unknown> = {};
    const self: object = new Proxy(
      {},
      {
        get: (_, key: string) =>
          key === 'settings'
            ? settings
            : (arg: unknown) => {
                settings[key] = arg;
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
  };
});

type Pan = {
  onStart: () => void;
  onUpdate: (e: { translationX: number; translationY: number; absoluteY: number }) => void;
  onFinalize: () => void;
  enabled: boolean;
  activateAfterLongPress: number;
};

let tree: ReactTestRenderer | null = null;

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  mockReactions.clear();
  jest.mocked(Haptics.impactAsync).mockClear();
});

/** Three rows, 50, 80 and 50 pt tall (a note on the middle one). */
const HEIGHTS = [50, 80, 50];
const ROWS: ReorderableRow[] = ['a', 'b', 'c'].map((id) => ({ id, draggable: true, node: <Text key={id}>{id}</Text> }));

function render(rows = ROWS) {
  const props = {
    onMove: jest.fn<(from: number, to: number) => void>(),
    onSelect: jest.fn<(id: string) => void>(),
    onDragChange: jest.fn<(dragging: boolean) => void>(),
  };
  const scrollRef = { current: null } as unknown as AnimatedRef<FlatList<never>>;
  const draw = (r: ReorderableRow[]) => <ReorderableRows rows={r} scrollRef={scrollRef} {...props} />;
  act(() => {
    tree = create(draw(rows));
  });
  layOut();
  return { ...props, rerender: (r: ReorderableRow[]) => act(() => tree!.update(draw(r))) };
}

/** Each row reports its place in the card, as on screen. */
function layOut() {
  const boxes = tree!.root.findAll((n) => n.type === ('View' as never) && typeof n.props.onLayout === 'function');
  let y = 0;
  boxes.forEach((box: ReactTestInstance, i) => {
    box.props.onLayout({ nativeEvent: { layout: { x: 0, y, width: 320, height: HEIGHTS[i] } } });
    y += HEIGHTS[i];
  });
  act(() => mockFlushReactions());
}

const pan = (index: number): Pan =>
  (tree!.root.findAll((n) => n.type === ('GestureDetector' as never))[index].props.gesture as { settings: Pan }).settings;

/** Long-press row `index`, move it by `dy` (the finger never lifting), then let go. */
function dragBy(index: number, dy: number) {
  const g = pan(index);
  act(() => g.onStart());
  act(() => g.onUpdate({ translationX: 0, translationY: dy, absoluteY: 300 + dy }));
  act(() => mockFlushReactions());
  act(() => g.onFinalize());
}

describe('ReorderableRows', () => {
  test('a row lifts after a long-press as long as a Pressable\'s, with a light haptic', () => {
    const { onDragChange } = render();
    expect(pan(0).activateAfterLongPress).toBe(LONG_PRESS_MS);
    expect(LONG_PRESS_MS).toBe(500);
    act(() => pan(0).onStart());
    expect(Haptics.impactAsync).toHaveBeenCalledWith('light');
    expect(onDragChange).toHaveBeenLastCalledWith(true);
  });

  test('let go without moving: the row\'s long-press (Select mode), and nothing moves', () => {
    const { onMove, onSelect, onDragChange } = render();
    dragBy(1, 3);
    expect(onSelect).toHaveBeenCalledWith('b');
    expect(onMove).not.toHaveBeenCalled();
    expect(onDragChange).toHaveBeenLastCalledWith(false);
    // Only the lift's haptic: no drop.
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
  });

  test('a drop past a row moves it there, once, with a light impact', () => {
    const { onMove, onSelect, onDragChange } = render();
    // Row a's bottom past row b's middle.
    dragBy(0, 45);
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith(0, 1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onDragChange).toHaveBeenLastCalledWith(false);
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(2);
  });

  test('up past rows of different heights, and never past the ends', () => {
    const { onMove } = render();
    dragBy(2, -1000);
    expect(onMove).toHaveBeenCalledWith(2, 0);
    onMove.mockClear();
    dragBy(0, 1000);
    expect(onMove).toHaveBeenCalledWith(0, 2);
  });

  test('dropped in the same place saves nothing and doesn\'t select', () => {
    const { onMove, onSelect, onDragChange } = render();
    // Moved, but its bottom isn't past row c's middle, nor its top past row a's.
    dragBy(1, 20);
    expect(onMove).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onDragChange).toHaveBeenLastCalledWith(false);
  });

  test('a press that never became a drag does nothing on release', () => {
    const { onMove, onSelect, onDragChange } = render();
    act(() => pan(1).onFinalize());
    expect(onMove).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onDragChange).not.toHaveBeenCalled();
  });

  test('rows changing under a drag (a sync) end it without moving anything', () => {
    const { onMove, onSelect, onDragChange, rerender } = render();
    act(() => pan(0).onStart());
    act(() => pan(0).onUpdate({ translationX: 0, translationY: 120, absoluteY: 420 }));
    act(() => mockFlushReactions());
    const g = pan(0);
    rerender([{ id: 'new', draggable: true, node: <Text key="new">new</Text> }, ...ROWS]);
    act(() => g.onFinalize());
    expect(onMove).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
    expect(onDragChange).toHaveBeenLastCalledWith(false);
  });

  test('a row that can\'t move has its gesture off', () => {
    render(ROWS.map((r) => ({ ...r, draggable: r.id !== 'b' })));
    expect([0, 1, 2].map((i) => pan(i).enabled)).toEqual([true, false, true]);
  });

  test('a second drag works after a drop', () => {
    const { onMove } = render();
    dragBy(0, 45);
    dragBy(2, -1000);
    expect(onMove.mock.calls).toEqual([
      [0, 1],
      [2, 0],
    ]);
  });
});
