import { Pressable, StyleSheet, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated from 'react-native-reanimated';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { withAlpha } from '@/constants/theme';
import { useMotion } from '@/hooks/use-motion';
import { useTheme } from '@/hooks/use-theme';

import type { ItemView } from './items';

type Props = {
  item: ItemView;
  /** Briefly true after an add combined into this item (spec 4.4). */
  highlighted?: boolean;
  /** Overrides the item's total, e.g. one recipe's share in the By recipe view. */
  amountText?: string;
  /** A second line, e.g. "also in: Tacos" (spec 4.6). */
  hint?: string;
  /** Select mode (spec 4.5): defined while selecting; taps then toggle selection. */
  selected?: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onEdit: () => void;
};

/** A list item: tap to check off, swipe left to delete, long-press to edit (spec 4.2). */
export function ItemRow({
  item,
  highlighted,
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

  const label = [item.displayName, amountText, item.note, hint].filter(Boolean).join(', ');

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
          accessibilityLabel={label}
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
              minHeight: sizes.rowMin,
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.sm,
              gap: spacing.md,
              backgroundColor: highlighted ? withAlpha(colors.highlight, opacity.tint * 2) : colors.background,
              opacity: pressed ? opacity.pressed : 1,
            },
          ]}>
          <Icon
            name={on ? 'checkmark.circle.fill' : 'circle'}
            color={on ? 'primary' : 'inkSecondary'}
            size={sizes.iconLarge}
          />
          <View style={styles.text}>
            <ThemedText
              variant="body"
              color={checked ? 'inkSecondary' : 'ink'}
              style={checked ? styles.checked : undefined}>
              {item.displayName}
            </ThemedText>
            {item.note || hint ? (
              <ThemedText variant="footnote" color="inkSecondary">
                {[item.note, hint].filter(Boolean).join(' · ')}
              </ThemedText>
            ) : null}
          </View>
          {amountText ? (
            <ThemedText variant="callout" color="inkSecondary">
              {amountText}
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
