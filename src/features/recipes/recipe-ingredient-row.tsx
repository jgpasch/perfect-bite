import { Pressable, StyleSheet, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated from 'react-native-reanimated';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import type { RecipeIngredient } from '@/db';
import { formatAmount } from '@/domain/quantity-display';
import { useMotion } from '@/hooks/use-motion';
import { useTheme } from '@/hooks/use-theme';
import { displayItemName } from '@/shared';

type Props = {
  ingredient: RecipeIngredient;
  /** The ingredient's aisle `dot` colour. */
  dotColor: string;
  onEdit: () => void;
  onDelete: () => void;
};

/** A recipe ingredient in the Ingredients card: aisle dot, name, amount. Tap to edit, swipe left to delete. */
export function RecipeIngredientRow({ ingredient, dotColor, onEdit, onDelete }: Props) {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const { entering, exiting, layout } = useMotion();
  const amount = formatAmount(ingredient);
  const name = displayItemName(ingredient.displayName);
  const label = [amount, name, ingredient.note].filter(Boolean).join(' ');

  return (
    <Animated.View entering={entering} exiting={exiting} layout={layout}>
      <ReanimatedSwipeable
        // Follows the finger, and only a swipe past half the row commits (the default threshold).
        friction={1}
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
              minHeight: sizes.cardRowMin,
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.sm,
              gap: spacing.md,
              // Every row has the hairline, the first one too, under the card's header (board 06).
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: colors.border,
              backgroundColor: colors.surface,
              opacity: pressed ? opacity.pressed : 1,
            },
          ]}>
          <View style={{ width: sizes.dot, height: sizes.dot, borderRadius: rounded.full, backgroundColor: dotColor }} />
          <View style={styles.text}>
            <ThemedText variant="body">{name}</ThemedText>
            {ingredient.note ? (
              <ThemedText variant="footnote" color="inkSecondary">
                {ingredient.note}
              </ThemedText>
            ) : null}
          </View>
          {amount ? (
            <ThemedText variant="amount" color="inkSecondary">
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
