import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, StyleSheet, View } from 'react-native';

import { prominentButtonTint } from '@/components/appearance';
import { Button } from '@/components/button';
import { Pill } from '@/components/pill';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { useFeature } from '@/features/plans/features';
import {
  applySuggestedTags,
  facetAtMax,
  facetLimitLabel,
  parseTotalTime,
  splitTotalMinutes,
  toggleTag,
} from '@/features/recipes/recipe-tags-view';
import { getRecipe, recipeIngredientsQuery, updateRecipeTags } from '@/features/recipes/recipes';
import {
  NOTHING_SUGGESTED_NOTE,
  suggestRecipeTags,
  SUGGESTED_NOTE,
  suggestTagsMessage,
} from '@/features/recipes/suggest-tags';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';
import { emptyRecipeTags, RECIPE_TAG_FACETS, RecipeTagsSchema } from '@/shared/recipe-tags';

type Suggestion =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'done'; note: string }
  | { status: 'error'; message: string };

/**
 * The Tags sheet (spec 4.14): one group of toggle pills per facet, capped at its maximum, then the
 * total time. Save writes the tags, the time and `tagsEdited` in one update; Cancel writes nothing.
 * With `recipe_tags`, Suggest tags fills the picks from the AI (never the time); nothing is saved
 * until Save. `suggest=1` (the recipe band's pill) starts it as the sheet opens.
 */
export default function RecipeTagsSheet() {
  const { id, suggest } = useLocalSearchParams<{ id: string; suggest?: string }>();
  const t = useT();
  const { colors, spacing, scheme } = useTheme();
  const canSuggest = useFeature('recipe_tags');

  // A sheet is short-lived: read once rather than live. The stored tags, unknown slugs included, so Save keeps them.
  const [recipe] = useState(() => getRecipe(id));
  const [hasIngredients] = useState(() => recipeIngredientsQuery(id).all().length > 0);
  const [tags, setTags] = useState(() => RecipeTagsSchema.safeParse(recipe?.tags).data ?? emptyRecipeTags());
  const [time, setTime] = useState(() => splitTotalMinutes(recipe?.totalMinutes ?? null));
  const [suggestion, setSuggestion] = useState<Suggestion>({ status: 'idle' });
  // Bumped by each call, Cancel and unmount: an answer for an older number is dropped.
  const run = useRef(0);

  const startSuggest = async () => {
    const mine = ++run.current;
    setSuggestion({ status: 'loading' });
    const result = await suggestRecipeTags(id);
    if (mine !== run.current) return;
    if (!result.ok) {
      const message = suggestTagsMessage(result.error);
      setSuggestion({ status: 'error', message });
      AccessibilityInfo.announceForAccessibility(message);
      return;
    }
    const fits = applySuggestedTags(emptyRecipeTags(), result.tags) !== null;
    if (fits) setTags((current) => applySuggestedTags(current, result.tags) ?? current);
    setSuggestion({ status: 'done', note: fits ? SUGGESTED_NOTE : NOTHING_SUGGESTED_NOTE });
    AccessibilityInfo.announceForAccessibility(fits ? t('recipes.tags.suggested') : NOTHING_SUGGESTED_NOTE);
  };

  // Opened from the recipe band's Suggest tags: start once, as the sheet opens.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || suggest !== '1' || !recipe || !canSuggest || !hasIngredients) return;
    autoStarted.current = true;
    void startSuggest();
  });
  useEffect(
    () => () => {
      run.current++;
    },
    [],
  );

  if (!recipe) return <Screen />;

  const parsedTime = parseTotalTime(time.hours, time.minutes);
  const save = () => {
    if (!parsedTime.ok) return;
    updateRecipeTags(recipe.id, tags, parsedTime.totalMinutes);
    router.back();
  };
  const cancel = () => {
    run.current++;
    router.back();
  };
  const inset = { paddingHorizontal: spacing.lg + spacing.xs };
  const loading = suggestion.status === 'loading';
  const suggestLine = !hasIngredients
    ? { text: suggestTagsMessage('no-ingredients'), color: 'inkSecondary' as const }
    : suggestion.status === 'done'
      ? { text: suggestion.note, color: 'inkSecondary' as const }
      : suggestion.status === 'error'
        ? { text: suggestion.message, color: 'danger' as const }
        : null;

  return (
    <Screen
      scroll
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: spacing.xs, paddingBottom: spacing.xxl, gap: spacing.lg }}>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={cancel}>{t('common.cancel')}</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          variant="done"
          tintColor={prominentButtonTint(scheme, colors)}
          disabled={!parsedTime.ok}
          onPress={save}>
          {t('recipes.tags.save')}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>

      {canSuggest ? (
        <View style={{ gap: spacing.sm }}>
          <View style={{ paddingHorizontal: spacing.lg }}>
            <Button
              icon="sparkles"
              loading={loading}
              disabled={loading || !hasIngredients}
              label={t(
                loading
                  ? 'recipes.tags.suggesting'
                  : suggestion.status === 'done'
                    ? 'recipes.tags.suggestAgain'
                    : 'recipes.tags.suggest',
              )}
              accessibilityLabel={t(loading ? 'recipes.tags.suggestingLabel' : 'recipes.tags.suggest')}
              accessibilityHint={t('recipes.tags.suggestHint')}
              onPress={() => void startSuggest()}
            />
          </View>
          {suggestLine ? (
            <ThemedText variant="footnote" color={suggestLine.color} style={inset}>
              {suggestLine.text}
            </ThemedText>
          ) : null}
        </View>
      ) : null}

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
                    accessibilityHint={blocked ? t('recipes.tags.full', { facet: facet.label, limit }) : undefined}
                    onPress={() => setTags((current) => toggleTag(current, facet.key, value.slug))}
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
            {t('recipes.tags.totalTime')}
          </ThemedText>
          {time.hours || time.minutes ? (
            <Button
              variant="plain"
              label={t('recipes.tags.clear')}
              onPress={() => setTime({ hours: '', minutes: '' })}
              accessibilityLabel={t('recipes.tags.clearTime')}
            />
          ) : null}
        </View>
        <View style={[styles.row, { gap: spacing.sm, paddingHorizontal: spacing.lg }]}>
          <TimeField
            label={t('recipes.tags.hr')}
            accessibilityLabel={t('recipes.tags.hours')}
            value={time.hours}
            onChangeText={(hours) => setTime((current) => ({ ...current, hours }))}
          />
          <TimeField
            label={t('recipes.tags.min')}
            accessibilityLabel={t('recipes.tags.minutes')}
            value={time.minutes}
            onChangeText={(minutes) => setTime((current) => ({ ...current, minutes }))}
          />
        </View>
        <ThemedText variant="footnote" color={parsedTime.ok ? 'inkSecondary' : 'danger'} style={inset}>
          {parsedTime.ok ? t('recipes.tags.optional') : parsedTime.error}
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
