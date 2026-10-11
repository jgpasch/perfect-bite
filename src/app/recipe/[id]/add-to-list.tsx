import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/button';
import { Card } from '@/components/card';
import { CheckCircle } from '@/components/check-circle';
import { Pill } from '@/components/pill';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { formatAmount } from '@/domain/quantity-display';
import { getAccount } from '@/features/auth/account';
import { categorizePending } from '@/features/categories/categorization';
import { getDefaultListId, listsWithCountsQuery } from '@/features/lists/lists';
import { setRecipeAddResult } from '@/features/lists/recipe-add-result';
import { addRecipeToList, buildRecipeAdds, SERVINGS } from '@/features/recipes/add-to-list';
import { addCtaLabel, servingsLabel } from '@/features/recipes/recipe-view';
import { getRecipe, recipeIngredientsQuery } from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';

/**
 * "Add to a list" (spec 4.5, board 07): pick a list, untick what you already have, choose
 * servings. Ingredients already on the list Combine as single adds do (spec 4.4); the list screen
 * then shows "Added Tacos · 8 items" with Undo.
 */
export default function AddRecipeToListSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { spacing } = useTheme();
  const userId = getAccount()?.userId ?? null;

  // A sheet is short-lived: read once rather than live.
  const [recipe] = useState(() => getRecipe(id));
  const [ingredients] = useState(() => recipeIngredientsQuery(id).all());
  // M7: only lists in the recipe's household are offered.
  const [lists] = useState(() =>
    listsWithCountsQuery()
      .all()
      .filter((l) => l.archivedAt === null),
  );
  const [listId, setListId] = useState(() => (userId ? getDefaultListId(userId) : null) ?? lists[0]?.id ?? null);
  const [selected, setSelected] = useState(() => new Set(ingredients.map((i) => i.id)));
  const [servings, setServings] = useState(1);

  const adds = useMemo(() => buildRecipeAdds(id, ingredients, selected, servings), [id, ingredients, selected, servings]);
  const listName = lists.find((l) => l.id === listId)?.name ?? '';

  if (!recipe || !listId) return <Screen />;

  // Spec 4.4: no clash step. Every ingredient already open Combines, and the list shows the toast.
  const add = () => {
    const added = addRecipeToList(listId, adds, userId);
    void categorizePending(added.pendingNames);
    setRecipeAddResult({ kind: 'toList', listId, recipeId: id, recipeName: recipe.name, count: added.count, results: added.results });
    router.back();
    router.push({ pathname: '/list/[id]', params: { id: listId } });
  };

  const toggle = <T,>(set: Set<T>, value: T) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  return (
    <SheetLayout cta={<PrimaryButton label={addCtaLabel(adds.length, listName)} disabled={adds.length === 0} onPress={add} />}>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>Cancel</Stack.Toolbar.Button>
      </Stack.Toolbar>

      <ThemedText variant="title" accessibilityRole="header" style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
        Add {recipe.name}
      </ThemedText>

      <Label>To</Label>
      <View style={[styles.row, styles.wrap, { gap: spacing.sm, paddingHorizontal: spacing.lg }]}>
        {lists.map((l) => (
          <Pill key={l.id} label={l.name} selected={l.id === listId} onPress={() => setListId(l.id)} />
        ))}
      </View>

      <Label>Servings</Label>
      <View style={[styles.row, { gap: spacing.sm, paddingHorizontal: spacing.lg }]}>
        {SERVINGS.map((s) => (
          <View key={s} style={styles.flex}>
            <Pill label={servingsLabel(s)} selected={s === servings} onPress={() => setServings(s)} />
          </View>
        ))}
      </View>

      <Card>
        <View
          style={[
            styles.row,
            { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.sm },
          ]}>
          <ThemedText variant="amount" accessibilityRole="header" style={[styles.flex, styles.bold]}>
            Untick what you have
          </ThemedText>
          <ThemedText variant="footnote" color="inkSecondary" style={styles.semibold}>
            {selected.size} of {ingredients.length}
          </ThemedText>
        </View>
        {ingredients.map((i) => {
          const on = selected.has(i.id);
          const amount = formatAmount({ quantity: i.quantity === null ? null : i.quantity * servings, unit: i.unit });
          return (
            <IngredientChoice
              key={i.id}
              label={i.displayName}
              amount={amount}
              on={on}
              onPress={() => setSelected(toggle(selected, i.id))}
            />
          );
        })}
      </Card>
    </SheetLayout>
  );
}

/** The sheet's scrolling content with its CTA pinned to the bottom. */
function SheetLayout({ cta, children }: { cta: ReactNode; children: ReactNode }) {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Screen>
      <ScrollView
        style={styles.flex}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ gap: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.lg }}>
        {children}
      </ScrollView>
      <View
        style={{
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.md,
          paddingBottom: Math.max(insets.bottom, spacing.lg),
          backgroundColor: colors.background,
        }}>
        {cta}
      </View>
    </Screen>
  );
}

function Label({ children }: { children: string }) {
  const { spacing } = useTheme();
  return (
    <ThemedText variant="sectionLabel" color="inkSecondary" accessibilityRole="header" style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
      {children}
    </ThemedText>
  );
}

/** A row in "Untick what you have": a round check, the name, and the scaled amount. Off rows are muted. */
function IngredientChoice({ label, amount, on, onPress }: { label: string; amount: string; on: boolean; onPress: () => void }) {
  const { colors, spacing, sizes, opacity } = useTheme();
  // Off rows use `inkSecondary`, not `inkTertiary`: tertiary is too light for text (DESIGN.md).
  const ink = on ? 'ink' : 'inkSecondary';
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      accessibilityLabel={amount ? `${label}, ${amount}` : label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: sizes.cardRowMin,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.sm,
          gap: spacing.md,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.border,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <CheckCircle checked={on} />
      <ThemedText variant="body" color={ink} style={styles.flex}>
        {label}
      </ThemedText>
      {amount ? (
        <ThemedText variant="amount" color="inkSecondary">
          {amount}
        </ThemedText>
      ) : null}
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
