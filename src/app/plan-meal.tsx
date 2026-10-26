import { Group, Host, List, RNHostView } from '@expo/ui/swift-ui';
import {
  deleteDisabled,
  environment,
  listRowBackground,
  listRowInsets,
  listRowSeparatorTint,
  listStyle,
  scrollContentBackground,
  scrollDisabled,
} from '@expo/ui/swift-ui/modifiers';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View, type AccessibilityActionEvent } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { hueHeaderBand } from '@/components/appearance';
import { SoftDangerButton, SurfaceButton } from '@/components/button';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { Toast } from '@/components/toast';
import { MealHues } from '@/constants/theme';
import { useLiveQueryOn } from '@/db/live-query';
import { groupWeek, MEAL_PLAN_QUERY_TABLES, type PlanEntry, weekEntriesQuery } from '@/features/meal-plan/queries';
import {
  clearedToast,
  clearSlotWithUndo,
  openAddSheet,
  removedToast,
  type SlotToast,
  weekToast,
} from '@/features/meal-plan/slot-actions';
import { type Meal, MEALS } from '@/features/meal-plan/week';
import { mealLabel, sheetDayLabel } from '@/features/meal-plan/week-view';
import { moveEntry, removeEntry } from '@/features/meal-plan/write';
import { RecipePhotoTile } from '@/features/recipes/recipe-photo';
import { recipeTimeLabel } from '@/features/recipes/recipe-view';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

const isMeal = (value: string | undefined): value is Meal => MEALS.includes(value as Meal);

/**
 * The meal sheet (spec 4.16, board D): a slot's recipes, read live, in order. Tapping one opens it; each
 * has a remove button (Undo in a toast) and a native drag handle, and Add a recipe opens the add sheet,
 * whose "Added 2 recipes to dinner" toast shows here.
 * Replace all… is the slot sheet; Clear dinner, or removing the last recipe, closes the sheet with the
 * week's "Cleared Thursday dinner" toast.
 */
export default function PlanMealSheet() {
  const { householdId, day, meal } = useLocalSearchParams<{ householdId: string; day: string; meal: string }>();
  const t = useT();
  const { colors, scheme, spacing, sizes } = useTheme();
  const { data } = useLiveQueryOn(weekEntriesQuery(householdId ?? '', day ?? ''), MEAL_PLAN_QUERY_TABLES, [householdId, day]);
  const entries = useMemo(
    () => (day && isMeal(meal) ? groupWeek(data).slotEntries(day, meal).filter((e) => e.kind === 'recipe') : []),
    [data, day, meal],
  );
  // Each row's height as laid out, so the native list is as tall as its rows.
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [toast, setToast] = useState<SlotToast | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);

  if (!householdId || !day || !isMeal(meal)) return <Screen />;

  const band = hueHeaderBand(MealHues[meal], scheme);
  const close = () => router.back();
  const remove = (entry: PlanEntry) => {
    const last = entries.length === 1;
    const removed = removeEntry(entry.id);
    if (!removed) return;
    if (last) {
      close();
      return weekToast(clearedToast(householdId, day, meal, [removed], weekToast));
    }
    setToast(removedToast(entry.recipeName ?? '', removed, setToast));
  };
  const move = (entry: PlanEntry, to: number) => void moveEntry(householdId, day, meal, entry.id, to);
  const open = (recipeId: string) => {
    close();
    router.push({ pathname: '/recipe/[id]', params: { id: recipeId } });
  };
  // The slot sheet in the meal sheet's place: its button replaces everything and closes to the week.
  const replaceAll = () => router.replace({ pathname: '/plan-slot', params: { householdId, day, meal, mode: 'replace' } });
  const clear = () => {
    close();
    clearSlotWithUndo(householdId, day, meal, weekToast);
  };
  // Until a row is laid out, its tile and padding.
  const rowsHeight = entries.reduce((sum, e) => sum + (heights[e.id] ?? sizes.recipeTile + spacing.sm * 2), 0);

  return (
    <Screen>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={close}>{t('common.done')}</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <View style={[styles.flex, { gap: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.lg }]}>
        <View accessible accessibilityRole="header" style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
          <ThemedText variant="headline" style={{ color: band.text }}>
            {sheetDayLabel(day)}
          </ThemedText>
          <ThemedText variant="sheetTitle">{mealLabel(meal)}</ThemedText>
        </View>

        <Card>
          {entries.length > 0 ? (
            // Native drag handles, as Your lists' Edit (spec 4.1). SwiftUI's onMove destination is the index to insert before.
            <Host style={{ height: rowsHeight }} colorScheme={scheme} seedColor={colors.primary}>
              <List
                modifiers={[
                  environment('editMode', 'active'),
                  listStyle('plain'),
                  scrollDisabled(true),
                  scrollContentBackground('hidden'),
                ]}>
                <List.ForEach
                  onMove={(from, destination) => {
                    const source = from[0];
                    const entry = entries[source];
                    if (entry) move(entry, destination > source ? destination - 1 : destination);
                  }}>
                  {entries.map((e, i) => (
                    // No delete control (the row's own button removes), on the card's ground with its hairline.
                    <Group
                      key={e.id}
                      modifiers={[
                        deleteDisabled(),
                        listRowBackground(colors.surface),
                        listRowSeparatorTint(colors.border),
                        listRowInsets({ top: 0, leading: 0, bottom: 0, trailing: 0 }),
                      ]}>
                      <RNHostView
                        matchContents
                        onLayout={(event) => {
                          const height = event.nativeEvent.layout.height;
                          setHeights((h) => (h[e.id] === height ? h : { ...h, [e.id]: height }));
                        }}>
                        <MealRecipeRow
                          entry={e}
                          index={i}
                          count={entries.length}
                          onOpen={() => open(e.recipeId!)}
                          onRemove={() => remove(e)}
                          onMove={(to) => move(e, to)}
                        />
                      </RNHostView>
                    </Group>
                  ))}
                </List.ForEach>
              </List>
            </Host>
          ) : null}
          <AddRecipeRow first={entries.length === 0} onPress={() => openAddSheet(householdId, day, meal, setToast)} />
        </Card>
        <ThemedText variant="footnote" color="inkSecondary" style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
          {t('mealPlan.mealFootnote')}
        </ThemedText>
        <View style={[styles.row, { gap: spacing.sm, paddingHorizontal: spacing.lg }]}>
          <View style={styles.flex}>
            <SurfaceButton on="surface" label={t('mealPlan.replaceAll')} onPress={replaceAll} />
          </View>
          <View style={styles.flex}>
            <SoftDangerButton label={t(`mealPlan.clearMeal.${meal}`)} onPress={clear} />
          </View>
        </View>
      </View>
      {toast ? (
        <SafeAreaView edges={['bottom']} pointerEvents="box-none" style={[styles.toast, { paddingBottom: spacing.sm }]}>
          <Toast key={toast.key} message={toast.message} emphasis={toast.emphasis} actions={toast.actions} onDismiss={dismissToast} />
        </SafeAreaView>
      ) : null}
    </Screen>
  );
}

/** A recipe in the meal sheet: its tile, name and time (opening it), and the remove button. */
function MealRecipeRow({
  entry,
  index,
  count,
  onOpen,
  onRemove,
  onMove,
}: {
  entry: PlanEntry;
  index: number;
  count: number;
  onOpen: () => void;
  onRemove: () => void;
  onMove: (to: number) => void;
}) {
  const t = useT();
  const { colors, spacing, sizes, opacity } = useTheme();
  const name = entry.recipeName ?? '';
  const time = recipeTimeLabel(entry.recipeTotalMinutes);
  // VoiceOver can't drag: Move up and Move down do the same.
  const actions = [
    ...(index > 0 ? [{ name: 'moveUp', label: t('mealPlan.moveUp') }] : []),
    ...(index < count - 1 ? [{ name: 'moveDown', label: t('mealPlan.moveDown') }] : []),
  ];
  const onAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === 'moveUp') onMove(index - 1);
    else if (event.nativeEvent.actionName === 'moveDown') onMove(index + 1);
  };
  return (
    <View
      testID={`meal-recipe-${entry.id}`}
      style={[styles.row, { backgroundColor: colors.surface, paddingLeft: spacing.md, paddingVertical: spacing.sm, gap: spacing.md }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={time ? `${name}, ${time}` : name}
        accessibilityActions={actions}
        onAccessibilityAction={onAction}
        onPress={onOpen}
        style={({ pressed }) => [styles.row, styles.flex, { gap: spacing.md, opacity: pressed ? opacity.pressed : 1 }]}>
        <RecipePhotoTile recipeId={entry.recipeId!} imageUrl={entry.recipeImageUrl} photoPath={entry.recipePhotoPath} />
        <View style={styles.flex}>
          <ThemedText variant="headline" numberOfLines={2}>
            {name}
          </ThemedText>
          {time ? (
            <ThemedText variant="footnote" color="inkSecondary">
              {time}
            </ThemedText>
          ) : null}
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('mealPlan.removeRecipe', { name })}
        hitSlop={spacing.xs}
        onPress={onRemove}
        style={({ pressed }) => [
          styles.center,
          { minWidth: sizes.minTapTarget, minHeight: sizes.minTapTarget, opacity: pressed ? opacity.pressed : 1 },
        ]}>
        <Icon name="minus.circle" color="danger" size={sizes.icon} />
      </Pressable>
    </View>
  );
}

/** The card's last row: a `plus` and Add a recipe in `primary`. */
function AddRecipeRow({ first, onPress }: { first: boolean; onPress: () => void }) {
  const t = useT();
  const { colors, spacing, sizes, opacity } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('mealPlan.addRecipe')}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: sizes.cardRowMin,
          paddingHorizontal: spacing.lg,
          gap: spacing.sm,
          borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <Icon name="plus" color="primary" size={sizes.iconSmall} weight="bold" />
      <ThemedText variant="headline" color="primary">
        {t('mealPlan.addRecipe')}
      </ThemedText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
  toast: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
