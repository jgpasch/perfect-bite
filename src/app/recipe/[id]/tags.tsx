import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { prominentButtonTint } from '@/components/appearance';
import { Button } from '@/components/button';
import { Pill } from '@/components/pill';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import {
  facetAtMax,
  facetLimitLabel,
  parseTotalTime,
  splitTotalMinutes,
  toggleTag,
} from '@/features/recipes/recipe-tags-view';
import { getRecipe, updateRecipeTags } from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';
import { emptyRecipeTags, RECIPE_TAG_FACETS, RecipeTagsSchema } from '@/shared/recipe-tags';

/**
 * The Tags sheet (spec 4.14): one group of toggle pills per facet, capped at its maximum, then the
 * total time. Save writes the tags, the time and `tagsEdited` in one update; Cancel writes nothing.
 */
export default function RecipeTagsSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, spacing, scheme } = useTheme();

  // A sheet is short-lived: read once rather than live. The stored tags, unknown slugs included, so Save keeps them.
  const [recipe] = useState(() => getRecipe(id));
  const [tags, setTags] = useState(() => RecipeTagsSchema.safeParse(recipe?.tags).data ?? emptyRecipeTags());
  const [time, setTime] = useState(() => splitTotalMinutes(recipe?.totalMinutes ?? null));

  if (!recipe) return <Screen />;

  const parsedTime = parseTotalTime(time.hours, time.minutes);
  const save = () => {
    if (!parsedTime.ok) return;
    updateRecipeTags(recipe.id, tags, parsedTime.totalMinutes);
    router.back();
  };
  const inset = { paddingHorizontal: spacing.lg + spacing.xs };

  return (
    <Screen
      scroll
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: spacing.xs, paddingBottom: spacing.xxl, gap: spacing.lg }}>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>Cancel</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          variant="done"
          tintColor={prominentButtonTint(scheme, colors)}
          disabled={!parsedTime.ok}
          onPress={save}>
          Save
        </Stack.Toolbar.Button>
      </Stack.Toolbar>

      {RECIPE_TAG_FACETS.map((facet) => {
        const full = facetAtMax(tags, facet.key);
        const limit = facetLimitLabel(facet.max);
        return (
          <View key={facet.key} style={{ gap: spacing.sm }}>
            <View style={[styles.row, inset, { gap: spacing.sm }]}>
              <ThemedText variant="sectionLabel" color="inkSecondary" accessibilityRole="header" style={styles.flex}>
                {facet.label}
              </ThemedText>
              {full ? (
                <ThemedText variant="footnote" color="inkSecondary">
                  {limit}
                </ThemedText>
              ) : null}
            </View>
            <View style={[styles.row, styles.wrap, { gap: spacing.sm, paddingHorizontal: spacing.lg }]}>
              {facet.values.map((value) => {
                const on = tags[facet.key].includes(value.slug);
                const blocked = full && !on;
                return (
                  <Pill
                    key={value.slug}
                    label={value.label}
                    selected={on}
                    disabled={blocked}
                    accessibilityRole="togglebutton"
                    accessibilityState={{ checked: on }}
                    accessibilityHint={blocked ? `${facet.label} is full. ${limit}.` : undefined}
                    onPress={() => setTags((t) => toggleTag(t, facet.key, value.slug))}
                  />
                );
              })}
            </View>
          </View>
        );
      })}

      <View style={{ gap: spacing.sm }}>
        <View style={[styles.row, inset, { gap: spacing.sm }]}>
          <ThemedText variant="sectionLabel" color="inkSecondary" accessibilityRole="header" style={styles.flex}>
            Total time
          </ThemedText>
          {time.hours || time.minutes ? (
            <Button variant="plain" label="Clear" onPress={() => setTime({ hours: '', minutes: '' })} accessibilityLabel="Clear total time" />
          ) : null}
        </View>
        <View style={[styles.row, { gap: spacing.sm, paddingHorizontal: spacing.lg }]}>
          <TimeField
            label="hr"
            accessibilityLabel="Hours"
            value={time.hours}
            onChangeText={(hours) => setTime((t) => ({ ...t, hours }))}
          />
          <TimeField
            label="min"
            accessibilityLabel="Minutes"
            value={time.minutes}
            onChangeText={(minutes) => setTime((t) => ({ ...t, minutes }))}
          />
        </View>
        <ThemedText variant="footnote" color={parsedTime.ok ? 'inkSecondary' : 'danger'} style={inset}>
          {parsedTime.ok ? 'Optional' : parsedTime.error}
        </ThemedText>
      </View>
    </Screen>
  );
}

/** A number field with its unit after it: "[ 1 ] hr". */
function TimeField({
  label,
  accessibilityLabel,
  value,
  onChangeText,
}: {
  label: string;
  accessibilityLabel: string;
  value: string;
  onChangeText: (text: string) => void;
}) {
  const { spacing } = useTheme();
  return (
    <View style={[styles.row, styles.flex, { gap: spacing.sm }]}>
      <TextField
        value={value}
        onChangeText={onChangeText}
        keyboardType="number-pad"
        maxLength={4}
        placeholder="0"
        accessibilityLabel={accessibilityLabel}
        style={styles.flex}
      />
      <ThemedText variant="body" color="inkSecondary">
        {label}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexWrap: 'wrap' },
});
