import { Pressable, StyleSheet, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated from 'react-native-reanimated';

import { itemNameColor } from '@/components/appearance';
import { CheckCircle } from '@/components/check-circle';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { useMotion } from '@/hooks/use-motion';
import { useTheme } from '@/hooks/use-theme';

import type { ItemView } from './items';
import { itemRowLabel, SORTING_LABEL } from './list-view';

type Props = {
  item: ItemView;
  /** The card's ground, so the row covers the swipe action behind it. */
  background: string;
  /** Set while the toast for an add that merged into this item shows (spec 4.4): its aisle's soft tint. */
  tint?: string;
  /** The first row in its card has no hairline above it. */
  first?: boolean;
  /** "Sorting…": waiting for an aisle. A dashed amber check and a "Sorting…" label. */
  sorting?: boolean;
  /** Overrides the item's total, e.g. one recipe's share in the By recipe view. */
  amountText?: string;
  /** A second line, e.g. "Also in Weeknight dal" (spec 4.6). */
  hint?: string;
  /** Select mode (spec 4.5): defined while selecting; taps then toggle selection. */
  selected?: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onEdit: () => void;
};

/** A list item in a card: tap to check off, swipe left to delete, long-press to edit (spec 4.2). */
export function ItemRow({
  item,
  background,
  tint,
  first,
  sorting = false,
  amountText = item.amountText,
  hint,
  selected,
  onToggle,
  onDelete,
  onEdit,
}: Props) {
  const { colors, spacing, sizes, opacity } = useTheme();
  const { entering, exiting, layout } = useMotion();
  const selecting = selected !== undefined;
  const checked = item.checkedAt !== null;
  const on = selecting ? selected : checked;
  const secondLine = [item.note, hint].filter(Boolean).join(' · ');

  return (
    <Animated.View entering={entering} exiting={exiting} layout={layout}>
      <ReanimatedSwipeable
        enabled={!selecting}
        friction={2}
        rightThreshold={sizes.rowMin}
        overshootRight={false}
        onSwipeableOpen={() => onDelete()}
        renderRightActions={() => (
          <View style={[styles.action, { backgroundColor: colors.danger, paddingHorizontal: spacing.xl }]}>
            <Icon name="trash" color="onPrimary" />
          </View>
        )}>
        <Pressable
          onPress={onToggle}
          onLongPress={selecting ? undefined : onEdit}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: on }}
          accessibilityLabel={itemRowLabel({ name: item.displayName, amountText, note: item.note, hint }, sorting && !checked)}
          accessibilityHint={selecting ? 'Double-tap to select' : 'Double-tap to check off'}
          accessibilityActions={[
            { name: 'edit', label: 'Edit' },
            { name: 'delete', label: 'Delete' },
          ]}
          onAccessibilityAction={({ nativeEvent }) => {
            if (nativeEvent.actionName === 'edit') onEdit();
            if (nativeEvent.actionName === 'delete') onDelete();
          }}
          style={({ pressed }) => [
            styles.row,
            {
              minHeight: sizes.cardRowMin,
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.sm,
              gap: spacing.md,
              backgroundColor: tint ?? background,
              borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
              borderTopColor: colors.border,
              opacity: pressed ? opacity.pressed : 1,
            },
          ]}>
          <CheckCircle checked={on} pending={sorting} />
          <View style={styles.text}>
            <ThemedText variant="body" color={itemNameColor(checked)} style={checked ? styles.checked : undefined}>
              {item.displayName}
            </ThemedText>
            {secondLine ? (
              <ThemedText variant="footnote" color="inkSecondary">
                {secondLine}
              </ThemedText>
            ) : null}
          </View>
          {amountText ? (
            <ThemedText variant="amount" color={checked ? 'inkTertiary' : 'inkSecondary'}>
              {amountText}
            </ThemedText>
          ) : null}
          {sorting && !checked ? (
            <ThemedText variant="sectionLabel" color="pending">
              {SORTING_LABEL}
            </ThemedText>
          ) : null}
        </Pressable>
      </ReanimatedSwipeable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  text: { flex: 1 },
  checked: { textDecorationLine: 'line-through' },
  action: { flex: 1, alignItems: 'flex-end', justifyContent: 'center' },
});
