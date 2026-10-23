import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { PrimaryButton } from '@/components/button';
import { Card } from '@/components/card';
import { Pill } from '@/components/pill';
import { Stepper } from '@/components/stepper';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { formatAmount } from '@/domain/quantity-display';
import { getAccount } from '@/features/auth/account';
import { categorizePending } from '@/features/categories/categorization';
import { openList } from '@/features/lists/current-list';
import { getDefaultListId, listsWithCountsQuery } from '@/features/lists/lists';
import { setRecipeAddResult, takeAdjust } from '@/features/lists/recipe-add-result';
import { isStaple, setStaple, useStapleNames } from '@/features/households/staples';
import { IngredientChoice, SheetLabel, SheetLayout, toggled } from '@/features/recipes/add-sheet';
import {
  addRecipeToList,
  buildRecipeAdds,
  defaultSelection,
  recipeServesLabel,
  replaceRecipeAdd,
  SERVINGS,
  servingsMultiplier,
  startingServings,
} from '@/features/recipes/add-to-list';
import { addCtaLabel, forServingsLabel, SERVINGS_MAX, SERVINGS_MIN, servingsLabel } from '@/features/recipes/recipe-view';
import { getRecipe, recipeIngredientsQuery } from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';
import { displayItemName } from '@/shared';

/**
 * "Add to a list" (spec 4.5, board 07): pick a list, untick what you already have, choose
 * servings. Ingredients already on the list Combine as single adds do (spec 4.4); the list screen
 * then shows "Added Tacos · 8 items" with Undo.
 */
export default function AddRecipeToListSheet() {
  // From the add bar's Adjust (spec 4.2): `list` preselects that list and `adjust` names the add this one replaces.
  // From the recipe screen's stepper (board 17), `servings` is its chosen servings.
  const {
    id,
    list: fromList,
    adjust,
    servings: chosenServings,
  } = useLocalSearchParams<{ id: string; list?: string; adjust?: string; servings?: string }>();
  const t = useT();
  const { spacing, sizes } = useTheme();
  const userId = getAccount()?.userId ?? null;

  // A sheet is short-lived: read once rather than live.
  const [recipe] = useState(() => getRecipe(id));
  const [ingredients] = useState(() => recipeIngredientsQuery(id).all());
  // Spec 4.5: only open lists in the recipe's household are offered.
  const [lists] = useState(() =>
    listsWithCountsQuery()
      .all()
      .filter((l) => l.archivedAt === null && l.householdId === recipe?.householdId),
  );
  const [listId, setListId] = useState(() => {
    const offered = (listId: string | null | undefined) => lists.find((l) => l.id === listId)?.id;
    return offered(fromList) ?? offered(userId ? getDefaultListId(userId) : null) ?? lists[0]?.id ?? null;
  });
  // Spec 4.5: the household's staples (Always have) start unticked and are tagged; ticking one doesn't change it.
  // The tags follow marks from here and from other members' phones.
  const staples = useStapleNames(recipe?.householdId ?? '');
  const [selected, setSelected] = useState(() => defaultSelection(ingredients, staples));
  // With the recipe's servings, people (board 17); without, a multiplier pill (board 07).
  const base = recipe?.servings ?? null;
  const [servings, setServings] = useState(() => (base === null ? 1 : startingServings(base, chosenServings)));
  const multiplier = base === null ? servings : servingsMultiplier(servings, base);

  const adds = useMemo(() => buildRecipeAdds(id, ingredients, selected, multiplier), [id, ingredients, selected, multiplier]);
  const listName = lists.find((l) => l.id === listId)?.name ?? '';

  if (!recipe || !listId) return <Screen />;

  // Spec 4.5 Marking from a recipe: marking unticks every row with that ingredient, unmarking ticks them. No toast:
  // the tag is the feedback.
  const toggleStaple = (ingredientName: string) => {
    const on = !isStaple(recipe.householdId, ingredientName);
    setStaple(recipe.householdId, ingredientName, on, userId);
    const next = new Set(selected);
    for (const i of ingredients) {
      if (i.ingredientName !== ingredientName) continue;
      if (on) next.delete(i.id);
      else next.add(i.id);
    }
    setSelected(next);
  };

  // Spec 4.4: no clash step. Every ingredient already open Combines, and the list shows the toast.
  // Opened from Adjust, this add replaces the add bar's one.
  const add = () => {
    const previous = takeAdjust(adjust, id);
    const added = previous ? replaceRecipeAdd(previous, listId, adds, userId) : addRecipeToList(listId, adds, userId);
    void categorizePending(added.pendingNames);
    setRecipeAddResult({ kind: 'toList', listId, recipeId: id, recipeName: recipe.name, count: added.count, results: added.results });
    router.back();
    // Opened from that list's toast, the list is underneath already.
    if (listId !== fromList) openList(listId);
  };

  return (
    <SheetLayout cta={<PrimaryButton label={addCtaLabel(adds.length, listName)} disabled={adds.length === 0} onPress={add} />}>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>{t('common.cancel')}</Stack.Toolbar.Button>
      </Stack.Toolbar>

      <ThemedText variant="title" accessibilityRole="header" style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
        {t('recipes.addToList.title', { name: recipe.name })}
      </ThemedText>

      <SheetLabel>{t('recipes.addToList.to')}</SheetLabel>
      <View style={[styles.row, styles.wrap, { gap: spacing.sm, paddingHorizontal: spacing.lg }]}>
        {lists.map((l) => (
          <Pill key={l.id} label={l.name} selected={l.id === listId} onPress={() => setListId(l.id)} />
        ))}
      </View>

      <SheetLabel>{t('recipes.addToList.servings')}</SheetLabel>
      {base === null ? (
        <View style={[styles.row, { gap: spacing.sm, paddingHorizontal: spacing.lg }]}>
          {SERVINGS.map((s) => (
            <View key={s} style={styles.flex}>
              <Pill label={servingsLabel(s)} selected={s === servings} onPress={() => setServings(s)} />
            </View>
          ))}
        </View>
      ) : (
        <Card
          style={[
            styles.row,
            { gap: spacing.md, paddingVertical: spacing.sm, paddingLeft: spacing.lg, paddingRight: spacing.sm },
          ]}>
          <View style={styles.flex}>
            <ThemedText variant="headline">{forServingsLabel(servings)}</ThemedText>
            <ThemedText variant="footnote" color="inkSecondary">
              {recipeServesLabel(base)}
            </ThemedText>
          </View>
          <Stepper
            value={servings}
            min={SERVINGS_MIN}
            max={SERVINGS_MAX}
            onChange={setServings}
            label={forServingsLabel(servings)}
            accessibilityLabel={t('recipes.servings.title')}
            buttonSize={sizes.stepperButtonLarge}
            hideValue
          />
        </Card>
      )}

      <Card>
        <View
          style={[
            styles.row,
            { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm },
          ]}>
          <ThemedText variant="amount" accessibilityRole="header" style={[styles.flex, styles.bold]}>
            {t('recipes.addToList.untick')}
          </ThemedText>
          <ThemedText variant="footnote" color="inkSecondary" style={styles.semibold}>
            {t('recipes.addToList.selectedOf', { selected: selected.size, count: ingredients.length })}
          </ThemedText>
        </View>
        {ingredients.map((i) => {
          const on = selected.has(i.id);
          const amount = formatAmount({ quantity: i.quantity === null ? null : i.quantity * multiplier, unit: i.unit });
          return (
            <IngredientChoice
              key={i.id}
              label={displayItemName(i.displayName)}
              amount={amount}
              staple={staples.has(i.ingredientName)}
              on={on}
              onPress={() => setSelected(toggled(selected, i.id))}
              onToggleStaple={() => toggleStaple(i.ingredientName)}
            />
          );
        })}
      </Card>
    </SheetLayout>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexWrap: 'wrap' },
  bold: { fontWeight: '700' },
  semibold: { fontWeight: '600' },
});
