import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { hueHeaderBand } from '@/components/appearance';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { Pill } from '@/components/pill';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { MealHues } from '@/constants/theme';
import { groupWeek, weekEntriesQuery } from '@/features/meal-plan/queries';
import { promptNote, slotSheetRecipes } from '@/features/meal-plan/slot-actions';
import { type Meal, MEALS } from '@/features/meal-plan/week';
import { mealLabel, sheetDayLabel } from '@/features/meal-plan/week-view';
import { addRecipeToSlot, type EntryInput, setSlot } from '@/features/meal-plan/write';
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
 *
 * With `mode: 'add'`, the add sheet (board E), from the meal sheet: "Add to dinner" under "Tuesday 13 ·
 * Dinner", a line naming the slot's recipes, no pills, and the slot's recipes ticked and disabled. Picking
 * adds the recipe last and goes back to the meal sheet.
 */
export default function PlanSlotSheet() {
  const { householdId, day, meal, mode } = useLocalSearchParams<{ householdId: string; day: string; meal: string; mode?: string }>();
  const t = useT();
  const { colors, scheme, spacing, sizes, opacity, rounded } = useTheme();
  const adding = mode === 'add';
  // A sheet is short-lived: read once rather than live.
  const [recipes] = useState(() => recipesQuery().all());
  // The add sheet's slot recipes, in order.
  const [inSlot] = useState(() =>
    adding && householdId && day && isMeal(meal)
      ? groupWeek(weekEntriesQuery(householdId, day).all())
          .slotEntries(day, meal)
          .filter((e) => e.kind === 'recipe')
      : [],
  );
  const inSlotIds = useMemo(() => new Set(inSlot.map((e) => e.recipeId)), [inSlot]);
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
    if (adding && entry.kind === 'recipe') addRecipeToSlot(householdId, day, meal, entry.recipeId);
    else setSlot(householdId, day, meal, entry);
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
          {adding ? t('mealPlan.addDayLine', { day: sheetDayLabel(day), meal: mealLabel(meal) }) : sheetDayLabel(day)}
        </ThemedText>
        <ThemedText variant="sheetTitle">{adding ? t(`mealPlan.addTo.${meal}`) : mealLabel(meal)}</ThemedText>
      </View>

      {adding && inSlot.length > 0 ? (
        <View
          testID="slot-with"
          style={[
            styles.row,
            {
              marginHorizontal: spacing.lg,
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.sm,
              borderRadius: rounded.md,
              backgroundColor: colors.primarySoft,
            },
          ]}>
          <ThemedText variant="footnote" color="onPrimarySoft" numberOfLines={1} style={[styles.flex, styles.strong]}>
            {t('mealPlan.withRecipes', { names: inSlot.map((e) => e.recipeName ?? '').join(', ') })}
          </ThemedText>
        </View>
      ) : null}

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

      {adding ? null : (
        <View style={[styles.row, styles.wrap, { gap: spacing.sm, paddingHorizontal: spacing.lg }]}>
          <Pill label={t('mealPlan.leftovers')} onPress={() => pick({ kind: 'leftovers' })} />
          <Pill label={t('mealPlan.eatingOut')} onPress={() => pick({ kind: 'eating-out' })} />
          <Pill label={t('mealPlan.note')} onPress={() => promptNote('', (note) => pick({ kind: 'note', note }))} />
        </View>
      )}

      {shown.length > 0 ? (
        <Card>
          {shown.map((r, i) => {
            const time = recipeTimeLabel(r.totalMinutes);
            const already = inSlotIds.has(r.id);
            const detail = already ? t(`mealPlan.alreadyIn.${meal}`) : time;
            return (
              <Pressable
                key={r.id}
                testID={`slot-recipe-${r.id}`}
                accessibilityRole="button"
                accessibilityLabel={detail ? `${r.name}, ${detail}` : r.name}
                accessibilityState={{ disabled: already, checked: already ? true : undefined }}
                disabled={already}
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
                    opacity: already ? opacity.disabled : pressed ? opacity.pressed : 1,
                  },
                ]}>
                <RecipePhotoTile recipeId={r.id} imageUrl={r.imageUrl} photoPath={r.photoPath} />
                {already ? (
                  <View style={styles.flex}>
                    <ThemedText variant="body" numberOfLines={2}>
                      {r.name}
                    </ThemedText>
                    <ThemedText variant="footnote" color="inkSecondary">
                      {detail}
                    </ThemedText>
                  </View>
                ) : (
                  <ThemedText variant="body" numberOfLines={2} style={styles.flex}>
                    {r.name}
                  </ThemedText>
                )}
                {already ? (
                  <Icon name="checkmark" color="primary" size={sizes.icon} weight="bold" />
                ) : time ? (
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
  strong: { fontWeight: '600' },
});
