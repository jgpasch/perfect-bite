import { Link, router, Stack } from 'expo-router';
import { useMemo } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { prominentButtonTint } from '@/components/appearance';
import { Badge } from '@/components/badge';
import { PrimaryButton } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { IconTile } from '@/components/icon-tile';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { useLiveQueryOn } from '@/db/live-query';
import { recipeHue } from '@/domain/aisle-color';
import { promptRecipeName } from '@/features/recipes/prompt-recipe-name';
import { groupRecipesByHousehold, ingredientCountLabel, onListByRecipe, recipeCardLabel } from '@/features/recipes/recipe-view';
import {
  deleteRecipe,
  RECIPES_TAB_TABLES,
  recipesOnListsQuery,
  recipesQuery,
  type RecipeSummary,
} from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';

/** Recipes tab (spec 4.5, board 05): a card per recipe under each household's name. */
export default function RecipesScreen() {
  const { spacing, scheme, colors } = useTheme();
  const { data } = useLiveQueryOn(recipesQuery(), RECIPES_TAB_TABLES);
  const { data: onLists } = useLiveQueryOn(recipesOnListsQuery(), RECIPES_TAB_TABLES);
  const groups = useMemo(() => groupRecipesByHousehold(data), [data]);
  const onList = useMemo(() => onListByRecipe(onLists), [onLists]);

  const create = () => promptRecipeName(null, '', (id) => router.push({ pathname: '/recipe/[id]', params: { id } }));

  return (
    <Screen>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="plus"
          variant="prominent"
          tintColor={prominentButtonTint(scheme, colors)}
          accessibilityLabel="New recipe"
          onPress={create}
        />
      </Stack.Toolbar>
      {data.length === 0 ? (
        <EmptyState message="No recipes yet." action={<PrimaryButton label="New recipe" onPress={create} />} />
      ) : (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: spacing.xl }}>
          {groups.map((group, i) => (
            <View key={group.householdId}>
              <ThemedText
                variant="sectionLabel"
                color="inkSecondary"
                accessibilityRole="header"
                style={{
                  paddingHorizontal: spacing.lg + spacing.xs,
                  paddingTop: i === 0 ? spacing.xs : spacing.lg + spacing.xxs,
                  paddingBottom: spacing.sm,
                }}>
                {group.name}
              </ThemedText>
              <View style={{ gap: spacing.sm + spacing.xxs, paddingHorizontal: spacing.lg }}>
                {group.recipes.map((r) => (
                  <RecipeCard key={r.id} recipe={r} onList={onList.get(r.id) ?? null} />
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </Screen>
  );
}

function RecipeCard({ recipe, onList }: { recipe: RecipeSummary; onList: string | null }) {
  const { colors, spacing, sizes, rounded } = useTheme();

  const confirmDelete = () =>
    Alert.alert(`Delete “${recipe.name}”?`, 'Items already on your lists stay there.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteRecipe(recipe.id) },
    ]);

  return (
    <Link href={{ pathname: '/recipe/[id]', params: { id: recipe.id } }} asChild>
      <Link.Trigger>
        <Pressable accessibilityRole="button" accessibilityLabel={recipeCardLabel(recipe.name, recipe.ingredientCount, onList)}>
          {/* Layout lives on a View: Link's trigger replaces the Pressable's style. */}
          <View
            style={[
              styles.card,
              {
                padding: spacing.md + spacing.xxs,
                gap: spacing.md + spacing.xxs,
                borderRadius: rounded.card,
                backgroundColor: colors.surface,
              },
            ]}>
            <IconTile hue={recipeHue(recipe.id)} name="fork.knife" size={sizes.recipeTile} />
            <View style={styles.flex}>
              <ThemedText variant="headline" numberOfLines={2}>
                {recipe.name}
              </ThemedText>
              <ThemedText variant="footnote" color="inkSecondary">
                {ingredientCountLabel(recipe.ingredientCount)}
              </ThemedText>
            </View>
            {onList ? (
              // Badge pins itself to the top; the wrapper centres it in the row.
              <View>
                <Badge label={`On ${onList}`} />
              </View>
            ) : null}
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
  card: { flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
});
