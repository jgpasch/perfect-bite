import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, StyleSheet, View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { UndoToast } from '@/components/undo-toast';
import { recipeIngredients, recipes, type Recipe, type RecipeIngredient } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { formatAmount } from '@/domain/quantity-display';
import { AddBar } from '@/features/lists/add-bar';
import { promptRecipeName } from '@/features/recipes/prompt-recipe-name';
import { RecipeIngredientRow } from '@/features/recipes/recipe-ingredient-row';
import {
  addRecipeIngredient,
  deleteRecipe,
  deleteRecipeIngredient,
  recipeIngredientsQuery,
  recipeQuery,
  undeleteRecipeIngredient,
  updateRecipe,
  updateRecipeIngredient,
} from '@/features/recipes/recipes';
import { useTheme } from '@/hooks/use-theme';

/** A recipe (spec 4.5): ingredients added with the same field and parser as lists. */
export default function RecipeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { spacing } = useTheme();
  const headerHeight = useHeaderHeight();
  const { data: recipeRows } = useLiveQueryOn(recipeQuery(id), [recipes], [id]);
  const recipe = recipeRows[0];
  const { data: ingredients } = useLiveQueryOn(recipeIngredientsQuery(id), [recipeIngredients], [id]);
  const [deleted, setDeleted] = useState<RecipeIngredient | null>(null);
  const dismissToast = useCallback(() => setDeleted(null), []);

  if (!recipe) return <Screen />;

  const edit = (ingredient: RecipeIngredient) => {
    const amount = formatAmount(ingredient);
    Alert.prompt(
      'Edit ingredient',
      undefined,
      (text) => {
        if (!text?.trim()) return;
        try {
          updateRecipeIngredient(ingredient.id, text, ingredient.note ?? '');
        } catch (err) {
          Alert.alert(err instanceof Error ? err.message : String(err));
        }
      },
      'plain-text',
      amount ? `${amount} ${ingredient.displayName}` : ingredient.displayName,
    );
  };

  const confirmDelete = () =>
    Alert.alert(`Delete “${recipe.name}”?`, 'Items already on your lists stay there.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          deleteRecipe(id);
          router.back();
        },
      },
    ]);

  return (
    <Screen>
      <Stack.Screen options={{ title: recipe.name }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="ellipsis.circle" accessibilityLabel="Recipe actions">
          <Stack.Toolbar.MenuAction
            icon="cart.badge.plus"
            disabled={ingredients.length === 0}
            onPress={() => router.push({ pathname: '/recipe/[id]/add-to-list', params: { id } })}>
            Add to list…
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="pencil" onPress={() => promptRecipeName(id, recipe.name)}>
            Rename
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="trash" destructive onPress={confirmDelete}>
            Delete recipe
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={headerHeight}>
        <FlatList
          style={styles.flex}
          data={ingredients}
          keyExtractor={(i) => i.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={{ paddingBottom: spacing.lg }}
          ListHeaderComponent={<RecipeDetails recipe={recipe} />}
          ListEmptyComponent={<EmptyState message="No ingredients yet. Add them below." />}
          renderItem={({ item }) => (
            <RecipeIngredientRow
              ingredient={item}
              onEdit={() => edit(item)}
              onDelete={() => {
                deleteRecipeIngredient(item.id);
                setDeleted(item);
              }}
            />
          )}
        />
        {deleted ? (
          <View style={{ paddingBottom: spacing.sm }}>
            <UndoToast
              key={deleted.id}
              message={`Removed ${deleted.displayName}`}
              actions={[{ label: 'Undo', onPress: () => (undeleteRecipeIngredient(deleted.id), setDeleted(null)) }]}
              onDismiss={dismissToast}
            />
          </View>
        ) : null}
        <AddBar
          householdId={recipe.householdId}
          onAdd={(text) => addRecipeIngredient(id, text)}
          placeholder="Add an ingredient, like 2 cups flour"
          accessibilityLabel="Add an ingredient"
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** Notes and source link, saved when the field loses focus. */
function RecipeDetails({ recipe }: { recipe: Recipe }) {
  const { spacing } = useTheme();
  const [notes, setNotes] = useState(recipe.notes ?? '');
  const [sourceUrl, setSourceUrl] = useState(recipe.sourceUrl ?? '');
  const save = () => updateRecipe(recipe.id, { name: recipe.name, notes, sourceUrl });

  return (
    <View style={{ padding: spacing.lg, gap: spacing.md }}>
      <TextField value={notes} onChangeText={setNotes} onEndEditing={save} placeholder="Notes" accessibilityLabel="Notes" multiline />
      <TextField
        value={sourceUrl}
        onChangeText={setSourceUrl}
        onEndEditing={save}
        placeholder="Link to the recipe"
        accessibilityLabel="Link to the recipe"
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <ThemedText variant="footnote" color="inkSecondary" accessibilityRole="header" style={{ paddingTop: spacing.md }}>
        Ingredients
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({ flex: { flex: 1 } });
