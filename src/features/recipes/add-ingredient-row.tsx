import { Pressable, StyleSheet } from 'react-native';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/**
 * The Ingredients card's last row (spec 4.5), and the index card view's: a `plus` and "Add ingredient" in `primary`
 * `headline`, 20 pt in, at least 52 pt (`addRow`) tall, with no hairline under it. It opens the add bar over the keyboard.
 */
export function AddIngredientRow({ onPress }: { onPress: () => void }) {
  const t = useT();
  const { colors, spacing, sizes, opacity } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('recipes.screen.addLabel')}
      testID="add-ingredient-row"
      style={({ pressed }) => [
        styles.row,
        {
          gap: spacing.sm,
          minHeight: sizes.addRow,
          paddingHorizontal: spacing.lg + spacing.xs,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <Icon name="plus" tint={colors.primary} weight="semibold" />
      <ThemedText variant="headline" color="primary">
        {t('recipes.screen.addIngredient')}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
});
