import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { hueHeaderBand } from '@/components/appearance';
import { Card } from '@/components/card';
import { Pill } from '@/components/pill';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { MealHues } from '@/constants/theme';
import { promptNote, slotSheetRecipes } from '@/features/meal-plan/slot-actions';
import { type Meal, MEALS } from '@/features/meal-plan/week';
import { mealLabel, sheetDayLabel } from '@/features/meal-plan/week-view';
import { type EntryInput, setSlot } from '@/features/meal-plan/write';
import { RecipePhotoTile } from '@/features/recipes/recipe-photo';
import { NO_RECIPES_MATCH } from '@/features/recipes/recipe-search';
import { recipeTimeLabel } from '@/features/recipes/recipe-view';
import { recipesQuery } from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

const isMeal = (value: string | undefined): value is Meal => MEALS.includes(value as Meal);

/**
 * The slot sheet (spec 4.16, board 2 F): the day in the meal's hue over the meal, a search field, Leftovers,
 * Eating out and Note…, then the household's recipes tagged with the meal, A–Z, and Show all recipes.
 * Searching looks through all the household's recipes. Picking fills the slot and closes the sheet.
 */
export default function PlanSlotSheet() {
  const { householdId, day, meal } = useLocalSearchParams<{ householdId: string; day: string; meal: string }>();
  const t = useT();
  const { colors, scheme, spacing, sizes, opacity } = useTheme();
  // A sheet is short-lived: read once rather than live.
  const [recipes] = useState(() => recipesQuery().all());
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const searching = query.trim() !== '';
  const shown = useMemo(
    () => (isMeal(meal) ? slotSheetRecipes(recipes, { householdId, meal, query, showAll }) : []),
    [recipes, householdId, meal, query, showAll],
  );

  if (!householdId || !day || !isMeal(meal)) return <Screen />;

  const band = hueHeaderBand(MealHues[meal], scheme);
  const pick = (entry: EntryInput) => {
    setSlot(householdId, day, meal, entry);
    router.back();
  };
  const own = recipes.some((r) => r.householdId === householdId);
  const empty = searching ? NO_RECIPES_MATCH : !own ? t('mealPlan.noRecipes') : t('mealPlan.noMealRecipes', { meal: mealLabel(meal) });

  return (
    <Screen
      scroll
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ gap: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.lg }}>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>{t('common.cancel')}</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <View accessible accessibilityRole="header" style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
        <ThemedText variant="headline" style={{ color: band.text }}>
          {sheetDayLabel(day)}
        </ThemedText>
        <ThemedText variant="sheetTitle">{mealLabel(meal)}</ThemedText>
      </View>

      <View style={{ paddingHorizontal: spacing.lg }}>
        <TextField
          value={query}
          onChangeText={setQuery}
          placeholder={t('mealPlan.searchRecipes')}
          accessibilityLabel={t('mealPlan.searchRecipes')}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
      </View>

      <View style={[styles.row, styles.wrap, { gap: spacing.sm, paddingHorizontal: spacing.lg }]}>
        <Pill label={t('mealPlan.leftovers')} onPress={() => pick({ kind: 'leftovers' })} />
        <Pill label={t('mealPlan.eatingOut')} onPress={() => pick({ kind: 'eating-out' })} />
        <Pill label={t('mealPlan.note')} onPress={() => promptNote('', (note) => pick({ kind: 'note', note }))} />
      </View>

      {shown.length > 0 ? (
        <Card>
          {shown.map((r, i) => {
            const time = recipeTimeLabel(r.totalMinutes);
            return (
              <Pressable
                key={r.id}
                testID={`slot-recipe-${r.id}`}
                accessibilityRole="button"
                accessibilityLabel={time ? `${r.name}, ${time}` : r.name}
                onPress={() => pick({ kind: 'recipe', recipeId: r.id })}
                style={({ pressed }) => [
                  styles.row,
                  {
                    minHeight: sizes.cardRowMin,
                    paddingHorizontal: spacing.lg,
                    paddingVertical: spacing.sm,
                    gap: spacing.md,
                    borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                    borderTopColor: colors.border,
                    opacity: pressed ? opacity.pressed : 1,
                  },
                ]}>
                <RecipePhotoTile recipeId={r.id} imageUrl={r.imageUrl} photoPath={r.photoPath} />
                <ThemedText variant="body" numberOfLines={2} style={styles.flex}>
                  {r.name}
                </ThemedText>
                {time ? (
                  <ThemedText variant="footnote" color="inkSecondary">
                    {time}
                  </ThemedText>
                ) : null}
              </Pressable>
            );
          })}
        </Card>
      ) : (
        <ThemedText variant="callout" color="inkSecondary" style={[styles.centerText, { paddingHorizontal: spacing.lg }]}>
          {empty}
        </ThemedText>
      )}

      {!showAll && !searching && own ? (
        <View style={[styles.row, styles.centerRow, { paddingHorizontal: spacing.lg }]}>
          <Pill label={t('mealPlan.showAll')} outline trailingIcon="chevron.down" onPress={() => setShowAll(true)} />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexWrap: 'wrap' },
  centerRow: { justifyContent: 'center' },
  centerText: { textAlign: 'center' },
});
