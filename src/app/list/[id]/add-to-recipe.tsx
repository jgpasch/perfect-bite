import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { IconTile } from '@/components/icon-tile';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { recipeHue } from '@/domain/aisle-color';
import { getAccount } from '@/features/auth/account';
import { categorizePending } from '@/features/categories/categorization';
import { listQuery } from '@/features/lists/lists';
import { setRecipeAddResult } from '@/features/lists/recipe-add-result';
import { addItemsToRecipe, makeRecipeFromItems } from '@/features/recipes/from-list';
import { addToRecipeTitle, ingredientCountLabel, recipeCardLabel } from '@/features/recipes/recipe-view';
import { recipesForPicker } from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';

/**
 * "Add to recipe" (spec 4.5): the selected list items go into a new recipe (name it, Return) or an
 * existing one of the list's household, most recently used first. The list screen under the sheet
 * then leaves Select mode, switches to By recipe and shows the toast (`takeRecipeAddResult`).
 */
export default function AddToRecipeSheet() {
  const { id, items } = useLocalSearchParams<{ id: string; items: string }>();
  const { colors, spacing, sizes, opacity } = useTheme();
  const userId = getAccount()?.userId ?? null;

  // A sheet is short-lived: read once rather than live.
  const [itemIds] = useState(() => (items ? items.split(',').filter(Boolean) : []));
  const [list] = useState(() => listQuery(id).get());
  const [recipes] = useState(() => (list ? recipesForPicker(list.householdId) : []));
  const [name, setName] = useState('');

  if (!list || itemIds.length === 0) return <Screen />;

  const finish = (recipeId: string, recipeName: string, pendingNames: string[]) => {
    void categorizePending(pendingNames);
    setRecipeAddResult({ listId: id, recipeId, recipeName, count: itemIds.length });
    router.back();
  };

  const createNew = () => {
    const trimmed = name.trim().replace(/\s+/g, ' ');
    if (!trimmed) return;
    const { recipeId, pendingNames } = makeRecipeFromItems(trimmed, itemIds, userId, list.householdId);
    finish(recipeId, trimmed, pendingNames);
  };

  return (
    <Screen>
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button onPress={() => router.back()}>Cancel</Stack.Toolbar.Button>
      </Stack.Toolbar>
      <ScrollView
        style={styles.flex}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.lg }}>
        <ThemedText variant="title" accessibilityRole="header" style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
          {addToRecipeTitle(itemIds.length)}
        </ThemedText>

        <Card>
          <View style={[styles.row, { minHeight: sizes.cardRowMin, paddingLeft: spacing.lg, gap: spacing.md }]}>
            <View style={[styles.center, { width: sizes.iconWell }]}>
              <Icon name="plus.circle.fill" color="primary" />
            </View>
            <TextField
              value={name}
              onChangeText={setName}
              placeholder="New recipe"
              accessibilityLabel="New recipe name"
              accessibilityHint="Type a name, then Return to make the recipe"
              returnKeyType="done"
              autoCapitalize="words"
              onSubmitEditing={createNew}
              style={[styles.flex, { borderWidth: 0, backgroundColor: colors.surface, paddingLeft: 0 }]}
            />
          </View>
        </Card>

        {recipes.length > 0 ? (
          <Card>
            {recipes.map((r, i) => (
              <Pressable
                key={r.id}
                accessibilityRole="button"
                accessibilityLabel={recipeCardLabel(r.name, r.ingredientCount)}
                onPress={() => finish(r.id, r.name, addItemsToRecipe(r.id, itemIds, userId))}
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
                <IconTile hue={recipeHue(r.id)} name="fork.knife" />
                <View style={styles.flex}>
                  <ThemedText variant="body">{r.name}</ThemedText>
                  <ThemedText variant="footnote" color="inkSecondary">
                    {ingredientCountLabel(r.ingredientCount)}
                  </ThemedText>
                </View>
              </Pressable>
            ))}
          </Card>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { alignItems: 'center', justifyContent: 'center' },
});
