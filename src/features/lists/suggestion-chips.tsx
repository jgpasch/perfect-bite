import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { matchParts } from '@/domain/text-match';
import { recipeSuggestionLabel } from '@/features/recipes/recipe-view';
import { useTheme } from '@/hooks/use-theme';

import type { SuggestionChip } from './suggestions';

type Props = {
  chips: readonly SuggestionChip[];
  /** The typed name (amount left out), set in `primary` where a chip matches it. */
  typed: string;
  onPressItem: (chip: Extract<SuggestionChip, { kind: 'item' }>) => void;
  onPressRecipe: (chip: Extract<SuggestionChip, { kind: 'recipe' }>) => void;
  /** Long press on a household history chip: "Remove from suggestions". */
  onRemove: (chip: Extract<SuggestionChip, { kind: 'item' }>) => void;
};

/**
 * The keyboard's top row on a list (spec 4.2), in place of iOS's QuickType bar: one scrolling row of 32 pt chips,
 * autocomplete while typing (on an empty field `AddBar` shows the QuickType bar instead). Taps keep the keyboard up so
 * several can be added in a row. The row keeps its height when there are no chips, so the add field never jumps
 * while typing.
 */
export function SuggestionChips({ chips, typed, onPressItem, onPressRecipe, onRemove }: Props) {
  const { colors, spacing, sizes } = useTheme();
  return (
    <View
      style={{
        height: sizes.keyboardRow,
        backgroundColor: colors.keyboard,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.controlBorder,
      }}>
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        accessibilityLabel="Suggestions"
        contentContainerStyle={{ paddingHorizontal: spacing.sm, gap: spacing.sm, alignItems: 'center' }}>
      {chips.map((chip) =>
        chip.kind === 'recipe' ? (
          <Chip
            key={chip.key}
            label={chip.recipe.name}
            typed={typed}
            recipe
            accessibilityLabel={recipeSuggestionLabel(chip.recipe.name, chip.recipe.ingredientCount)}
            onPress={() => onPressRecipe(chip)}
          />
        ) : (
          <Chip
            key={chip.key}
            label={chip.label}
            typed={typed}
            accessibilityLabel={`Add ${chip.label}`}
            accessibilityHint={chip.removable ? 'Long press to remove from suggestions' : undefined}
            onPress={() => onPressItem(chip)}
            onLongPress={chip.removable ? () => onRemove(chip) : undefined}
          />
        ),
      )}
      </ScrollView>
    </View>
  );
}

function Chip({
  label,
  typed,
  recipe = false,
  accessibilityLabel,
  accessibilityHint,
  onPress,
  onLongPress,
}: {
  label: string;
  typed: string;
  /** A recipe: the fork-and-knife glyph and a `primary` outline. */
  recipe?: boolean;
  accessibilityLabel: string;
  accessibilityHint?: string;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const parts = matchParts(label, typed);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      onLongPress={onLongPress}
      hitSlop={{ top: (sizes.keyboardRow - sizes.keyboardChip) / 2, bottom: (sizes.keyboardRow - sizes.keyboardChip) / 2 }}
      style={({ pressed }) => [
        styles.chip,
        {
          height: sizes.keyboardChip,
          paddingHorizontal: spacing.md + spacing.xxs - sizes.chipBorder,
          gap: spacing.xs + spacing.xxs,
          borderRadius: rounded.full,
          backgroundColor: colors.keyboardChip,
          borderWidth: sizes.chipBorder,
          borderColor: recipe ? colors.primary : colors.keyboardChip,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      {recipe ? <Icon name="fork.knife" color="primary" weight="semibold" /> : null}
      <ThemedText variant="amount" numberOfLines={1}>
        {parts ? (
          <>
            {parts.before}
            <ThemedText variant="amount" color="primary" style={styles.match}>
              {parts.match}
            </ThemedText>
            {parts.after}
          </>
        ) : (
          label
        )}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
  match: { fontWeight: '700' },
});
