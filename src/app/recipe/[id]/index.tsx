import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { Button, PrimaryButton } from '@/components/button';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { Pill } from '@/components/pill';
import { SectionHeader } from '@/components/section-header';
import { Stepper } from '@/components/stepper';
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
import { useFeature } from '@/features/plans/features';
import { promptRecipeName } from '@/features/recipes/prompt-recipe-name';
import { RecipeIngredientRow } from '@/features/recipes/recipe-ingredient-row';
import { normalizeRecipeLink } from '@/features/recipes/recipe-link';
import { RecipeLinkRow } from '@/features/recipes/recipe-link-row';
import { RecipePhotoHeader, usePhotoFailed } from '@/features/recipes/recipe-photo';
import { RecipeTagRow } from '@/features/recipes/recipe-tag-row';
import {
  forServingsLabel,
  parseServings,
  scaledAmount,
  servesLabel,
  SERVINGS_MAX,
  SERVINGS_MIN,
} from '@/features/recipes/recipe-view';
import {
  addRecipeIngredient,
  deleteRecipe,
  deleteRecipeIngredient,
  recipeIngredientsQuery,
  recipeQuery,
  undeleteRecipeIngredient,
  updateRecipe,
  updateRecipeIngredient,
  updateRecipeServings,
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
  // The stepper's servings: null is the recipe's own. Kept only while the screen is open.
  const [chosen, setChosen] = useState<number | null>(null);
  const photo = usePhotoFailed(recipe?.imageUrl ?? null);

  if (!recipe) return <Screen />;

  const hue = recipeHue(recipe.id);
  // A photo that failed to load is dropped for this visit, and the band's tinted header comes back.
  const imageUrl = photo.failed ? null : recipe.imageUrl;
  const base = recipe.servings;
  const servings = base === null ? null : (chosen ?? base);

  const editServings = () =>
    Alert.prompt(
      'Servings',
      'How many people it serves, 1 to 100. Leave it empty to remove.',
      (text) => {
        const parsed = parseServings(text ?? '');
        if ('error' in parsed) return Alert.alert(parsed.error);
        updateRecipeServings(recipe.id, parsed.servings);
        setChosen(null);
      },
      'plain-text',
      base === null ? '' : String(base),
      'number-pad',
    );

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
      {/* With a photo the native header is transparent over it (board 13); without, it takes the band's
          tint, so back and actions sit on it (board 06). */}
      <Stack.Screen
        options={
          imageUrl
            ? { headerTransparent: true, headerStyle: { backgroundColor: 'transparent' }, headerShadowVisible: false }
            : { headerTransparent: false, headerStyle: { backgroundColor: aisles[hue].soft } }
        }
      />
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

      {/* Under a transparent header the screen starts at the top, so there's no header to offset. */}
      <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={imageUrl ? 0 : headerHeight}>
        <ScrollView
          style={styles.flex}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          // The photo runs up under the status bar and the header's buttons.
          contentInsetAdjustmentBehavior="never"
          contentContainerStyle={{ paddingBottom: spacing.lg }}>
          {imageUrl ? <RecipePhotoHeader imageUrl={imageUrl} tint={aisles[hue].soft} onError={photo.onError} /> : null}
          <RecipeBand recipe={recipe} hue={hue} hasIngredients={ingredients.length > 0} onEditServings={editServings} />
          <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.md }}>
            <PrimaryButton
              label="Add to a list"
              icon="cart"
              disabled={ingredients.length === 0}
              onPress={() =>
                router.push({
                  pathname: '/recipe/[id]/add-to-list',
                  // Board 17: the sheet starts at the stepper's servings when it's off the base.
                  params: servings !== null && servings !== base ? { id, servings: String(servings) } : { id },
                })
              }
            />
          </View>
          <Card>
            <SectionHeader
              title="Ingredients"
              count={ingredients.length}
              trailing={
                base !== null && servings !== null ? (
                  <View style={[styles.row, { gap: spacing.xxs }]}>
                    {servings !== base ? <Button variant="plain" label="Reset" onPress={() => setChosen(null)} /> : null}
                    <Stepper
                      value={servings}
                      min={SERVINGS_MIN}
                      max={SERVINGS_MAX}
                      onChange={setChosen}
                      label={forServingsLabel(servings)}
                      accessibilityLabel="Servings"
                    />
                  </View>
                ) : undefined
              }
            />
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
                  amount={base !== null && servings !== null && servings !== base ? scaledAmount(item, servings, base) : undefined}
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
 * The header band in the recipe's soft tint: its name, source link and servings, tags and notes. The notes
 * are edited in place and saved when the field loses focus; the link row is RecipeLinkRow. "Serves 4", or a
 * dashed "Add servings" without them, opens the servings prompt (`onEditServings`).
 */
function RecipeBand({
  recipe,
  hue,
  hasIngredients,
  onEditServings,
}: {
  recipe: Recipe;
  hue: AisleHue;
  hasIngredients: boolean;
  onEditServings: () => void;
}) {
  const { colors, aisles, spacing, typography, sizes, opacity } = useTheme();
  const canSuggest = useFeature('recipe_tags') && hasIngredients;
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
      {/* The link and the servings share a line (boards 13 and 15). */}
      <View style={[styles.row, { gap: spacing.md + spacing.xxs }]}>
        <View style={styles.flex}>
          <RecipeLinkRow value={sourceUrl} hue={hue} onSave={saveLink} />
        </View>
        {recipe.servings !== null ? (
          <Pressable
            onPress={onEditServings}
            accessibilityRole="button"
            accessibilityLabel={servesLabel(recipe.servings)}
            accessibilityHint="Edits the servings"
            style={({ pressed }) => [
              styles.row,
              { gap: spacing.xs + spacing.xxs, minHeight: sizes.minTapTarget, opacity: pressed ? opacity.pressed : 1 },
            ]}>
            <Icon name="person.2" tint={tint.strong} weight="semibold" />
            <ThemedText variant="amount" style={{ color: tint.strong }}>
              {servesLabel(recipe.servings)}
            </ThemedText>
          </Pressable>
        ) : (
          <Pill dashed icon="person.2" label="Add servings" onPress={onEditServings} />
        )}
      </View>
      <RecipeTagRow
        recipe={recipe}
        hue={hue}
        onEdit={() => router.push({ pathname: '/recipe/[id]/tags', params: { id: recipe.id } })}
        onSuggest={
          canSuggest
            ? () => router.push({ pathname: '/recipe/[id]/tags', params: { id: recipe.id, suggest: '1' } })
            : undefined
        }
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
