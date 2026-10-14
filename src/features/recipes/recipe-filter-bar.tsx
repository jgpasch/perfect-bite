import { Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/icon';
import { Pill } from '@/components/pill';
import { ThemedText } from '@/components/themed-text';
import {
  activeFilterCount,
  filtersPillAccessibilityLabel,
  filtersPillLabel,
  recipeFilterChips,
  type FilterChip,
  type RecipeFilters,
} from '@/features/recipes/recipe-filters';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/**
 * Under the Recipes tab's search field (spec 4.14): the Filters pill ("Filters · 2", filled
 * `primary` while some are on), then a chip per active filter ("Dinner ✕") that removes it. Wraps.
 */
export function RecipeFilterBar({
  filters,
  onOpen,
  onRemove,
}: {
  filters: RecipeFilters;
  onOpen: () => void;
  onRemove: (chip: FilterChip) => void;
}) {
  const t = useT();
  const { spacing } = useTheme();
  const count = activeFilterCount(filters);
  return (
    <View style={[styles.row, { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.xs }]}>
      <Pill
        label={filtersPillLabel(count)}
        accessibilityLabel={filtersPillAccessibilityLabel(count)}
        accessibilityHint={t('recipes.filters.pillHint')}
        selected={count > 0}
        primary
        onPress={onOpen}
      />
      {recipeFilterChips(filters).map((chip) => (
        <RemovableChip key={chip.key} chip={chip} onPress={() => onRemove(chip)} />
      ))}
    </View>
  );
}

function RemovableChip({ chip, onPress }: { chip: FilterChip; onPress: () => void }) {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={chip.accessibilityLabel}
      hitSlop={(sizes.minTapTarget - sizes.pill) / 2}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          minHeight: sizes.pill,
          gap: spacing.xs + spacing.xxs,
          paddingHorizontal: spacing.md + spacing.xxs,
          borderRadius: rounded.full,
          backgroundColor: colors.surface,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <ThemedText variant="amount">{chip.label}</ThemedText>
      <Icon name="xmark" size={sizes.iconSmall} color="inkSecondary" weight="bold" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
});
