import * as Haptics from 'expo-haptics';
import { useEffect, useRef, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import ReanimatedSwipeable, { SwipeDirection, type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, type SharedValue } from 'react-native-reanimated';

import { sectionHeaderLabel } from '@/components/appearance';
import { Collapsible, useFold } from '@/components/collapsible';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Motion, type Spacing } from '@/constants/theme';
import { useMotion } from '@/hooks/use-motion';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  title: string;
  /** The aisle's `dot` colour, from `aisles[aisleColor(slug)].dot`. */
  dotColor?: string;
  /**
   * Colours the whole header as a band in place of the dot: an aisle card whose rows aren't tinted
   * (`aisleHeaderBand`). The name, count and chevron take its `text`.
   */
  band?: { ground: string; text: string };
  /** The card's ground behind a header with no band, so a swipe's panel stays covered. Defaults to `surface`. */
  ground?: string;
  /** Shown in place of the dot, e.g. a recipe's icon well. */
  leading?: ReactNode;
  /** The count on the right. */
  count?: number;
  /** What the count counts, for VoiceOver: singular and plural. Defaults to items. */
  countUnit?: readonly [one: string, other: string];
  /** Reads the count to VoiceOver without showing it, e.g. on an open recipe card. */
  hideCount?: boolean;
  /** Shown after the count. It keeps its own tap and doesn't toggle. */
  trailing?: ReactNode;
  /** A folding header's long-press, e.g. a recipe's menu (spec 4.6). */
  onLongPress?: () => void;
  /** VoiceOver actions on a folding header, standing in for what its long-press offers. */
  actions?: { label: string; onPress: () => void }[];
  /** What VoiceOver reads instead of the title, e.g. for the Sorting… section. */
  accessibilityLabel?: string;
  /** Swipe right to check every row in the section (spec 4.6). */
  onSwipeCheck?: () => void;
  /** Swipe left to remove the section, e.g. a recipe from the list (spec 4.6). */
  onSwipeRemove?: () => void;
  /** Makes the header a button that folds the card's rows away (spec 4.6), with a chevron. Use `FoldingSection`. */
  onToggle?: () => void;
  collapsed?: boolean;
};

/**
 * A card's section header: aisle dot, the name in the display face, and the count on the right.
 * With `onSwipeCheck` or `onSwipeRemove` it swipes too.
 */
export function SectionHeader({ onSwipeCheck, onSwipeRemove, ...header }: Props) {
  return (
    <Swipe band={header.band} ground={header.ground} onCheck={onSwipeCheck} onRemove={onSwipeRemove}>
      <HeaderBody {...header} />
    </Swipe>
  );
}

function HeaderBody({
  title,
  dotColor,
  band,
  leading,
  count,
  countUnit,
  hideCount = false,
  trailing,
  onLongPress,
  actions,
  accessibilityLabel,
  onToggle,
  collapsed = false,
}: Omit<Props, 'onSwipeCheck' | 'onSwipeRemove'>) {
  const { spacing, sizes, rounded, opacity } = useTheme();
  const label = sectionHeaderLabel(accessibilityLabel ?? title, count, countUnit);
  const { paddingTop, paddingBottom } = headerPadding(spacing, !!band);
  const bandText = band ? { color: band.text } : undefined;
  const content = (
    <>
      {leading ??
        (dotColor && !band ? (
          <View style={{ width: sizes.dot, height: sizes.dot, borderRadius: rounded.full, backgroundColor: dotColor }} />
        ) : null)}
      <ThemedText
        variant="sectionTitle"
        accessibilityRole={onToggle ? undefined : 'header'}
        accessibilityLabel={onToggle ? undefined : label}
        style={[styles.title, bandText]}>
        {title}
      </ThemedText>
      {count !== undefined && !hideCount ? (
        <ThemedText
          variant="footnote"
          color="inkSecondary"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[styles.count, bandText]}>
          {count}
        </ThemedText>
      ) : null}
    </>
  );

  if (!onToggle) {
    return (
      <View
        style={[
          styles.row,
          { gap: spacing.sm, paddingTop, paddingBottom, paddingHorizontal: spacing.lg, backgroundColor: band?.ground },
        ]}>
        {content}
        {trailing}
      </View>
    );
  }

  return (
    <View style={[styles.row, { gap: spacing.sm, paddingRight: trailing ? spacing.lg : 0, backgroundColor: band?.ground }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
        accessibilityLabel={label}
        accessibilityActions={actions?.map((a) => ({ name: a.label, label: a.label }))}
        onAccessibilityAction={(e) => actions?.find((a) => a.label === e.nativeEvent.actionName)?.onPress()}
        onPress={onToggle}
        onLongPress={onLongPress}
        style={({ pressed }) => [
          styles.row,
          styles.toggle,
          {
            gap: spacing.sm,
            minHeight: sizes.minTapTarget,
            paddingTop,
            paddingBottom,
            paddingLeft: spacing.lg,
            paddingRight: trailing ? 0 : spacing.lg,
            opacity: pressed ? opacity.pressed : 1,
          },
        ]}>
        {content}
        <Chevron collapsed={collapsed} size={sizes.iconSmall} tint={band?.text} />
      </Pressable>
      {trailing}
    </View>
  );
}

/**
 * A header's swipes: right to check all (a `primary` panel with a check), left to remove (`danger`, a
 * trash can). A full swipe does it and the header springs back; removing plays a light haptic, and
 * checking leaves the haptic to `onCheck` (the check-off tick, spec 4.1). The header
 * takes the card's ground (or its band) so it covers the panel.
 */
function Swipe({
  band,
  ground,
  onCheck,
  onRemove,
  children,
}: {
  band?: { ground: string };
  ground?: string;
  onCheck?: () => void;
  onRemove?: () => void;
  children: ReactNode;
}) {
  const { colors, spacing } = useTheme();
  const ref = useRef<SwipeableMethods>(null);
  if (!onCheck && !onRemove) return children;
  return (
    <ReanimatedSwipeable
      ref={ref}
      // Follows the finger, and only a swipe past half the row commits (the default threshold).
      friction={1}
      overshootLeft={false}
      overshootRight={false}
      childrenContainerStyle={{ backgroundColor: band?.ground ?? ground ?? colors.surface }}
      onSwipeableOpen={(direction) => {
        ref.current?.close();
        // Checking plays its own tick (spec 4.1), from `onCheck`, so it isn't doubled here.
        if (direction === SwipeDirection.RIGHT) return onCheck?.();
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onRemove?.();
      }}
      renderLeftActions={
        onCheck
          ? () => (
              <View style={[styles.action, styles.leading, { backgroundColor: colors.primary, paddingHorizontal: spacing.xl }]}>
                <Icon name="checkmark" color="onPrimary" weight="bold" />
              </View>
            )
          : undefined
      }
      renderRightActions={
        onRemove
          ? () => (
              <View style={[styles.action, styles.trailing, { backgroundColor: colors.danger, paddingHorizontal: spacing.xl }]}>
                <Icon name="trash" color="onPrimary" />
              </View>
            )
          : undefined
      }>
      {children}
    </ReanimatedSwipeable>
  );
}

type FoldingSectionProps = Omit<Props, 'onToggle' | 'collapsed'> & {
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
};

/** A card's foldable section (spec 4.6): its header, then its rows, which spring open and folded. */
export function FoldingSection({ collapsed, children, onSwipeCheck, onSwipeRemove, ...header }: FoldingSectionProps) {
  const { spacing } = useTheme();
  const { paddingTop, paddingBottom } = headerPadding(spacing, !!header.band);
  const progress = useFold(!collapsed);
  return (
    <>
      <Swipe band={header.band} ground={header.ground} onCheck={onSwipeCheck} onRemove={onSwipeRemove}>
        <HeaderBody {...header} collapsed={collapsed} />
        {/* A folded card is just its header, so it sits in the middle. The extra room is part of the
            header, so a swipe's panel fills the folded card. */}
        <FoldGap height={paddingTop - paddingBottom} open={!collapsed} progress={progress} />
      </Swipe>
      <Collapsible open={!collapsed} progress={progress}>
        {children}
      </Collapsible>
    </>
  );
}

/** The room under a folded header, which closes as the rows open beneath it. */
function FoldGap({ height, open, progress }: { height: number; open: boolean; progress: SharedValue<number> }) {
  const { reduceMotion } = useMotion();
  // Under Reduce Motion the rows' height snaps, so this does too.
  const style = useAnimatedStyle(() => ({ height: height * (1 - (reduceMotion ? (open ? 1 : 0) : progress.value)) }));
  return <Animated.View style={style} />;
}

/** A band is padded evenly, so it is the whole card when folded; a plain header sits closer to its rows. */
function headerPadding(spacing: typeof Spacing, band = false) {
  if (band) return { paddingTop: spacing.md, paddingBottom: spacing.md };
  return { paddingTop: spacing.md + spacing.xxs, paddingBottom: spacing.xs + spacing.xxs };
}

/** Points down while open and turns to point right as the section folds. */
function Chevron({ collapsed, size, tint }: { collapsed: boolean; size: number; tint?: string }) {
  const { reduceMotion } = useMotion();
  const turn = useSharedValue(collapsed ? 1 : 0);
  useEffect(() => {
    turn.value = reduceMotion ? (collapsed ? 1 : 0) : withSpring(collapsed ? 1 : 0, Motion.spring);
  }, [collapsed, reduceMotion, turn]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${-90 * turn.value}deg` }] }));
  return (
    <Animated.View style={style}>
      <Icon name="chevron.down" color="inkSecondary" tint={tint} size={size} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  toggle: { flex: 1 },
  title: { flex: 1 },
  count: { fontWeight: '600' },
  action: { flex: 1, justifyContent: 'center' },
  leading: { alignItems: 'flex-start' },
  trailing: { alignItems: 'flex-end' },
});
