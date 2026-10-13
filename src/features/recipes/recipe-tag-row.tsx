import { Pressable, StyleSheet, View } from 'react-native';

import { recipeTagPillColors } from '@/components/appearance';
import { Pill } from '@/components/pill';
import { ThemedText } from '@/components/themed-text';
import type { AisleHue } from '@/domain/aisle-color';
import { recipeTagPills, showImportTagsNote } from '@/features/recipes/recipe-tags-view';
import { useTheme } from '@/hooks/use-theme';
import type { RecipeTags } from '@/shared/recipe-tags';

export const IMPORT_TAGS_NOTE = 'Tagged when you imported it';

/**
 * The recipe band's tags (spec 4.14, mockup D): a wrapping row of pills, each its facet over its
 * value, then the time bucket, then a dashed "+ Tags". Untagged, only "Add tags". Every pill opens
 * the Tags sheet (`onEdit`). Under the row, while the import's tags are unedited, a note says so.
 * Untagged and given `onSuggest` (the plan has `recipe_tags` and there are ingredients), a dashed
 * "Suggest tags" follows "Add tags" and opens the sheet suggesting.
 */
export function RecipeTagRow({
  recipe,
  hue,
  onEdit,
  onSuggest,
}: {
  recipe: { tags: RecipeTags | null; tagsEdited: boolean; totalMinutes: number | null };
  hue: AisleHue;
  onEdit: () => void;
  onSuggest?: () => void;
}) {
  const { colors, aisles, spacing, sizes, rounded, opacity } = useTheme();
  const pills = recipeTagPills(recipe.tags, recipe.totalMinutes);
  const look = recipeTagPillColors(hue, colors, aisles);

  return (
    <View style={{ gap: spacing.xs }}>
      <View style={[styles.wrap, { gap: spacing.sm }]}>
        {pills.map((pill) => (
          <Pressable
            key={pill.key}
            accessibilityRole="button"
            accessibilityLabel={pill.accessibilityLabel}
            accessibilityHint="Edits the tags"
            onPress={onEdit}
            style={({ pressed }) => [
              styles.tag,
              {
                minHeight: sizes.minTapTarget,
                paddingHorizontal: spacing.md,
                paddingVertical: spacing.xs,
                borderRadius: rounded.md,
                backgroundColor: look.fill,
                opacity: pressed ? opacity.pressed : 1,
              },
            ]}>
            <ThemedText variant="caption" style={{ color: look.facet }}>
              {pill.facet}
            </ThemedText>
            <ThemedText variant="amount" style={{ color: look.text }}>
              {pill.value}
            </ThemedText>
          </Pressable>
        ))}
        <View style={styles.center}>
          <Pill
            dashed
            label={pills.length ? '+ Tags' : 'Add tags'}
            accessibilityLabel={pills.length ? 'Edit tags' : 'Add tags'}
            onPress={onEdit}
          />
        </View>
        {!pills.length && onSuggest ? (
          <View style={styles.center}>
            <Pill
              dashed
              icon="sparkles"
              label="Suggest tags"
              accessibilityHint="Opens the tags, with AI suggestions."
              onPress={onSuggest}
            />
          </View>
        ) : null}
      </View>
      {showImportTagsNote(recipe) ? (
        <ThemedText variant="footnote" color="inkSecondary">
          {IMPORT_TAGS_NOTE}
        </ThemedText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'stretch' },
  tag: { justifyContent: 'center', borderCurve: 'continuous' },
  center: { justifyContent: 'center' },
});
