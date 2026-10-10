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
import { checkOffLabel, itemRowLabel, SORTING_LABEL, toggleActionLabel } from './list-view';

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

/**
 * A list item in a card (spec 4.2): tap the check to check it off, tap the rest of the row to open its
 * details, swipe left to delete. While selecting, a tap anywhere on the row selects it.
 */
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
  const label = itemRowLabel({ name: item.displayName, amountText, note: item.note, hint }, sorting && !checked);

  const rowStyle = [
    styles.row,
    {
      minHeight: sizes.cardRowMin,
      paddingLeft: spacing.lg,
      gap: spacing.md,
      backgroundColor: tint ?? background,
      borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
  ];

  // Name, second line, amount: everything but the check.
  const content = (
    <>
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
        <ThemedText variant="amount" color="inkSecondary">
          {amountText}
        </ThemedText>
      ) : null}
      {sorting && !checked ? (
        <ThemedText variant="sectionLabel" color="pending">
          {SORTING_LABEL}
        </ThemedText>
      ) : null}
    </>
  );

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
        {selecting ? (
          <Pressable
            onPress={onToggle}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            accessibilityLabel={label}
            accessibilityHint="Double-tap to select"
            style={({ pressed }) => [
              rowStyle,
              { paddingRight: spacing.lg, paddingVertical: spacing.sm, opacity: pressed ? opacity.pressed : 1 },
            ]}>
            <CheckCircle checked={on} pending={sorting} />
            <View style={[styles.body, { gap: spacing.md }]}>{content}</View>
          </Pressable>
        ) : (
          <View style={rowStyle}>
            <CheckCircle checked={checked} pending={sorting} onPress={onToggle} accessibilityLabel={checkOffLabel(item.displayName)} />
            <Pressable
              onPress={onEdit}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityHint="Opens details"
              accessibilityActions={[
                { name: 'edit', label: 'Edit' },
                { name: 'delete', label: 'Delete' },
                { name: 'toggle', label: toggleActionLabel(checked) },
              ]}
              onAccessibilityAction={({ nativeEvent }) => {
                if (nativeEvent.actionName === 'edit') onEdit();
                if (nativeEvent.actionName === 'delete') onDelete();
                if (nativeEvent.actionName === 'toggle') onToggle();
              }}
              style={({ pressed }) => [
                styles.body,
                {
                  alignSelf: 'stretch',
                  minHeight: sizes.cardRowMin,
                  paddingRight: spacing.lg,
                  paddingVertical: spacing.sm,
                  gap: spacing.md,
                  opacity: pressed ? opacity.pressed : 1,
                },
              ]}>
              {content}
            </Pressable>
          </View>
        )}
      </ReanimatedSwipeable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  body: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  text: { flex: 1 },
  checked: { textDecorationLine: 'line-through' },
  action: { flex: 1, alignItems: 'flex-end', justifyContent: 'center' },
});
