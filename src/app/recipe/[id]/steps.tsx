import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput } from 'react-native';

import { prominentButtonTint } from '@/components/appearance';
import { Card } from '@/components/card';
import { CheckCircle } from '@/components/check-circle';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { ensureStepMatch } from '@/features/recipes/ensure-step-match';
import { choiceHeadings, stepHeadingsInText, stepsFromText, stepsToText } from '@/features/recipes/recipe-view';
import { getRecipe, updateRecipeSteps } from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/** The field's minimum height, in lines of `body`: room for a few steps before it grows. */
const MIN_LINES = 12;

/**
 * The Steps sheet (board 16; step sections, board D): the recipe's method in one field, a step per
 * line, a `#` line a section heading. Save splits on line breaks, trims and drops empty lines; no step
 * left saves null. With two or more headings, the Choose one when cooking card ticks which are
 * `choice` sections, by the heading's text. Cancel writes nothing.
 */
export default function RecipeStepsSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useT();
  const { colors, spacing, typography, sizes, opacity, scheme } = useTheme();

  // A sheet is short-lived: read once rather than live.
  const [recipe] = useState(() => getRecipe(id));
  const [text, setText] = useState(() => stepsToText(recipe?.steps));
  // Ticked headings, by their text: renaming one drops its tick.
  const [choices, setChoices] = useState<ReadonlySet<string>>(() => choiceHeadings(recipe?.steps));

  if (!recipe) return <Screen />;

  const headings = stepHeadingsInText(text);
  const toggle = (heading: string) =>
    setChoices((current) => {
      const next = new Set(current);
      if (!next.delete(heading)) next.add(heading);
      return next;
    });
  const save = () => {
    updateRecipeSteps(recipe.id, stepsFromText(text, choices));
    void ensureStepMatch(recipe.id);
    router.back();
  };
  const inset = { paddingHorizontal: spacing.lg + spacing.xs };

  return (
    <Screen
      scroll
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: spacing.xs, paddingBottom: spacing.xxl, gap: spacing.md }}>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>{t('common.cancel')}</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button variant="done" tintColor={prominentButtonTint(scheme, colors)} onPress={save}>
          {t('recipes.tags.save')}
        </Stack.Toolbar.Button>
      </Stack.Toolbar>

      <ThemedText variant="sheetTitle" accessibilityRole="header" style={inset}>
        {t('recipes.method.sheetTitle')}
      </ThemedText>
      <ThemedText variant="sectionLabel" color="inkSecondary" style={inset}>
        {t('recipes.method.onePerLine')}
      </ThemedText>
      <Card>
        <TextInput
          value={text}
          onChangeText={setText}
          multiline
          autoFocus={!recipe.steps}
          autoCapitalize="sentences"
          placeholder={t('recipes.method.placeholder')}
          placeholderTextColor={colors.inkSecondary}
          selectionColor={colors.primary}
          accessibilityLabel={t('recipes.method.sheetTitle')}
          accessibilityHint={t('recipes.method.onePerLine')}
          style={[
            typography.body,
            {
              color: colors.ink,
              lineHeight: typography.body.lineHeight + spacing.xs,
              minHeight: (typography.body.lineHeight + spacing.xs) * MIN_LINES,
              paddingHorizontal: spacing.lg,
              paddingTop: spacing.md + spacing.xxs,
              paddingBottom: spacing.md + spacing.xxs,
              textAlignVertical: 'top',
            },
          ]}
        />
      </Card>
      <ThemedText variant="footnote" color="inkSecondary" style={{ paddingHorizontal: spacing.xxl }}>
        {t('recipes.method.footnote')}
      </ThemedText>
      {headings.length >= 2 ? (
        <>
          <ThemedText variant="sectionLabel" color="inkSecondary" style={[inset, { paddingTop: spacing.xs }]}>
            {t('recipes.method.chooseOne')}
          </ThemedText>
          <Card>
            {headings.map((heading, i) => {
              const checked = choices.has(heading);
              return (
                <Pressable
                  key={i}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked }}
                  accessibilityLabel={heading}
                  onPress={() => toggle(heading)}
                  style={({ pressed }) => [
                    styles.row,
                    {
                      minHeight: sizes.rowMin,
                      paddingHorizontal: spacing.lg,
                      paddingVertical: spacing.sm,
                      gap: spacing.md,
                      borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                      borderTopColor: colors.border,
                      opacity: pressed ? opacity.pressed : 1,
                    },
                  ]}>
                  <CheckCircle checked={checked} />
                  <ThemedText variant="body" style={styles.flex}>
                    {heading}
                  </ThemedText>
                </Pressable>
              );
            })}
          </Card>
          <ThemedText variant="footnote" color="inkSecondary" style={{ paddingHorizontal: spacing.xxl }}>
            {t('recipes.method.chooseOneFootnote')}
          </ThemedText>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
