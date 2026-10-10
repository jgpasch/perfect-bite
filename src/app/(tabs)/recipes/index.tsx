import { Link, router, Stack } from 'expo-router';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { PrimaryButton } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { recipeIngredients, recipes } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { promptRecipeName } from '@/features/recipes/prompt-recipe-name';
import { deleteRecipe, recipesQuery, type RecipeSummary } from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';

/** Recipes tab (spec 4.5). With one household there is no household UI (M7 adds sections). */
export default function RecipesScreen() {
  const { spacing } = useTheme();
  const { data } = useLiveQueryOn(recipesQuery(), [recipes, recipeIngredients]);

  const create = () => promptRecipeName(null, '', (id) => router.push({ pathname: '/recipe/[id]', params: { id } }));

  return (
    <Screen>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="plus" accessibilityLabel="New recipe" onPress={create} />
      </Stack.Toolbar>
      {data.length === 0 ? (
        <EmptyState message="No recipes yet." action={<PrimaryButton label="New recipe" onPress={create} />} />
      ) : (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: spacing.xl }}>
          {data.map((r, i) => (
            <RecipeRow key={r.id} recipe={r} last={i === data.length - 1} />
          ))}
        </ScrollView>
      )}
    </Screen>
  );
}

function RecipeRow({ recipe, last }: { recipe: RecipeSummary; last: boolean }) {
  const { colors, spacing, sizes } = useTheme();
  const count = recipe.ingredientCount;
  const countText = `${count} ${count === 1 ? 'ingredient' : 'ingredients'}`;

  const confirmDelete = () =>
    Alert.alert(`Delete “${recipe.name}”?`, 'Items already on your lists stay there.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteRecipe(recipe.id) },
    ]);

  return (
    <Link href={{ pathname: '/recipe/[id]', params: { id: recipe.id } }} asChild>
      <Link.Trigger>
        <Pressable accessibilityRole="button" accessibilityLabel={`${recipe.name}, ${countText}`}>
          {/* Layout lives on a View: Link's trigger replaces the Pressable's style. */}
          <View
            style={[
              styles.row,
              {
                minHeight: sizes.rowMin,
                paddingHorizontal: spacing.lg,
                paddingVertical: spacing.md,
                gap: spacing.md,
                borderBottomColor: colors.border,
                borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
              },
            ]}>
            <View style={styles.flex}>
              <ThemedText variant="body" numberOfLines={1}>
                {recipe.name}
              </ThemedText>
              <ThemedText variant="footnote" color="inkSecondary">
                {countText}
              </ThemedText>
            </View>
            <Icon name="chevron.right" color="inkSecondary" size={sizes.iconSmall} />
          </View>
        </Pressable>
      </Link.Trigger>
      <Link.Menu>
        <Link.MenuAction title="Rename" icon="pencil" onPress={() => promptRecipeName(recipe.id, recipe.name)} />
        <Link.MenuAction title="Delete" icon="trash" destructive onPress={confirmDelete} />
      </Link.Menu>
    </Link>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
});
