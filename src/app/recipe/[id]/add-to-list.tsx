import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/button';
import { Card } from '@/components/card';
import { CheckCircle } from '@/components/check-circle';
import { Pill } from '@/components/pill';
import { SegmentedControl } from '@/components/segmented-control';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { formatAmount } from '@/domain/quantity-display';
import { getAccount } from '@/features/auth/account';
import { categorizePending } from '@/features/categories/categorization';
import type { BulkConflict } from '@/features/lists/items';
import { getDefaultListId, listsWithCountsQuery } from '@/features/lists/lists';
import { addRecipeToList, buildRecipeAdds, planRecipeAdd, SERVINGS } from '@/features/recipes/add-to-list';
import { addCtaLabel, conflictResult, conflictTitle, keepLabel, servingsLabel } from '@/features/recipes/recipe-view';
import { getRecipe, recipeIngredientsQuery } from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';

/**
 * "Add to a list" (spec 4.5, board 07): pick a list, untick what you already have, choose
 * servings. Any ingredient already open on the list is asked about on one bulk step (spec 4.4, board 08).
 */
export default function AddRecipeToListSheet() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, spacing } = useTheme();
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
  const [conflicts, setConflicts] = useState<BulkConflict[] | null>(null);
  const [keep, setKeep] = useState<Set<number>>(new Set());

  const adds = useMemo(() => buildRecipeAdds(id, ingredients, selected, servings), [id, ingredients, selected, servings]);
  const listName = lists.find((l) => l.id === listId)?.name ?? '';

  if (!recipe || !listId) return <Screen />;

  const finish = (keepExisting: Set<number>) => {
    void categorizePending(addRecipeToList(listId, adds, userId, keepExisting));
    router.back();
    router.push({ pathname: '/list/[id]', params: { id: listId } });
  };

  const add = () => {
    const found = planRecipeAdd(listId, adds);
    if (found.length === 0) return finish(new Set());
    setKeep(new Set());
    setConflicts(found);
  };

  const toggle = <T,>(set: Set<T>, value: T) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  if (conflicts) {
    // The bulk duplicate step (spec 4.4): per-row Combine / Keep existing, plus "all" shortcuts.
    return (
      <SheetLayout cta={<PrimaryButton label={`Add to ${listName}`} onPress={() => finish(keep)} />}>
        <View style={{ paddingHorizontal: spacing.lg + spacing.xs, gap: spacing.xs + spacing.xxs }}>
          <ThemedText variant="title" accessibilityRole="header">
            {conflictTitle(conflicts.length, listName)}
          </ThemedText>
          <ThemedText variant="callout" color="inkSecondary">
            Combine the amounts, or keep what’s there?
          </ThemedText>
        </View>
        <Card>
          {conflicts.map((c, i) => {
            const keeping = keep.has(c.index);
            const result = conflictResult(c, keeping);
            return (
              <View
                key={c.index}
                style={{
                  paddingHorizontal: spacing.lg,
                  paddingVertical: spacing.md + spacing.xxs,
                  gap: spacing.sm + spacing.xxs,
                  borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                  borderTopColor: colors.border,
                }}>
                <View style={[styles.row, { gap: spacing.sm }]}>
                  <ThemedText variant="headline" style={styles.flex}>
                    {c.displayName}
                  </ThemedText>
                  {result ? (
                    <ThemedText variant="amount" color="inkSecondary">
                      {result}
                    </ThemedText>
                  ) : null}
                </View>
                <SegmentedControl
                  flush
                  track="background"
                  accessibilityLabel={c.displayName}
                  segments={[
                    { value: 'combine', label: 'Combine', tone: 'primary' },
                    { value: 'keep', label: keepLabel(c), tone: 'ink' },
                  ]}
                  value={keeping ? 'keep' : 'combine'}
                  onChange={() => setKeep(toggle(keep, c.index))}
                />
              </View>
            );
          })}
        </Card>
        <View style={[styles.row, { gap: spacing.sm, paddingHorizontal: spacing.lg }]}>
          <View style={styles.flex}>
            <Pill label="Combine all" onPress={() => setKeep(new Set())} />
          </View>
          <View style={styles.flex}>
            <Pill label="Keep all existing" onPress={() => setKeep(new Set(conflicts.map((c) => c.index)))} />
          </View>
        </View>
      </SheetLayout>
    );
  }

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
