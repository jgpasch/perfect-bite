import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';
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
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { aisleRowLook } from '@/components/appearance';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { aisleColor } from '@/domain/aisle-color';
import { useTheme } from '@/hooks/use-theme';

import { aisleRowActions, aisleRowLabel, autoScrollStep, dropIndex, moveId } from './aisle-order';

export type AisleOrderItem = { id: string; name: string; slug: string | null };

type Props = {
  aisles: AisleOrderItem[];
  /** Called once per drop (or VoiceOver move) with the aisle's old and new index. */
  onMove: (from: number, to: number) => void;
  /** Scrolls with the rows, above them (the title and the explanation). */
  header?: ReactNode;
};

/** How deep the auto-scroll band is at the top and bottom of the list, and its top speed per frame. */
const EDGE = 64;
const MAX_STEP = 10;
/** How far the dragged row grows (board 12). */
const LIFT_SCALE = 1.03;

/** Shared drag state: one row is dragged at a time. */
type Drag = {
  activeId: SharedValue<string | null>;
  /** id → index while dragging; follows `aisles` otherwise. */
  positions: SharedValue<Record<string, number>>;
  /** Where the dragged row is, from the top of the rows. */
  activeTop: SharedValue<number>;
  startTop: SharedValue<number>;
  translation: SharedValue<number>;
  startScroll: SharedValue<number>;
  scroll: SharedValue<number>;
  fingerY: SharedValue<number>;
  from: SharedValue<number>;
};

/**
 * The Aisle order screen's rows (board 12): white rounded rows with the aisle's dot and a grip.
 * Long-press a row and drag it; it lifts (shadow, a little bigger, outlined in its aisle colour)
 * over a dashed slot where it will land. Dragging near the top or bottom edge scrolls. VoiceOver
 * users get Move up / Move down actions on each row.
 */
export function AisleOrderList({ aisles, onMove, header }: Props) {
  const { spacing, sizes, rounded, colors } = useTheme();
  const reduceMotion = useReducedMotion();
  const [rowHeight, setRowHeight] = useState<number>(sizes.aisleRow);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const slot = rowHeight + spacing.sm;
  const count = aisles.length;

  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const viewportTop = useSharedValue(0);
  const viewportHeight = useSharedValue(0);
  const contentHeight = useSharedValue(0);
  const drag: Drag = {
    activeId: useSharedValue<string | null>(null),
    positions: useSharedValue<Record<string, number>>({}),
    activeTop: useSharedValue(0),
    startTop: useSharedValue(0),
    translation: useSharedValue(0),
    startScroll: useSharedValue(0),
    scroll: useScrollOffset(scrollRef),
    fingerY: useSharedValue(0),
    from: useSharedValue(0),
  };
  const { activeId, positions } = drag;

  // Follow the stored order. After a drop it already matches, so nothing jumps.
  const idsKey = aisles.map((a) => a.id).join('|');
  useEffect(() => {
    positions.set(Object.fromEntries(idsKey.split('|').map((id, i) => [id, i])));
  }, [idsKey, positions]);

  // The dragged row follows the finger and the auto-scroll.
  useAnimatedReaction(
    () =>
      activeId.get() === null
        ? null
        : drag.startTop.get() + drag.translation.get() + drag.scroll.get() - drag.startScroll.get(),
    (next) => {
      if (next !== null) drag.activeTop.set(next);
    },
  );

  // Reflow the other rows when the dragged one crosses into another slot.
  useAnimatedReaction(
    () => (activeId.get() === null ? null : dropIndex(0, drag.activeTop.get(), slot, count)),
    (target) => {
      const id = activeId.get();
      if (target === null || id === null) return;
      const map = positions.get();
      const current = map[id];
      if (current === undefined || current === target) return;
      const ordered = Object.keys(map).sort((a, b) => map[a] - map[b]);
      const next: Record<string, number> = {};
      moveId(ordered, current, target).forEach((key, i) => {
        next[key] = i;
      });
      positions.set(next);
    },
    [slot, count],
  );

  // Scroll while the finger is near the top or bottom edge.
  useFrameCallback(() => {
    if (activeId.get() === null) return;
    const step = autoScrollStep(drag.fingerY.get() - viewportTop.get(), viewportHeight.get(), EDGE, MAX_STEP);
    if (step === 0) return;
    const max = Math.max(0, contentHeight.get() - viewportHeight.get());
    const next = Math.min(max, Math.max(0, drag.scroll.get() + step));
    if (next !== drag.scroll.get()) scrollTo(scrollRef, 0, next, false);
  });

  const startDrag = (id: string) => {
    'worklet';
    const window = measure(scrollRef);
    if (window) {
      viewportTop.set(window.pageY);
      viewportHeight.set(window.height);
    }
    const index = positions.get()[id] ?? 0;
    drag.from.set(index);
    drag.startTop.set(index * slot);
    drag.activeTop.set(index * slot);
    drag.translation.set(0);
    drag.startScroll.set(drag.scroll.get());
    activeId.set(id);
    scheduleOnRN(setDraggingId, id);
  };

  const endDrag = (id: string) => {
    'worklet';
    if (activeId.get() !== id) return;
    const from = drag.from.get();
    const to = positions.get()[id] ?? from;
    activeId.set(null);
    scheduleOnRN(setDraggingId, null);
    if (from !== to) scheduleOnRN(onMove, from, to);
  };

  const moveByAccessibility = (index: number, to: number) => {
    onMove(index, to);
    AccessibilityInfo.announceForAccessibility(`Moved to ${to + 1} of ${count}`);
  };

  // The dashed slot the dragged row will drop into.
  const slotStyle = useAnimatedStyle(() => {
    const id = activeId.get();
    const index = id === null ? 0 : (positions.get()[id] ?? 0);
    return { opacity: id === null ? 0 : 1, top: index * slot };
  });

  const containerHeight = useMemo(() => Math.max(0, count * slot - spacing.sm), [count, slot, spacing.sm]);

  return (
    <Animated.ScrollView
      ref={scrollRef}
      scrollEnabled={draggingId === null}
      contentInsetAdjustmentBehavior="automatic"
      onLayout={(e) => viewportHeight.set(e.nativeEvent.layout.height)}
      onContentSizeChange={(_, h) => contentHeight.set(h)}
      contentContainerStyle={{ paddingBottom: spacing.xl }}>
      {header}
      <View style={{ height: containerHeight, marginHorizontal: spacing.lg }}>
        <Animated.View
          pointerEvents="none"
          style={[
            styles.absolute,
            slotStyle,
            {
              height: rowHeight,
              borderRadius: rounded.row,
              borderWidth: sizes.checkBorder,
              borderStyle: 'dashed',
              borderColor: colors.controlBorder,
            },
          ]}
        />
        {aisles.map((aisle, index) => (
          <AisleRow
            key={aisle.id}
            aisle={aisle}
            index={index}
            count={count}
            slot={slot}
            rowHeight={rowHeight}
            dragging={draggingId === aisle.id}
            reduceMotion={reduceMotion}
            drag={drag}
            onStart={startDrag}
            onEnd={endDrag}
            onMeasure={(h) => setRowHeight((prev) => (h > prev ? h : prev))}
            onAccessibilityMove={moveByAccessibility}
          />
        ))}
      </View>
    </Animated.ScrollView>
  );
}

type RowProps = {
  aisle: AisleOrderItem;
  index: number;
  count: number;
  slot: number;
  rowHeight: number;
  dragging: boolean;
  reduceMotion: boolean;
  drag: Drag;
  onStart: (id: string) => void;
  onEnd: (id: string) => void;
  onMeasure: (height: number) => void;
  onAccessibilityMove: (from: number, to: number) => void;
};

function AisleRow({
  aisle,
  index,
  count,
  slot,
  rowHeight,
  dragging,
  reduceMotion,
  drag,
  onStart,
  onEnd,
  onMeasure,
  onAccessibilityMove,
}: RowProps) {
  const { colors, aisles, spacing, sizes, rounded, shadows, motion } = useTheme();
  const look = aisleRowLook(dragging, aisleColor(aisle.slug), colors, aisles);
  const { id } = aisle;
  const top = useSharedValue(index * slot);
  const { activeId, positions } = drag;

  // Settle into the row's slot: springing while another row is dragged, jumping otherwise.
  useAnimatedReaction(
    () => (positions.get()[id] ?? index) * slot,
    (target, previous) => {
      if (activeId.get() === id) return;
      top.set(previous !== null && activeId.get() !== null && !reduceMotion ? withSpring(target, motion.spring) : target);
    },
    [id, index, slot, reduceMotion],
  );

  const style = useAnimatedStyle(() => {
    const active = activeId.get() === id;
    const scale = active && !reduceMotion ? LIFT_SCALE : 1;
    return {
      top: active ? drag.activeTop.get() : top.get(),
      zIndex: active ? 1 : 0,
      transform: [{ scale: reduceMotion ? scale : withSpring(scale, motion.spring) }],
    };
  });

  const gesture = Gesture.Pan()
    .activateAfterLongPress(motion.duration)
    .onStart(() => onStart(id))
    .onUpdate((e) => {
      drag.translation.set(e.translationY);
      drag.fingerY.set(e.absoluteY);
    })
    .onFinalize(() => {
      if (activeId.get() !== id) return;
      // Land from where the finger let go.
      const landing = (positions.get()[id] ?? index) * slot;
      top.set(drag.activeTop.get());
      top.set(reduceMotion ? landing : withSpring(landing, motion.spring));
      onEnd(id);
    });

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        accessible
        accessibilityLabel={aisleRowLabel(aisle.name, index, count)}
        accessibilityHint="Touch and hold, then drag to move"
        accessibilityActions={aisleRowActions(index, count)}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'moveUp') onAccessibilityMove(index, index - 1);
          if (e.nativeEvent.actionName === 'moveDown') onAccessibilityMove(index, index + 1);
        }}
        onLayout={(e) => onMeasure(e.nativeEvent.layout.height)}
        style={[
          styles.absolute,
          styles.row,
          {
            minHeight: rowHeight,
            gap: spacing.md,
            paddingHorizontal: spacing.md + spacing.xxs,
            borderRadius: rounded.row,
            backgroundColor: look.fill,
          },
          dragging && {
            ...shadows.lifted,
            shadowColor: colors.ink,
            outlineWidth: sizes.checkBorder,
            outlineColor: look.outline ?? undefined,
            outlineStyle: 'solid',
          },
          style,
        ]}>
        <View style={{ width: sizes.dot, height: sizes.dot, borderRadius: rounded.full, backgroundColor: look.dot }} />
        <ThemedText
          variant={dragging ? 'headline' : 'body'}
          numberOfLines={2}
          style={[styles.name, !dragging && styles.semibold, { paddingVertical: spacing.sm }]}>
          {aisle.name}
        </ThemedText>
        <View style={[styles.grip, { width: sizes.grip }]}>
          <Icon name="line.3.horizontal" size={sizes.icon} color={look.grip} />
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  absolute: { position: 'absolute', left: 0, right: 0 },
  row: { flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
  name: { flex: 1 },
  semibold: { fontWeight: '600' },
  grip: { alignItems: 'center' },
});
