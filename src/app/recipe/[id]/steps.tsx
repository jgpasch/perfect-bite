import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { TextInput } from 'react-native';

import { prominentButtonTint } from '@/components/appearance';
import { Card } from '@/components/card';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { ensureStepMatch } from '@/features/recipes/ensure-step-match';
import { stepsFromText, stepsToText } from '@/features/recipes/recipe-view';
import { getRecipe, updateRecipeSteps } from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/** The field's minimum height, in lines of `body`: room for a few steps before it grows. */
const MIN_LINES = 12;

/**
 * The Steps sheet (board 16): the recipe's method in one field, a step per line. Save splits on line
 * breaks, trims and drops empty lines; nothing left saves null. Cancel writes nothing.
 */
export default function RecipeStepsSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useT();
  const { colors, spacing, typography, scheme } = useTheme();

  // A sheet is short-lived: read once rather than live.
  const [recipe] = useState(() => getRecipe(id));
  const [text, setText] = useState(() => stepsToText(recipe?.steps));

  if (!recipe) return <Screen />;

  const save = () => {
    updateRecipeSteps(recipe.id, stepsFromText(text));
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
    </Screen>
  );
}
