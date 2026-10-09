import { Pressable, StyleSheet, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated from 'react-native-reanimated';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import type { RecipeIngredient } from '@/db';
import { formatAmount } from '@/domain/quantity-display';
import { useMotion } from '@/hooks/use-motion';
import { useTheme } from '@/hooks/use-theme';

type Props = { ingredient: RecipeIngredient; onEdit: () => void; onDelete: () => void };

/** A recipe ingredient: tap to edit, swipe left to delete. */
export function RecipeIngredientRow({ ingredient, onEdit, onDelete }: Props) {
  const { colors, spacing, sizes, opacity } = useTheme();
  const { entering, exiting, layout } = useMotion();
  const amount = formatAmount(ingredient);
  const label = [amount, ingredient.displayName, ingredient.note].filter(Boolean).join(' ');

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
          onPress={onEdit}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint="Double-tap to edit"
          accessibilityActions={[{ name: 'delete', label: 'Delete' }]}
          onAccessibilityAction={({ nativeEvent }) => nativeEvent.actionName === 'delete' && onDelete()}
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
          <View style={styles.text}>
            <ThemedText variant="body">{ingredient.displayName}</ThemedText>
            {ingredient.note ? (
              <ThemedText variant="footnote" color="inkSecondary">
                {ingredient.note}
              </ThemedText>
            ) : null}
          </View>
          {amount ? (
            <ThemedText variant="callout" color="inkSecondary">
              {amount}
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
  action: { flex: 1, alignItems: 'flex-end', justifyContent: 'center' },
});
