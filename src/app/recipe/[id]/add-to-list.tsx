import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { formatAmount } from '@/domain/quantity-display';
import { getAccount } from '@/features/auth/account';
import { categorizePending } from '@/features/categories/categorization';
import type { BulkConflict } from '@/features/lists/items';
import { getDefaultListId, listsWithCountsQuery } from '@/features/lists/lists';
import { addRecipeToList, buildRecipeAdds, planRecipeAdd, SERVINGS } from '@/features/recipes/add-to-list';
import { getRecipe, recipeIngredientsQuery } from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';

/**
 * "Add to list..." (spec 4.5): pick a list, untick what you already have, choose servings. Any
 * ingredient already open on the list is asked about on one bulk sheet (spec 4.4).
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
    // The bulk duplicate sheet (spec 4.4): per-row Combine / Keep existing, plus "all" shortcuts.
    return (
      <Screen scroll contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        <Stack.Screen options={{ title: 'Already on the list' }} />
        <ThemedText variant="callout" color="inkSecondary">
          {conflicts.length === 1 ? 'This is' : 'These are'} already on {listName}. Combine the amounts, or keep what’s there?
        </ThemedText>
        <View style={[styles.row, { gap: spacing.sm }]}>
          <View style={styles.flex}>
            <Button label="Combine all" variant="secondary" onPress={() => setKeep(new Set())} />
          </View>
          <View style={styles.flex}>
            <Button label="Keep all existing" variant="secondary" onPress={() => setKeep(new Set(conflicts.map((c) => c.index)))} />
          </View>
        </View>
        <Group>
          {conflicts.map((c) => {
            const keeping = keep.has(c.index);
            return (
              <Option
                key={c.index}
                label={c.displayName}
                detail={
                  keeping
                    ? `Keep ${c.existingAmountText || 'as is'}`
                    : `Combine: ${[c.existingAmountText || '1', c.incomingAmountText || '1'].join(' + ')}`
                }
                icon={keeping ? 'pin' : 'plus.circle'}
                accessibilityHint="Switches between Combine and Keep existing"
                onPress={() => setKeep(toggle(keep, c.index))}
              />
            );
          })}
        </Group>
        <Button label={`Add to ${listName}`} onPress={() => finish(keep)} />
      </Screen>
    );
  }

  return (
    <Screen scroll contentContainerStyle={{ padding: spacing.lg, gap: spacing.xl }}>
      <Stack.Screen options={{ title: `Add ${recipe.name}` }} />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>Cancel</Stack.Toolbar.Button>
      </Stack.Toolbar>

      {lists.length > 1 ? (
        <Section title="List">
          <Group>
            {lists.map((l) => (
              <Option
                key={l.id}
                label={l.name}
                icon={l.id === listId ? 'checkmark' : undefined}
                selected={l.id === listId}
                onPress={() => setListId(l.id)}
              />
            ))}
          </Group>
        </Section>
      ) : null}

      <Section title="Servings">
        <View style={[styles.row, { gap: spacing.sm }]}>
          {SERVINGS.map((s) => (
            <View key={s} style={styles.flex}>
              <Button
                label={`${s === 0.5 ? '½' : s}×`}
                variant={s === servings ? 'primary' : 'secondary'}
                accessibilityState={{ selected: s === servings }}
                onPress={() => setServings(s)}
              />
            </View>
          ))}
        </View>
      </Section>

      <Section title="Ingredients">
        <Group>
          {ingredients.map((i) => {
            const on = selected.has(i.id);
            const amount = formatAmount({ quantity: i.quantity === null ? null : i.quantity * servings, unit: i.unit });
            return (
              <Option
                key={i.id}
                label={i.displayName}
                detail={amount || undefined}
                icon={on ? 'checkmark.circle.fill' : 'circle'}
                selected={on}
                role="checkbox"
                onPress={() => setSelected(toggle(selected, i.id))}
              />
            );
          })}
        </Group>
      </Section>

      <Button
        label={adds.length === 0 ? 'Nothing selected' : `Add ${adds.length} to ${listName}`}
        disabled={adds.length === 0}
        onPress={add}
      />
    </Screen>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing.sm }}>
      <ThemedText variant="footnote" color="inkSecondary" accessibilityRole="header" style={{ paddingHorizontal: spacing.xs }}>
        {title}
      </ThemedText>
      {children}
    </View>
  );
}

function Group({ children }: { children: ReactNode }) {
  const { colors, rounded } = useTheme();
  return <View style={[styles.group, { backgroundColor: colors.surface, borderRadius: rounded.md }]}>{children}</View>;
}

function Option({
  label,
  detail,
  icon,
  selected,
  role = 'button',
  accessibilityHint,
  onPress,
}: {
  label: string;
  detail?: string;
  icon?: IconName;
  selected?: boolean;
  role?: 'button' | 'checkbox';
  accessibilityHint?: string;
  onPress: () => void;
}) {
  const { colors, spacing, sizes, opacity } = useTheme();
  return (
    <Pressable
      accessibilityRole={role}
      accessibilityState={role === 'checkbox' ? { checked: !!selected } : { selected }}
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        styles.option,
        {
          minHeight: sizes.minTapTarget,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          gap: spacing.sm,
          borderBottomColor: colors.border,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      {icon ? <Icon name={icon} color={selected ? 'primary' : 'inkSecondary'} size={sizes.iconLarge} /> : null}
      <ThemedText variant="body" style={styles.flex}>
        {label}
      </ThemedText>
      {detail ? (
        <ThemedText variant="callout" color="inkSecondary">
          {detail}
        </ThemedText>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  group: { overflow: 'hidden', borderCurve: 'continuous' },
  option: { borderBottomWidth: StyleSheet.hairlineWidth },
});
