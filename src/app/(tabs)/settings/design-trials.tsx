import { router } from 'expo-router';
import { View } from 'react-native';

import { Card } from '@/components/card';
import { SegmentedControl } from '@/components/segmented-control';
import { SettingsRow } from '@/components/settings-group';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { FontSetSpecs } from '@/constants/theme';
import { COOK_VIEW_STYLES, setCookViewStyle, useCookViewStyle, type CookViewStyle } from '@/features/recipes/cook-style';
import { RECIPE_VIEW_STYLES, setRecipeViewStyle, useRecipeViewStyle, type RecipeViewStyle } from '@/features/recipes/view-style';
import { useFontSet } from '@/hooks/font-set';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/** Settings > Design trials: Fonts, Recipe view and Cook view, each for this device only. In every build until the trials end. */
export default function DesignTrialsScreen() {
  const { spacing } = useTheme();
  const t = useT();
  const fontSet = useFontSet();
  const recipeViewStyle = useRecipeViewStyle();
  const cookViewStyle = useCookViewStyle();

  return (
    <Screen scroll contentContainerStyle={{ paddingTop: spacing.sm, paddingBottom: spacing.xl }}>
      <Card>
        <SettingsRow
          label={t('settings.fonts')}
          value={FontSetSpecs[fontSet].display}
          icon={{ name: 'textformat', hue: 'plum' }}
          onPress={() => router.push('/font-sets')}
        />
        {/* The recipe screen's layout (spec 4.5). */}
        <View style={{ paddingVertical: spacing.md, gap: spacing.sm }}>
          <ThemedText variant="body" importantForAccessibility="no" accessibilityElementsHidden style={{ paddingHorizontal: spacing.lg }}>
            {t('settings.recipeView')}
          </ThemedText>
          <SegmentedControl<RecipeViewStyle>
            accessibilityLabel={t('settings.recipeViewLabel')}
            segments={RECIPE_VIEW_STYLES.map((style) => ({ value: style, label: t(RECIPE_VIEW_STYLE_LABELS[style]) }))}
            value={recipeViewStyle}
            onChange={setRecipeViewStyle}
          />
        </View>
        {/* The cook screen's steps (spec 4.5). */}
        <View style={{ paddingVertical: spacing.md, gap: spacing.sm }}>
          <ThemedText variant="body" importantForAccessibility="no" accessibilityElementsHidden style={{ paddingHorizontal: spacing.lg }}>
            {t('settings.cookView')}
          </ThemedText>
          <SegmentedControl<CookViewStyle>
            accessibilityLabel={t('settings.cookViewLabel')}
            segments={COOK_VIEW_STYLES.map((style) => ({ value: style, label: t(COOK_VIEW_STYLE_LABELS[style]) }))}
            value={cookViewStyle}
            onChange={setCookViewStyle}
          />
        </View>
      </Card>
      <ThemedText
        variant="footnote"
        color="inkSecondary"
        style={{ paddingTop: spacing.sm, paddingHorizontal: spacing.xxl }}>
        {t('settings.fontsScreen.footnote')}
      </ThemedText>
    </Screen>
  );
}

const RECIPE_VIEW_STYLE_LABELS = {
  standard: 'settings.recipeViewStandard',
  titleOnPhoto: 'settings.recipeViewTitleOnPhoto',
} as const satisfies Record<RecipeViewStyle, string>;

const COOK_VIEW_STYLE_LABELS = {
  cards: 'settings.cookViewCards',
  sheet: 'settings.cookViewSheet',
} as const satisfies Record<CookViewStyle, string>;
