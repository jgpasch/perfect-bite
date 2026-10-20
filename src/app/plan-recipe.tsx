import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { listHeaderColors } from '@/components/appearance';
import { PrimaryButton } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { Toast } from '@/components/toast';
import { recipes } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import {
  doneLabel,
  holdsRecipe,
  isPlaced,
  placedToast,
  planChanges,
  type Placements,
  slotHint,
  tapSlot,
  withPlacements,
} from '@/features/meal-plan/plan-modal';
import { groupWeek, MEAL_PLAN_QUERY_TABLES, weekEntriesQuery } from '@/features/meal-plan/queries';
import type { SlotToast } from '@/features/meal-plan/slot-actions';
import { addDays, type Day, type Meal, MEALS, today as todayOf, weekDays, weekStart } from '@/features/meal-plan/week';
import { WeekGrid } from '@/features/meal-plan/week-grid';
import { WeekArrows } from '@/features/meal-plan/week-toolbar';
import { applyPlanChanges } from '@/features/meal-plan/write';
import { RecipePhotoTile } from '@/features/recipes/recipe-photo';
import { recipeQuery } from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

/**
 * The plan modal (spec 4.16, the "Plan → tap a slot" prototype), from the recipe screen's Plan, its plan
 * badges and the Recipes card's Plan…: the grid of the recipe's household on the current week, with the
 * recipe on the green header. Each tap adds the recipe to a slot, after its recipes (over a note), or takes a
 * placement out again; a slot already holding the recipe takes no tap. They're kept here until Done writes
 * them all in one transaction. Cancel or swiping the sheet away writes nothing.
 */
export default function PlanRecipeSheet() {
  const { recipeId } = useLocalSearchParams<{ recipeId: string }>();
  const t = useT();
  const { colors, spacing } = useTheme();
  const header = listHeaderColors(colors);
  const today = todayOf();
  const [start, setStart] = useState(weekStart(today));
  const [placements, setPlacements] = useState<Placements>([]);
  const [toast, setToast] = useState<SlotToast | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);

  const { data: recipeRows } = useLiveQueryOn(recipeQuery(recipeId ?? ''), [recipes], [recipeId]);
  const recipe = recipeRows[0];
  const householdId = recipe?.householdId ?? '';
  const { data: entries } = useLiveQueryOn(weekEntriesQuery(householdId, start), MEAL_PLAN_QUERY_TABLES, [householdId, start]);
  const plan = useMemo(() => groupWeek(entries), [entries]);

  if (!recipe) return <Screen />;

  const placed = {
    id: recipe.id,
    name: recipe.name,
    totalMinutes: recipe.totalMinutes,
    imageUrl: recipe.imageUrl,
    photoPath: recipe.photoPath,
  };
  const shownPlan = withPlacements(plan, placements, placed, householdId);
  const meals = MEALS.filter((meal) => recipe.tags?.meal.includes(meal));

  const onSlot = (day: Day, meal: Meal) => {
    const wasPlaced = isPlaced(placements, day, meal);
    // What the slot holds without this visit's placement, shown again if it's taken out.
    const shown = plan.slotEntries(day, meal);
    const { message, emphasis } = placedToast({ day, meal, previous: shown }, recipe.id, today);
    const key = `placed-${day}-${meal}-${Date.now()}`;
    if (!wasPlaced && holdsRecipe(shown, recipe.id)) return setToast({ key, message, actions: [] });
    const tap = () => setPlacements((current) => tapSlot(current, day, meal, shown, recipe.id));
    tap();
    if (wasPlaced) return setToast(null);
    setToast({ key, message, emphasis, actions: [{ label: t('common.undo'), onPress: () => (tap(), setToast(null)) }] });
  };

  const done = () => {
    applyPlanChanges(planChanges(placements, householdId, recipe.id));
    router.back();
  };

  return (
    <Screen>
      <Stack.Screen options={{ headerStyle: { backgroundColor: header.ground }, headerTintColor: header.title }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>{t('common.cancel')}</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ScrollView contentContainerStyle={{ paddingBottom: spacing.lg }}>
        <View style={{ backgroundColor: header.ground, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm, gap: spacing.xs }}>
          <View accessible accessibilityRole="header" style={[styles.row, { gap: spacing.md, paddingHorizontal: spacing.xs }]}>
            <RecipePhotoTile recipeId={recipe.id} imageUrl={recipe.imageUrl} photoPath={recipe.photoPath} />
            <View style={styles.flex}>
              <ThemedText variant="sheetTitle" numberOfLines={2} style={{ color: header.title }}>
                {recipe.name}
              </ThemedText>
              <ThemedText variant="callout" style={{ color: header.subtitle }}>
                {t('mealPlan.tapSlot')}
              </ThemedText>
            </View>
          </View>
          <WeekArrows start={start} color={header.title} onWeek={(direction) => setStart(addDays(start, direction * 7))} />
        </View>
        <View style={{ paddingTop: spacing.md }}>
          <WeekGrid
            days={weekDays(start)}
            plan={shownPlan}
            today={today}
            onSlot={onSlot}
            placed={(day, meal) => isPlaced(placements, day, meal)}
            highlightMeals={meals}
            slotHint={(day, meal) => slotHint(isPlaced(placements, day, meal), plan.slotEntries(day, meal), recipe.id)}
          />
        </View>
      </ScrollView>
      <SafeAreaView edges={['bottom']} style={{ paddingTop: spacing.sm, gap: spacing.sm }}>
        {toast ? (
          <Toast key={toast.key} message={toast.message} emphasis={toast.emphasis} actions={toast.actions} onDismiss={dismissToast} />
        ) : null}
        <View style={{ paddingHorizontal: spacing.lg }}>
          <PrimaryButton label={doneLabel(placements.length)} onPress={done} />
        </View>
      </SafeAreaView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
});
