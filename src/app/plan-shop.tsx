import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { PrimaryButton, SurfaceButton } from '@/components/button';
import { Card } from '@/components/card';
import { CheckCircle } from '@/components/check-circle';
import { Pill } from '@/components/pill';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import type { RecipeIngredient } from '@/db';
import { getAccount } from '@/features/auth/account';
import { categorizePending } from '@/features/categories/categorization';
import { stapleNames } from '@/features/households/staples';
import { resolveCurrentListId } from '@/features/lists/current-list';
import { listsWithCountsQuery } from '@/features/lists/lists';
import { groupWeek, weekEntriesQuery } from '@/features/meal-plan/queries';
import {
  defaultLines,
  defaultTicked,
  lineAmount,
  recipesOnList,
  type ShopEntry,
  shopAdds,
  shopDays,
  shopEntries,
  shopLines,
  shopTitle,
  shopToList,
  showShopToast,
} from '@/features/meal-plan/shop';
import { today as todayOf } from '@/features/meal-plan/week';
import { slotName } from '@/features/meal-plan/week-view';
import { IngredientChoice, SheetLabel, SheetLayout, toggled } from '@/features/recipes/add-sheet';
import { RecipePhotoTile } from '@/features/recipes/recipe-photo';
import { addCtaLabel } from '@/features/recipes/recipe-view';
import { recipeIngredientsQuery } from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';
import { displayItemName } from '@/shared';

/**
 * Shop this week (spec 4.16, board 3 G): the list picker, the week's recipe entries from today on, ticked
 * unless their recipe is already on the list, then **Review N items** (the merged ingredients as Add to a
 * list's checklist) or **Add N to Groceries**: one bulk add (spec 4.4) at 1× without the household's staples.
 * The week that opened the sheet shows the toast.
 */
export default function PlanShopSheet() {
  const { householdId, start } = useLocalSearchParams<{ householdId: string; start: string }>();
  const t = useT();
  const { spacing } = useTheme();
  const userId = getAccount()?.userId ?? null;
  const [today] = useState(todayOf);

  // A sheet is short-lived: read once rather than live.
  const [entries] = useState(() =>
    householdId && start ? shopEntries(groupWeek(weekEntriesQuery(householdId, start).all()), shopDays(start, today)) : [],
  );
  // The household's open lists in the user's order, the current one first.
  const [lists] = useState(() => {
    const open = listsWithCountsQuery()
      .all()
      .filter((l) => l.archivedAt === null);
    const current = resolveCurrentListId(open, userId);
    const own = open.filter((l) => l.householdId === householdId);
    return [...own.filter((l) => l.id === current), ...own.filter((l) => l.id !== current)];
  });
  const [staples] = useState(() => (householdId ? stapleNames(householdId) : new Set<string>()));
  const [ingredients] = useState(() => {
    const cache = new Map<string, RecipeIngredient[]>();
    return (recipeId: string) => {
      let own = cache.get(recipeId);
      if (!own) cache.set(recipeId, (own = recipeIngredientsQuery(recipeId).all()));
      return own;
    };
  });

  const [listId, setListId] = useState(() => lists[0]?.id ?? null);
  const [onList, setOnList] = useState(() => (listId ? recipesOnList(listId) : new Set<string>()));
  const [ticked, setTicked] = useState(() => defaultTicked(entries, onList));
  // Review: the merged lines and which are ticked; null while the entries show.
  const [review, setReview] = useState<Set<string> | null>(null);

  const chosen = useMemo(() => entries.filter((e) => ticked.has(e.id)), [entries, ticked]);
  const lines = useMemo(() => shopLines(chosen, ingredients, staples), [chosen, ingredients, staples]);
  const linesTicked = review ?? defaultLines(lines);
  const listName = lists.find((l) => l.id === listId)?.name ?? '';

  if (!householdId || !start) return <Screen />;

  const pickList = (id: string) => {
    const already = recipesOnList(id);
    setListId(id);
    setOnList(already);
    // The ticks follow the chosen list's "already on".
    setTicked(defaultTicked(entries, already));
  };

  const add = () => {
    if (!listId) return;
    const added = shopToList(listId, shopAdds(lines, linesTicked), userId);
    void categorizePending(added.pendingNames);
    router.back();
    showShopToast(added, chosen.length, listId);
  };

  const cancel = (
    <Stack.Toolbar placement="left">
      <Stack.Toolbar.Button onPress={() => (review ? setReview(null) : router.back())}>
        {review ? t('common.back') : t('common.cancel')}
      </Stack.Toolbar.Button>
    </Stack.Toolbar>
  );
  const addCta = (
    <PrimaryButton label={addCtaLabel(linesTicked.size, listName)} disabled={linesTicked.size === 0 || !listId} onPress={add} />
  );

  if (review) {
    return (
      <SheetLayout cta={addCta}>
        {cancel}
        <ThemedText variant="title" accessibilityRole="header" style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
          {t('mealPlan.shopReviewTitle')}
        </ThemedText>
        <Card>
          <View style={[styles.row, { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm }]}>
            <ThemedText variant="amount" accessibilityRole="header" style={[styles.flex, styles.bold]}>
              {t('recipes.addToList.untick')}
            </ThemedText>
            <ThemedText variant="footnote" color="inkSecondary" style={styles.semibold}>
              {t('recipes.addToList.selectedOf', { selected: review.size, count: lines.length })}
            </ThemedText>
          </View>
          {lines.map((line) => (
            <IngredientChoice
              key={line.ingredientName}
              label={displayItemName(line.displayName)}
              amount={lineAmount(line)}
              staple={line.staple}
              on={review.has(line.ingredientName)}
              onPress={() => setReview(toggled(review, line.ingredientName))}
            />
          ))}
        </Card>
      </SheetLayout>
    );
  }

  return (
    <SheetLayout
      cta={
        <View style={{ gap: spacing.sm }}>
          <SurfaceButton
            on="surface"
            label={t('mealPlan.shopReview', { count: linesTicked.size })}
            disabled={lines.length === 0 || !listId}
            onPress={() => setReview(defaultLines(lines))}
          />
          {addCta}
        </View>
      }>
      {cancel}
      <ThemedText variant="title" accessibilityRole="header" style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
        {shopTitle(start, today)}
      </ThemedText>

      <SheetLabel>{t('recipes.addToList.to')}</SheetLabel>
      {lists.length > 0 ? (
        <View style={[styles.row, styles.wrap, { gap: spacing.sm, paddingHorizontal: spacing.lg }]}>
          {lists.map((l) => (
            <Pill key={l.id} label={l.name} selected={l.id === listId} onPress={() => pickList(l.id)} />
          ))}
        </View>
      ) : (
        <ThemedText variant="callout" color="inkSecondary" style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
          {t('mealPlan.shopNoLists')}
        </ThemedText>
      )}

      <SheetLabel>{t('mealPlan.shopRecipesLabel')}</SheetLabel>
      <Card>
        {entries.map((entry, i) => (
          <EntryChoice
            key={entry.id}
            entry={entry}
            first={i === 0}
            on={ticked.has(entry.id)}
            alreadyOn={onList.has(entry.recipeId) ? listName : null}
            onPress={() => setTicked(toggled(ticked, entry.id))}
          />
        ))}
      </Card>
      <ThemedText variant="footnote" color="inkSecondary" style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
        {t('mealPlan.shopFootnote')}
      </ThemedText>
    </SheetLayout>
  );
}

/** An entry's row: a round check, the recipe's tile, its name and "Thursday dinner · already on Groceries". */
function EntryChoice({
  entry,
  first,
  on,
  alreadyOn,
  onPress,
}: {
  entry: ShopEntry;
  first: boolean;
  on: boolean;
  /** The list's name when the recipe is already on it. */
  alreadyOn: string | null;
  onPress: () => void;
}) {
  const t = useT();
  const { colors, spacing, sizes, opacity } = useTheme();
  const detail = [slotName(entry.day, entry.meal), alreadyOn ? t('mealPlan.shopAlreadyOn', { name: alreadyOn }) : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <Pressable
      testID={`shop-entry-${entry.id}`}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      accessibilityLabel={`${entry.recipeName}, ${detail}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: sizes.cardRowMin,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.sm,
          gap: spacing.md,
          borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <CheckCircle checked={on} />
      <RecipePhotoTile recipeId={entry.recipeId} imageUrl={entry.recipeImageUrl} photoPath={entry.recipePhotoPath} />
      <View style={styles.flex}>
        <ThemedText variant="body" color={on ? 'ink' : 'inkSecondary'} numberOfLines={2}>
          {entry.recipeName}
        </ThemedText>
        <ThemedText variant="footnote" color="inkSecondary">
          {detail}
        </ThemedText>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexWrap: 'wrap' },
  bold: { fontWeight: '700' },
  semibold: { fontWeight: '600' },
});
