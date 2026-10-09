import { Pressable, StyleSheet, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated from 'react-native-reanimated';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { useMotion } from '@/hooks/use-motion';
import { useTheme } from '@/hooks/use-theme';

import type { ItemView } from './items';

type Props = {
  item: ItemView;
  onToggle: () => void;
  onDelete: () => void;
  onEdit: () => void;
};

/** A list item: tap to check off, swipe left to delete, long-press to edit (spec 4.2). */
export function ItemRow({ item, onToggle, onDelete, onEdit }: Props) {
  const { colors, spacing, sizes, opacity } = useTheme();
  const { entering, exiting, layout } = useMotion();
  const checked = item.checkedAt !== null;

  const label = [item.displayName, item.amountText, item.note].filter(Boolean).join(', ');

  return (
    <Animated.View entering={entering} exiting={exiting} layout={layout}>
      <ReanimatedSwipeable
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
          onLongPress={onEdit}
          accessibilityRole="checkbox"
          accessibilityState={{ checked }}
          accessibilityLabel={label}
          accessibilityHint="Double-tap to check off"
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
              backgroundColor: colors.background,
              opacity: pressed ? opacity.pressed : 1,
            },
          ]}>
          <Icon
            name={checked ? 'checkmark.circle.fill' : 'circle'}
            color={checked ? 'primary' : 'inkSecondary'}
            size={sizes.iconLarge}
          />
          <View style={styles.text}>
            <ThemedText
              variant="body"
              color={checked ? 'inkSecondary' : 'ink'}
              style={checked ? styles.checked : undefined}>
              {item.displayName}
            </ThemedText>
            {item.note ? (
              <ThemedText variant="footnote" color="inkSecondary">
                {item.note}
              </ThemedText>
            ) : null}
          </View>
          {item.amountText ? (
            <ThemedText variant="callout" color="inkSecondary">
              {item.amountText}
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
