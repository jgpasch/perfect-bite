import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { Button, PrimaryButton, SurfaceButton } from '@/components/button';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { Pill } from '@/components/pill';
import { SectionHeader } from '@/components/section-header';
import { SegmentedControl } from '@/components/segmented-control';
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
import { PlanBadges } from '@/features/meal-plan/plan-badges';
import { useFeature } from '@/features/plans/features';
import { ensureStepMatchSoon, useEnsureStepMatch } from '@/features/recipes/ensure-step-match';
import { promptRecipeName } from '@/features/recipes/prompt-recipe-name';
import { RecipeIngredientRow } from '@/features/recipes/recipe-ingredient-row';
import { normalizeRecipeLink } from '@/features/recipes/recipe-link';
import { RecipeMethodCard } from '@/features/recipes/recipe-method-card';
import { RecipeLinkRow } from '@/features/recipes/recipe-link-row';
import { dismissPhotoUpload, retryPhotoUpload, usePhotoUpload } from '@/features/recipes/photo-upload';
import { RecipePhotoHeader } from '@/features/recipes/recipe-photo';
import { useRecipePhoto } from '@/features/recipes/recipe-photo-source';
import { dismissPhotoChange, undoPhotoChange, usePhotoChange } from '@/features/recipes/recipe-photos';
import { RecipeTagRow } from '@/features/recipes/recipe-tag-row';
import {
  forServingsLabel,
  methodTab,
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
import { useT } from '@/i18n';
import { displayItemName } from '@/shared';

/** A recipe (spec 4.5, board 06): ingredients added with the same field and parser as lists. */
export default function RecipeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useT();
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
  // The household's own photo, else the site's (spec 4.5).
  const photo = useRecipePhoto(recipe ?? null);
  // The Choose a photo sheet's change, for the "Photo updated" toast; it ends when the screen closes.
  const photoChange = usePhotoChange(id);
  useEffect(() => () => dismissPhotoChange(), []);
  const dismissPhotoToast = useCallback(() => dismissPhotoChange(photoChange?.key), [photoChange?.key]);
  // A photo from the library or camera on its way up, then "Couldn't upload the photo" if it fails.
  const upload = usePhotoUpload(id);
  useEffect(() => () => dismissPhotoUpload(), []);
  const dismissUploadToast = useCallback(() => dismissPhotoUpload(upload?.key), [upload?.key]);
  // Ingredients | Method, only with steps. Opens on Ingredients every visit and isn't saved.
  const [tab, setTab] = useState<RecipeTab>('ingredients');
  const scroll = useRef<ScrollView>(null);
  const scrollY = useRef(0);
  // Opening the recipe matches its steps if they need it (spec 4.5).
  useEnsureStepMatch(id);
  const switchY = useRef(0);
  // Switching brings the card into view when the switch has scrolled off the top.
  const switchTab = (next: RecipeTab) => {
    setTab(next);
    if (scrollY.current > switchY.current) scroll.current?.scrollTo({ y: switchY.current, animated: true });
  };

  if (!recipe) return <Screen />;

  const hue = recipeHue(recipe.id);
  // A photo that failed to load is dropped for this visit, and the band's tinted header comes back.
  // While a new photo uploads, it shows from the device.
  const uploading = upload?.status === 'uploading';
  const photoSource = uploading ? upload.localUri : photo.source;
  const hasPhoto = recipe.imageUrl !== null || recipe.photoPath !== null;
  const base = recipe.servings;
  const servings = base === null ? null : (chosen ?? base);
  const steps = recipe.steps?.length ?? 0;

  const editServings = () =>
    Alert.prompt(
      t('recipes.servings.title'),
      t('recipes.servings.prompt'),
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
      t('recipes.screen.editIngredient'),
      undefined,
      (text) => {
        if (!text?.trim()) return;
        try {
          void categorizePending(updateRecipeIngredient(ingredient.id, text, ingredient.note ?? ''));
          ensureStepMatchSoon(id);
        } catch (err) {
          Alert.alert(err instanceof Error ? err.message : String(err));
        }
      },
      'plain-text',
      amount ? `${amount} ${ingredient.displayName}` : ingredient.displayName,
    );
  };

  // Spec 4.16: the plan modal, for Plan and the plan badges.
  const openPlan = () => router.push({ pathname: '/plan-recipe', params: { recipeId: id } });
  // Spec 4.5: the Choose a photo sheet, for the Add photo tile and Change photo….
  const openPhoto = () => router.push({ pathname: '/recipe/[id]/photo', params: { id } });

  const confirmDelete = () =>
    Alert.alert(t('recipes.tab.deleteTitle', { name: recipe.name }), t('recipes.tab.deleteMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
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
          photoSource
            ? { headerTransparent: true, headerStyle: { backgroundColor: 'transparent' }, headerShadowVisible: false }
            : { headerTransparent: false, headerStyle: { backgroundColor: aisles[hue].soft } }
        }
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel={t('recipes.screen.actions')}>
          <Stack.Toolbar.MenuAction icon="pencil" onPress={() => promptRecipeName(id, recipe.name)}>
            {t('recipes.screen.rename')}
          </Stack.Toolbar.MenuAction>
          {hasPhoto ? (
            <Stack.Toolbar.MenuAction icon="photo" onPress={openPhoto}>
              {t('recipes.photo.change')}
            </Stack.Toolbar.MenuAction>
          ) : null}
          <Stack.Toolbar.MenuAction icon="trash" destructive onPress={confirmDelete}>
            {t('recipes.screen.deleteRecipe')}
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      {/* Under a transparent header the screen starts at the top, so there's no header to offset. */}
      <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={photoSource ? 0 : headerHeight}>
        <ScrollView
          ref={scroll}
          style={styles.flex}
          onScroll={(e) => (scrollY.current = e.nativeEvent.contentOffset.y)}
          scrollEventThrottle={16}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          // The photo runs up under the status bar and the header's buttons.
          contentInsetAdjustmentBehavior="never"
          contentContainerStyle={{ paddingBottom: spacing.lg }}>
          {photoSource ? (
            <RecipePhotoHeader
              source={photoSource}
              tint={aisles[hue].soft}
              // The source credit is for the site's photo, never the household's own.
              sourceUrl={uploading || photo.own ? null : recipe.sourceUrl}
              uploading={uploading}
              onError={uploading ? () => {} : photo.onError}
            />
          ) : null}
          <RecipeBand
            recipe={recipe}
            hue={hue}
            showAddPhoto={!hasPhoto && !uploading}
            hasIngredients={ingredients.length > 0}
            onEditServings={editServings}
            onPlan={openPlan}
            onAddPhoto={openPhoto}
          />
          {/* Board 13: Add to a list takes the row's room, with Cook beside it when there are steps, then Plan
              (spec 4.16). They wrap when they don't fit. */}
          <View
            style={[
              styles.row,
              styles.wrap,
              { gap: spacing.sm + spacing.xxs, paddingHorizontal: spacing.lg, paddingTop: spacing.lg, paddingBottom: spacing.md },
            ]}>
            <View style={styles.grow}>
              <PrimaryButton
                label={t('recipes.screen.addToAList')}
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
            {steps > 0 ? (
              <SurfaceButton
                label={t('recipes.screen.cook')}
                accessibilityLabel={t('recipes.screen.startCooking')}
                icon="flame"
                iconTint={aisles[hue].strong}
                on="surface"
                onPress={() =>
                  router.push({
                    pathname: '/recipe/[id]/cook',
                    // Board 19: the ingredients are scaled to the stepper's servings.
                    params: servings !== null ? { id, servings: String(servings) } : { id },
                  })
                }
              />
            ) : null}
            <SurfaceButton label={t('recipes.screen.plan')} icon="calendar" iconTint={aisles[hue].strong} on="surface" onPress={openPlan} />
          </View>
          {/* With steps, one card at a time under the switch; without, Ingredients over the Method's Add steps. */}
          {steps > 0 ? (
            <View onLayout={(e) => (switchY.current = e.nativeEvent.layout.y)} style={{ paddingBottom: spacing.md }}>
              <SegmentedControl
                segments={[{ value: 'ingredients', label: t('recipes.screen.ingredients') }, { value: 'method', ...methodTab(steps) }]}
                value={tab}
                onChange={switchTab}
              />
            </View>
          ) : null}
          {steps === 0 || tab === 'ingredients' ? (
            <Card>
              <SectionHeader
                title={t('recipes.screen.ingredients')}
                count={ingredients.length}
                trailing={
                  base !== null && servings !== null ? (
                    <View style={[styles.row, { gap: spacing.xxs }]}>
                      {servings !== base ? (
                        <Button variant="plain" label={t('recipes.screen.reset')} onPress={() => setChosen(null)} />
                      ) : null}
                      <Stepper
                        value={servings}
                        min={SERVINGS_MIN}
                        max={SERVINGS_MAX}
                        onChange={setChosen}
                        label={forServingsLabel(servings)}
                        accessibilityLabel={t('recipes.servings.title')}
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
                  {t('recipes.screen.noIngredients')}
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
                      ensureStepMatchSoon(id);
                      setDeleted(item);
                    }}
                  />
                ))
              )}
            </Card>
          ) : null}
          {steps === 0 ? <View style={{ height: spacing.md }} /> : null}
          {steps === 0 || tab === 'method' ? (
            <RecipeMethodCard
              steps={recipe.steps}
              hue={hue}
              sourceUrl={recipe.sourceUrl}
              onEdit={() => router.push({ pathname: '/recipe/[id]/steps', params: { id } })}
            />
          ) : null}
        </ScrollView>
        {photoChange ? (
          <View style={{ paddingBottom: spacing.sm }}>
            <Toast
              key={`photo-${photoChange.key}`}
              message={t(photoChange.removed ? 'recipes.photo.removed' : 'recipes.photo.updated')}
              actions={[{ label: t('common.undo'), onPress: () => undoPhotoChange(photoChange) }]}
              onDismiss={dismissPhotoToast}
            />
          </View>
        ) : null}
        {upload?.status === 'failed' ? (
          <View style={{ paddingBottom: spacing.sm }}>
            <Toast
              key={`upload-${upload.key}`}
              message={t('recipes.photo.uploadFailed')}
              actions={[{ label: t('common.tryAgain'), onPress: () => void retryPhotoUpload(upload) }]}
              onDismiss={dismissUploadToast}
            />
          </View>
        ) : null}
        {deleted ? (
          <View style={{ paddingBottom: spacing.sm }}>
            <Toast
              key={deleted.id}
              message={t('recipes.screen.removed', { name: displayItemName(deleted.displayName) })}
              actions={[{ label: t('common.undo'), onPress: () => (undeleteRecipeIngredient(deleted.id), ensureStepMatchSoon(id), setDeleted(null)) }]}
              onDismiss={dismissToast}
            />
          </View>
        ) : null}
        <ItemAddBar
          householdId={recipe.householdId}
          onAdd={(text) => {
            void categorizePending(addRecipeIngredient(id, text)?.pendingNames ?? []);
            ensureStepMatchSoon(id);
          }}
          placeholder={t('recipes.screen.addPlaceholder')}
          accessibilityLabel={t('recipes.screen.addLabel')}
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}

/**
 * The header band in the recipe's soft tint: its name, source link and servings, tags and notes. The notes
 * are edited in place and saved when the field loses focus; the link row is RecipeLinkRow. "Serves 4", or a
 * dashed "Add servings" without them, opens the servings prompt (`onEditServings`). Under the name, the
 * recipe's upcoming plan badges open the plan modal (`onPlan`). Without a photo (`showAddPhoto`), a
 * dashed Add photo tile at the top, where the photo would be, opens the Choose a photo sheet (`onAddPhoto`).
 */
function RecipeBand({
  recipe,
  hue,
  showAddPhoto,
  hasIngredients,
  onEditServings,
  onPlan,
  onAddPhoto,
}: {
  recipe: Recipe;
  hue: AisleHue;
  showAddPhoto: boolean;
  hasIngredients: boolean;
  onEditServings: () => void;
  onPlan: () => void;
  onAddPhoto: () => void;
}) {
  const t = useT();
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
      {showAddPhoto ? <AddPhotoTile onPress={onAddPhoto} /> : null}
      <ThemedText variant="screenTitle" accessibilityRole="header">
        {recipe.name}
      </ThemedText>
      <PlanBadges recipeId={recipe.id} onOpen={onPlan} />
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
            accessibilityHint={t('recipes.servings.editHint')}
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
          <Pill dashed icon="person.2" label={t('recipes.servings.add')} onPress={onEditServings} />
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
        placeholder={t('recipes.screen.addNotes')}
        placeholderTextColor={colors.inkSecondary}
        selectionColor={tint.strong}
        accessibilityLabel={t('recipes.screen.notes')}
        multiline
        style={[typography.callout, { color: colors.ink, minHeight: sizes.minTapTarget }]}
      />
    </View>
  );
}

/** The band's Add photo tile (spec 4.5): a 2 pt dashed `controlBorder` outline, radius `md`. VoiceOver: "Add photo, button". */
function AddPhotoTile({ onPress }: { onPress: () => void }) {
  const t = useT();
  const { colors, spacing, rounded, sizes, opacity } = useTheme();
  return (
    <Pressable
      testID="add-photo"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('recipes.photo.add')}
      style={({ pressed }) => [
        styles.row,
        styles.center,
        {
          gap: spacing.sm,
          minHeight: sizes.minTapTarget,
          paddingVertical: spacing.xl,
          marginBottom: spacing.xs,
          borderWidth: sizes.checkBorder,
          borderStyle: 'dashed',
          borderColor: colors.controlBorder,
          borderRadius: rounded.md,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <Icon name="photo.badge.plus" tint={colors.inkSecondary} weight="semibold" />
      <ThemedText variant="headline" color="inkSecondary">
        {t('recipes.photo.add')}
      </ThemedText>
    </Pressable>
  );
}

type RecipeTab = 'ingredients' | 'method';

const styles = StyleSheet.create({
  flex: { flex: 1 },
  grow: { flexGrow: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  wrap: { flexWrap: 'wrap' },
  center: { justifyContent: 'center' },
});
