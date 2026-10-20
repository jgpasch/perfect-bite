import { Pressable, StyleSheet, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated from 'react-native-reanimated';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import type { RecipeIngredient } from '@/db';
import { formatAmount } from '@/domain/quantity-display';
import { useMotion } from '@/hooks/use-motion';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';
import { displayItemName } from '@/shared';

type Props = {
  ingredient: RecipeIngredient;
  /** The ingredient's aisle `dot` colour. */
  dotColor: string;
  /** The amount to show in place of the ingredient's own, e.g. scaled to other servings. */
  amount?: string;
  onEdit: () => void;
  onDelete: () => void;
  /** Long-press, and VoiceOver's "Add to a list" action: the menu of lists to add it to (spec 4.5). */
  onAddToList: () => void;
  /** `card` (default): the Ingredients card's row. `indexCard`: the index card view's row (board F). */
  layout?: 'card' | 'indexCard';
  /** The index card's amount column width (the widest amount, measured); none until it's measured. */
  amountWidth?: number;
};

/**
 * A recipe ingredient in the Ingredients card: aisle dot, name, amount. Tap to edit, long-press to add it to a list,
 * swipe left to delete. In the index card view (`layout="indexCard"`) it has no dot or hairline and sits on the
 * screen's `background`: the amount first, right-aligned in its column (`amountWidth`), then the name and its note.
 */
export function RecipeIngredientRow({
  ingredient,
  dotColor,
  amount: shown,
  onEdit,
  onDelete,
  onAddToList,
  layout: rowLayout = 'card',
  amountWidth,
}: Props) {
  const t = useT();
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const { entering, exiting, layout } = useMotion();
  const amount = shown ?? formatAmount(ingredient);
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
          onLongPress={onAddToList}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint={t('recipes.screen.ingredientHint')}
          accessibilityActions={[
            { name: 'addToList', label: t('recipes.screen.addIngredientToList') },
            { name: 'delete', label: t('common.delete') },
          ]}
          onAccessibilityAction={({ nativeEvent }) => {
            if (nativeEvent.actionName === 'addToList') onAddToList();
            if (nativeEvent.actionName === 'delete') onDelete();
          }}
          style={({ pressed }) => [
            styles.row,
            rowLayout === 'indexCard'
              ? {
                  minHeight: sizes.minTapTarget,
                  paddingHorizontal: spacing.lg + spacing.xs,
                  paddingVertical: spacing.xs,
                  gap: spacing.md,
                  backgroundColor: colors.background,
                  opacity: pressed ? opacity.pressed : 1,
                }
              : {
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
          {rowLayout === 'indexCard' ? (
            <>
              <ThemedText
                testID="ingredient-amount"
                variant="body"
                color="inkSecondary"
                style={[styles.amount, amountWidth === undefined ? null : { width: amountWidth }]}>
                {amount}
              </ThemedText>
              <ThemedText variant="body" style={styles.text}>
                {name}
                {ingredient.note ? <ThemedText variant="body" color="inkSecondary">{` ${ingredient.note}`}</ThemedText> : null}
              </ThemedText>
            </>
          ) : (
            <>
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
            </>
          )}
        </Pressable>
      </ReanimatedSwipeable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  text: { flex: 1 },
  amount: { textAlign: 'right' },
  action: { flex: 1, alignItems: 'flex-end', justifyContent: 'center' },
});
