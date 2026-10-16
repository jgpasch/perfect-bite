import * as Haptics from 'expo-haptics';
import { useEffect, useState, type ReactNode } from 'react';
import type { FlatList } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  measure,
  scrollTo,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useScrollOffset,
  useSharedValue,
  withSpring,
  type AnimatedRef,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { autoScrollStep } from '@/features/categories/aisle-order';
import { useTheme } from '@/hooks/use-theme';

import { dragTo, makeRoomShift, settleOffset, withBox, type RowBox } from './row-drag';

export type ReorderableRow = {
  id: string;
  /** Off for a row that can't move (a checked row lingering in place); its long-press is then the row's own. */
  draggable: boolean;
  node: ReactNode;
};

type Props<T> = {
  rows: ReorderableRow[];
  /** The list the rows scroll in, for the auto-scroll near its edges. */
  scrollRef: AnimatedRef<FlatList<T>>;
  /** Called once per drop that changes the order, with the row's old and new index. */
  onMove: (from: number, to: number) => void;
  /** A long-press let go without moving: the row's long-press as elsewhere (Select mode, spec 4.5). */
  onSelect: (id: string) => void;
  /** While a row is lifted, so the list can stop scrolling under the finger. */
  onDragChange: (dragging: boolean) => void;
};

/** As long as a Pressable's long-press, so the hold before Select mode is the same as on other rows. */
export const LONG_PRESS_MS = 500;
/** Further than this from where the hold began counts as moving: the drop then doesn't select. */
const STILL_SLOP = 8;
/** How deep the auto-scroll band is at the top and bottom of the list, and its top speed per frame. */
const EDGE = 64;
const MAX_STEP = 10;
/** How far the dragged row grows, as on the Aisle order screen (board 12). */
const LIFT_SCALE = 1.03;

/** Shared drag state: one row is dragged at a time. */
type Drag = {
  /** The lifted row, from long-press until the order on screen has caught up with the drop. */
  activeId: SharedValue<string | null>;
  /** The row under the finger, from long-press until it's let go. */
  heldId: SharedValue<string | null>;
  /** The rows' current order, and each row's box as laid out. */
  order: SharedValue<string[]>;
  boxes: SharedValue<Record<string, RowBox>>;
  /** The boxes in order when the drag began. */
  startBoxes: SharedValue<RowBox[]>;
  from: SharedValue<number>;
  to: SharedValue<number>;
  /** The dragged row's offset from its place, following the finger and the auto-scroll. */
  offset: SharedValue<number>;
  translation: SharedValue<number>;
  startScroll: SharedValue<number>;
  scroll: SharedValue<number>;
  fingerY: SharedValue<number>;
  moved: SharedValue<boolean>;
  dropping: SharedValue<boolean>;
};

/**
 * As added's rows (spec 4.6), in a card: long-press a row and move without lifting to drag it. It lifts
 * (a little bigger, with a shadow), the others make room, and the list scrolls near its top and bottom
 * edges. Let go without moving and it's the row's long-press instead. Rows can differ in height.
 */
export function ReorderableRows<T>({ rows, scrollRef, onMove, onSelect, onDragChange }: Props<T>) {
  const reduceMotion = useReducedMotion();
  const { motion } = useTheme();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Bumped on every drop, so the shared state resets once the new order has rendered (or at once, if
  // the order didn't change).
  const [drops, setDrops] = useState(0);
  const containerRef = useAnimatedRef<Animated.View>();
  const viewportTop = useSharedValue(0);
  const viewportHeight = useSharedValue(0);
  const drag: Drag = {
    activeId: useSharedValue<string | null>(null),
    heldId: useSharedValue<string | null>(null),
    order: useSharedValue<string[]>([]),
    boxes: useSharedValue<Record<string, RowBox>>({}),
    startBoxes: useSharedValue<RowBox[]>([]),
    from: useSharedValue(0),
    to: useSharedValue(0),
    offset: useSharedValue(0),
    translation: useSharedValue(0),
    startScroll: useSharedValue(0),
    scroll: useScrollOffset(scrollRef),
    fingerY: useSharedValue(0),
    moved: useSharedValue(false),
    dropping: useSharedValue(false),
  };
  const { activeId, order, startBoxes, from, to, offset, dropping } = drag;

  const idsKey = rows.map((r) => r.id).join('|');
  useEffect(() => {
    order.set(idsKey === '' ? [] : idsKey.split('|'));
    activeId.set(null);
    dropping.set(false);
    offset.set(0);
  }, [idsKey, drops, order, activeId, dropping, offset]);

  // The dragged row follows the finger and the auto-scroll; the others make room where it would land.
  useAnimatedReaction(
    () => {
      if (activeId.get() === null || dropping.get()) return null;
      return { translation: drag.translation.get(), scrolled: drag.scroll.get() - drag.startScroll.get() };
    },
    (moved) => {
      if (moved === null) return;
      const next = dragTo(startBoxes.get(), from.get(), moved.translation, moved.scrolled);
      offset.set(next.offset);
      to.set(next.to);
    },
  );

  // Scroll while the finger is near the top or bottom edge, only as far as rows are hidden past it.
  useFrameCallback(() => {
    if (activeId.get() === null || dropping.get()) return;
    const step = autoScrollStep(drag.fingerY.get() - viewportTop.get(), viewportHeight.get(), EDGE, MAX_STEP);
    if (step === 0) return;
    const box = measure(containerRef);
    if (!box) return;
    const hiddenAbove = viewportTop.get() - box.pageY;
    const hiddenBelow = box.pageY + box.height - (viewportTop.get() + viewportHeight.get());
    if ((step < 0 && hiddenAbove <= 0) || (step > 0 && hiddenBelow <= 0)) return;
    const by = step < 0 ? Math.max(step, -hiddenAbove) : Math.min(step, hiddenBelow);
    scrollTo(scrollRef, 0, Math.max(0, drag.scroll.get() + by), false);
  });

  const lifted = (id: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setDraggingId(id);
    onDragChange(true);
  };

  const released = (id: string, fromIndex: number, toIndex: number, still: boolean) => {
    setDraggingId(null);
    onDragChange(false);
    setDrops((n) => n + 1);
    if (still) return onSelect(id);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (fromIndex !== toIndex) onMove(fromIndex, toIndex);
  };

  const startDrag = (id: string) => {
    'worklet';
    const window = measure(scrollRef);
    if (window) {
      viewportTop.set(window.pageY);
      viewportHeight.set(window.height);
    }
    const ids = order.get();
    const index = ids.indexOf(id);
    if (index === -1) return;
    const boxes = drag.boxes.get();
    startBoxes.set(ids.map((key) => boxes[key] ?? { y: 0, h: 0 }));
    from.set(index);
    to.set(index);
    offset.set(0);
    drag.translation.set(0);
    drag.startScroll.set(drag.scroll.get());
    drag.moved.set(false);
    dropping.set(false);
    activeId.set(id);
    drag.heldId.set(id);
    scheduleOnRN(lifted, id);
  };

  const endDrag = (id: string) => {
    'worklet';
    if (drag.heldId.get() !== id) return;
    drag.heldId.set(null);
    // The rows changed under the drag (a sync, an add): let go without moving anything.
    if (activeId.get() !== id) {
      scheduleOnRN(released, id, 0, 0, false);
      return;
    }
    const f = from.get();
    const t = to.get();
    if (!drag.moved.get()) {
      activeId.set(null);
      scheduleOnRN(released, id, f, f, true);
      return;
    }
    dropping.set(true);
    const target = settleOffset(startBoxes.get(), f, t);
    if (reduceMotion) {
      offset.set(target);
      scheduleOnRN(released, id, f, t, false);
      return;
    }
    offset.set(
      withSpring(target, motion.spring, () => {
        'worklet';
        scheduleOnRN(released, id, f, t, false);
      }),
    );
  };

  return (
    <Animated.View ref={containerRef}>
      {rows.map((row, index) => (
        <DragRow
          key={row.id}
          id={row.id}
          index={index}
          draggable={row.draggable}
          lifted={draggingId === row.id}
          reduceMotion={reduceMotion}
          drag={drag}
          onStart={startDrag}
          onEnd={endDrag}>
          {row.node}
        </DragRow>
      ))}
    </Animated.View>
  );
}

type RowProps = {
  id: string;
  index: number;
  draggable: boolean;
  lifted: boolean;
  reduceMotion: boolean;
  drag: Drag;
  onStart: (id: string) => void;
  onEnd: (id: string) => void;
  children: ReactNode;
};

function DragRow({ id, index, draggable, lifted, reduceMotion, drag, onStart, onEnd, children }: RowProps) {
  const { colors, shadows, motion } = useTheme();
  const { activeId, from, to, offset, startBoxes, dropping } = drag;

  const style = useAnimatedStyle(() => {
    const active = activeId.get();
    if (active === null) return { zIndex: 0, transform: [{ translateY: 0 }, { scale: 1 }] };
    if (active === id) {
      const scale = reduceMotion || dropping.get() ? 1 : LIFT_SCALE;
      return {
        zIndex: 1,
        transform: [{ translateY: offset.get() }, { scale: reduceMotion ? scale : withSpring(scale, motion.spring) }],
      };
    }
    const shift = makeRoomShift(index, from.get(), to.get(), startBoxes.get()[from.get()]?.h ?? 0);
    return { zIndex: 0, transform: [{ translateY: reduceMotion ? shift : withSpring(shift, motion.spring) }, { scale: 1 }] };
  });

  const gesture = Gesture.Pan()
    .enabled(draggable)
    .activateAfterLongPress(LONG_PRESS_MS)
    .onStart(() => onStart(id))
    .onUpdate((e) => {
      drag.translation.set(e.translationY);
      drag.fingerY.set(e.absoluteY);
      if (Math.abs(e.translationY) > STILL_SLOP || Math.abs(e.translationX) > STILL_SLOP) drag.moved.set(true);
    })
    .onFinalize(() => onEnd(id));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        onLayout={(e) => {
          const { y, height } = e.nativeEvent.layout;
          // On the UI thread, after any box queued before it. The rows lay out together, and a `set` from
          // here only lands on the UI thread later while a `get` reads what's there now: read-then-set
          // kept just the last row's box, so the others had no height and never made room.
          drag.boxes.modify((all) => {
            'worklet';
            return withBox(all, id, { y, h: height });
          });
        }}
        style={[lifted && { ...shadows.lifted, shadowColor: colors.ink, backgroundColor: colors.surface }, style]}>
        {children}
      </Animated.View>
    </GestureDetector>
  );
}
