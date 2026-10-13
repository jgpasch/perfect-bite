import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { PrimaryButton } from '@/components/button';
import { Card } from '@/components/card';
import { SectionHeader } from '@/components/section-header';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { Toast } from '@/components/toast';
import {
  householdCategoryOverrides,
  ingredients as ingredientsTable,
  recipeIngredients,
  recipes,
  type Recipe,
  type RecipeIngredient,
} from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { aisleColor, recipeHue, type AisleHue } from '@/domain/aisle-color';
import { formatAmount } from '@/domain/quantity-display';
import { ingredientAisles } from '@/features/categories/categories';
import { categorizePending } from '@/features/categories/categorization';
import { ItemAddBar } from '@/features/lists/add-bar';
import { promptRecipeName } from '@/features/recipes/prompt-recipe-name';
import { RecipeIngredientRow } from '@/features/recipes/recipe-ingredient-row';
import { normalizeRecipeLink } from '@/features/recipes/recipe-link';
import { RecipeLinkRow } from '@/features/recipes/recipe-link-row';
import { RecipeTagRow } from '@/features/recipes/recipe-tag-row';
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
import { displayItemName } from '@/shared';

/** A recipe (spec 4.5, board 06): ingredients added with the same field and parser as lists. */
export default function RecipeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { spacing, aisles } = useTheme();
  const headerHeight = useHeaderHeight();
  const { data: recipeRows } = useLiveQueryOn(recipeQuery(id), [recipes], [id]);
  const recipe = recipeRows[0];
  // ingredients and overrides: re-read when an ingredient gets its aisle, so its dot follows.
  const { data: ingredients } = useLiveQueryOn(
    recipeIngredientsQuery(id),
    [recipeIngredients, ingredientsTable, householdCategoryOverrides],
    [id],
  );
  // The recipe household's aisles (spec 4.3.2).
  const householdId = recipe?.householdId ?? '';
  const aisleOf = useMemo(
    () => ingredientAisles(householdId, [...new Set(ingredients.map((i) => i.ingredientName))]),
    [householdId, ingredients],
  );
  const [deleted, setDeleted] = useState<RecipeIngredient | null>(null);
  const dismissToast = useCallback(() => setDeleted(null), []);

  if (!recipe) return <Screen />;

  const hue = recipeHue(recipe.id);

  const edit = (ingredient: RecipeIngredient) => {
    const amount = formatAmount(ingredient);
    Alert.prompt(
      'Edit ingredient',
      undefined,
      (text) => {
        if (!text?.trim()) return;
        try {
          void categorizePending(updateRecipeIngredient(ingredient.id, text, ingredient.note ?? ''));
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
      {/* The native header takes the band's tint, so back and actions sit on it (board 06). */}
      <Stack.Screen options={{ headerStyle: { backgroundColor: aisles[hue].soft } }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel="Recipe actions">
          <Stack.Toolbar.MenuAction icon="pencil" onPress={() => promptRecipeName(id, recipe.name)}>
            Rename
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="trash" destructive onPress={confirmDelete}>
            Delete recipe
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={headerHeight}>
        <ScrollView
          style={styles.flex}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={{ paddingBottom: spacing.lg }}>
          <RecipeBand recipe={recipe} hue={hue} />
          <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.md }}>
            <PrimaryButton
              label="Add to a list"
              icon="cart"
              disabled={ingredients.length === 0}
              onPress={() => router.push({ pathname: '/recipe/[id]/add-to-list', params: { id } })}
            />
          </View>
          <Card>
            <SectionHeader title="Ingredients" count={ingredients.length} />
            {ingredients.length === 0 ? (
              <ThemedText
                variant="callout"
                color="inkSecondary"
                style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.xs, paddingBottom: spacing.lg }}>
                No ingredients yet. Add them below.
              </ThemedText>
            ) : (
              ingredients.map((item) => (
                <RecipeIngredientRow
                  key={item.id}
                  ingredient={item}
                  dotColor={aisles[aisleColor(aisleOf.get(item.ingredientName)?.slug)].dot}
                  onEdit={() => edit(item)}
                  onDelete={() => {
                    deleteRecipeIngredient(item.id);
                    setDeleted(item);
                  }}
                />
              ))
            )}
          </Card>
        </ScrollView>
        {deleted ? (
          <View style={{ paddingBottom: spacing.sm }}>
            <Toast
              key={deleted.id}
              message={`Removed ${displayItemName(deleted.displayName)}`}
              actions={[{ label: 'Undo', onPress: () => (undeleteRecipeIngredient(deleted.id), setDeleted(null)) }]}
              onDismiss={dismissToast}
            />
          </View>
        ) : null}
        <ItemAddBar
          householdId={recipe.householdId}
          onAdd={(text) => void categorizePending(addRecipeIngredient(id, text)?.pendingNames ?? [])}
          placeholder="Add 2 cups flour…"
          accessibilityLabel="Add an ingredient"
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}

/**
 * The header band in the recipe's soft tint: its name, source link, tags and notes. The notes are edited
 * in place and saved when the field loses focus; the link row is RecipeLinkRow.
 */
function RecipeBand({ recipe, hue }: { recipe: Recipe; hue: AisleHue }) {
  const { colors, aisles, spacing, typography, sizes } = useTheme();
  const [notes, setNotes] = useState(recipe.notes ?? '');
  const [sourceUrl, setSourceUrl] = useState(recipe.sourceUrl ?? '');
  const save = () => updateRecipe(recipe.id, { name: recipe.name, notes, sourceUrl });
  const saveLink = (text: string) => {
    const link = normalizeRecipeLink(text);
    setSourceUrl(link);
    updateRecipe(recipe.id, { name: recipe.name, notes, sourceUrl: link });
  };
  const tint = aisles[hue];

  return (
    <View
      style={{
        backgroundColor: tint.soft,
        paddingHorizontal: spacing.lg + spacing.xs,
        paddingTop: spacing.md + spacing.xxs,
        paddingBottom: spacing.lg + spacing.xs,
        gap: spacing.sm,
      }}>
      <ThemedText variant="screenTitle" accessibilityRole="header">
        {recipe.name}
      </ThemedText>
      <RecipeLinkRow value={sourceUrl} hue={hue} onSave={saveLink} />
      <RecipeTagRow
        recipe={recipe}
        hue={hue}
        onEdit={() => router.push({ pathname: '/recipe/[id]/tags', params: { id: recipe.id } })}
      />
      <TextInput
        value={notes}
        onChangeText={setNotes}
        onEndEditing={save}
        placeholder="Add notes"
        placeholderTextColor={colors.inkSecondary}
        selectionColor={tint.strong}
        accessibilityLabel="Notes"
        multiline
        style={[typography.callout, { color: colors.ink, minHeight: sizes.minTapTarget }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
});
