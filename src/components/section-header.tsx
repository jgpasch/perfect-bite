import { useEffect, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { sectionHeaderLabel } from '@/components/appearance';
import { Collapsible } from '@/components/collapsible';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Motion, type Spacing } from '@/constants/theme';
import { useMotion } from '@/hooks/use-motion';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  title: string;
  /** The aisle's `dot` colour, from `aisles[aisleColor(slug)].dot`. */
  dotColor?: string;
  /** Shown in place of the dot, e.g. a recipe's icon well. */
  leading?: ReactNode;
  /** The count on the right. */
  count?: number;
  /** Reads the count to VoiceOver without showing it, e.g. on an open recipe card. */
  hideCount?: boolean;
  /** Shown after the count, e.g. a recipe's actions button. It keeps its own tap and doesn't toggle. */
  trailing?: ReactNode;
  /** What VoiceOver reads instead of the title, e.g. for the Sorting… section. */
  accessibilityLabel?: string;
  /** Makes the header a button that folds the card's rows away (spec 4.6), with a chevron. Use `FoldingSection`. */
  onToggle?: () => void;
  collapsed?: boolean;
};

/** A card's section header: aisle dot, the name in the display face, and the count on the right. */
export function SectionHeader({
  title,
  dotColor,
  leading,
  count,
  hideCount = false,
  trailing,
  accessibilityLabel,
  onToggle,
  collapsed = false,
}: Props) {
  const { spacing, sizes, rounded, opacity } = useTheme();
  const label = sectionHeaderLabel(accessibilityLabel ?? title, count);
  const { paddingTop, paddingBottom } = headerPadding(spacing);
  const content = (
    <>
      {leading ??
        (dotColor ? (
          <View style={{ width: sizes.dot, height: sizes.dot, borderRadius: rounded.full, backgroundColor: dotColor }} />
        ) : null)}
      <ThemedText
        variant="sectionTitle"
        accessibilityRole={onToggle ? undefined : 'header'}
        accessibilityLabel={onToggle ? undefined : label}
        style={styles.title}>
        {title}
      </ThemedText>
      {count !== undefined && !hideCount ? (
        <ThemedText
          variant="footnote"
          color="inkSecondary"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.count}>
          {count}
        </ThemedText>
      ) : null}
    </>
  );

  if (!onToggle) {
    return (
      <View style={[styles.row, { gap: spacing.sm, paddingTop, paddingBottom, paddingHorizontal: spacing.lg }]}>
        {content}
        {trailing}
      </View>
    );
  }

  return (
    <View style={[styles.row, { gap: spacing.sm, paddingRight: trailing ? spacing.lg : 0 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
        accessibilityLabel={label}
        onPress={onToggle}
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
        <Chevron collapsed={collapsed} size={sizes.iconSmall} />
      </Pressable>
      {trailing}
    </View>
  );
}

type FoldingSectionProps = Omit<Props, 'onToggle' | 'collapsed'> & {
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
};

/** A card's foldable section (spec 4.6): its header, then its rows, which spring open and folded. */
export function FoldingSection({ collapsed, children, ...header }: FoldingSectionProps) {
  const { spacing } = useTheme();
  const { paddingTop, paddingBottom } = headerPadding(spacing);
  return (
    <>
      <SectionHeader {...header} collapsed={collapsed} />
      {/* A folded card is just its header, so it sits in the middle. */}
      <Collapsible open={!collapsed} closedHeight={paddingTop - paddingBottom}>
        {children}
      </Collapsible>
    </>
  );
}

function headerPadding(spacing: typeof Spacing) {
  return { paddingTop: spacing.md + spacing.xxs, paddingBottom: spacing.xs + spacing.xxs };
}

/** Points down while open and turns to point right as the section folds. */
function Chevron({ collapsed, size }: { collapsed: boolean; size: number }) {
  const { reduceMotion } = useMotion();
  const turn = useSharedValue(collapsed ? 1 : 0);
  useEffect(() => {
    turn.value = reduceMotion ? (collapsed ? 1 : 0) : withSpring(collapsed ? 1 : 0, Motion.spring);
  }, [collapsed, reduceMotion, turn]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${-90 * turn.value}deg` }] }));
  return (
    <Animated.View style={style}>
      <Icon name="chevron.down" color="inkSecondary" size={size} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  toggle: { flex: 1 },
  title: { flex: 1 },
  count: { fontWeight: '600' },
});
