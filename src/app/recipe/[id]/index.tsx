import * as Haptics from 'expo-haptics';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import { Button } from '@/components/button';
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
import { getAccount } from '@/features/auth/account';
import { ingredientAisles } from '@/features/categories/categories';
import { categorizePending } from '@/features/categories/categorization';
import { isStaple, setStaple, stapleToast, useStapleNames } from '@/features/households/staples';
import { ItemAddBar } from '@/features/lists/add-bar';
import { openList, resolveCurrentListId } from '@/features/lists/current-list';
import { listsWithCountsQuery } from '@/features/lists/lists';
import { PlanBadges } from '@/features/meal-plan/plan-badges';
import {
  addedIngredientToast,
  addIngredientToList,
  ingredientMenuLists,
  servingsMultiplier,
  undoRecipeAdd,
  type RecipeListAdd,
} from '@/features/recipes/add-to-list';
import { AddIngredientRow } from '@/features/recipes/add-ingredient-row';
import { ensureStepMatchSoon, useEnsureStepMatch } from '@/features/recipes/ensure-step-match';
import { promptRecipeName } from '@/features/recipes/prompt-recipe-name';
import { quickAddTitle } from '@/features/recipes/quick-add';
import { RecipeIngredientRow } from '@/features/recipes/recipe-ingredient-row';
import { normalizeRecipeLink, openRecipeLink, recipeLinkParts } from '@/features/recipes/recipe-link';
import { RecipeMethodCard } from '@/features/recipes/recipe-method-card';
import { RecipeLinkRow } from '@/features/recipes/recipe-link-row';
import {
  dismissPhotoGeneration,
  dismissPhotoUpload,
  generateRecipePhoto,
  photoGenerationMessage,
  retryPhotoUpload,
  usePhotoGeneration,
  usePhotoUpload,
} from '@/features/recipes/photo-upload';
import { RecipePhotoHeader, RecipeTitlePhoto } from '@/features/recipes/recipe-photo';
import { useRecipePhoto } from '@/features/recipes/recipe-photo-source';
import { dismissPhotoChange, undoPhotoChange, usePhotoChange } from '@/features/recipes/recipe-photos';
import { dismissPagesDeleted, usePagesDeleted } from '@/features/recipes/recipe-pages';
import { RecipeCollectionsRow } from '@/features/recipes/recipe-collections-row';
import { RecipeTagRow } from '@/features/recipes/recipe-tag-row';
import { RecipeActionDock } from '@/features/recipes/recipe-action-dock';
import {
  forServingsLabel,
  ingredientUnit,
  methodTab,
  parseServings,
  scaledAmount,
  SERVINGS_MAX,
  SERVINGS_MIN,
  withPick,
} from '@/features/recipes/recipe-view';
import {
  addRecipeIngredient,
  deleteRecipe,
  deleteRecipeIngredient,
  recipeIngredientsQuery,
  recipeQuery,
  undeleteRecipeIngredient,
  updateRecipeIngredient,
  updateRecipeLink,
  updateRecipeNotes,
  updateRecipeServings,
} from '@/features/recipes/recipes';
import { useRecipeViewStyle } from '@/features/recipes/view-style';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';
import { displayItemName, stepPath, stepTexts } from '@/shared';

/** A recipe (spec 4.5, board 06): ingredients added with the same field and parser as lists. */
export default function RecipeScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useT();
  const { spacing, sizes, aisles } = useTheme();
  const headerHeight = useHeaderHeight();
  // Settings > Design trials > Recipe view: the title on the photo with a byline (board E) or the standard view,
  // followed at once.
  const titleOnPhoto = useRecipeViewStyle() === 'titleOnPhoto';
  const { data: recipeRows } = useLiveQueryOn(recipeQuery(id), [recipes], [id]);
  const recipe = recipeRows[0];
  // ingredients and overrides: re-read when an ingredient gets its aisle, so its dot follows.
  const { data: ingredients, loading: ingredientsLoading } = useLiveQueryOn(
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
  // An ingredient's long-press add, for its "Added Flour to Groceries" toast.
  const [added, setAdded] = useState<{ key: string; name: string; listId: string; listName: string; add: RecipeListAdd } | null>(
    null,
  );
  const dismissAddedToast = useCallback(() => setAdded(null), []);
  // The household's staples, for each ingredient's Always have / Don't always have (spec 4.5 Marking from a recipe),
  // and the last mark or unmark, for its "Added Salt to Always have" toast.
  const staples = useStapleNames(householdId);
  const [stapled, setStapled] = useState<{ key: string; ingredientName: string; displayName: string; on: boolean } | null>(null);
  const dismissStapledToast = useCallback(() => setStapled(null), []);
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
  // Generate with AI (spec 4.5): a placeholder while it runs, then a toast if it fails.
  const generation = usePhotoGeneration(id);
  useEffect(() => () => dismissPhotoGeneration(id), [id]);
  const dismissGenerationToast = useCallback(() => dismissPhotoGeneration(id, generation?.key), [id, generation?.key]);
  // "Pages deleted" after Delete pages on the pages screen (spec 4.5); it ends when the screen closes.
  const pagesDeleted = usePagesDeleted(id);
  useEffect(() => () => dismissPagesDeleted(), []);
  const dismissPagesToast = useCallback(() => dismissPagesDeleted(pagesDeleted?.key), [pagesDeleted?.key]);
  // Ingredients | Method, only with steps. Opens on Ingredients every visit and isn't saved.
  const [tab, setTab] = useState<RecipeTab>('ingredients');
  // The Method card's pick in each choice group (spec 4.5 "Step sections"): the first option every visit, not saved.
  const [methodPicks, setMethodPicks] = useState<readonly number[]>([]);
  const scroll = useRef<ScrollView>(null);
  const scrollY = useRef(0);
  // Opening the recipe matches its steps if they need it (spec 4.5).
  useEnsureStepMatch(id);
  const switchY = useRef(0);
  // The floating dock's height, measured; until then, a CTA in its padding over a 16 pt gap.
  const [dockHeight, setDockHeight] = useState(sizes.cta + spacing.sm * 2 + spacing.lg);
  // The add bar shows on demand, as the list's does (spec 4.1, 4.2): Add ingredient opens it focused, and it
  // goes once the field loses focus with nothing typed. With text, the first tap out only hides the keyboard;
  // a second hides the bar too (`addTucked`), keeping the text for Add ingredient to bring back.
  const [addOpen, setAddOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addText, setAddText] = useState('');
  const [addTucked, setAddTucked] = useState(false);
  const addInputRef = useRef<TextInput>(null);
  const showAddBar = addOpen || adding || (addText !== '' && !addTucked);
  const tapOutHidesBar = showAddBar && !adding && addText !== '';
  const openAdd = () => {
    setAddOpen(true);
    setAddTucked(false);
    addInputRef.current?.focus();
  };
  const addFocusChange = (focused: boolean) => {
    setAdding(focused);
    setAddOpen(false);
    if (focused) setAddTucked(false);
  };
  // After an add, the card's next layout scrolls its foot (the new row and Add ingredient) into view.
  const viewportHeight = useRef(0);
  const scrollAfterAdd = useRef(false);
  const ingredientsLayout = (e: LayoutChangeEvent) => {
    const bottom = e.nativeEvent.layout.y + e.nativeEvent.layout.height;
    if (!scrollAfterAdd.current) return;
    scrollAfterAdd.current = false;
    const y = bottom + spacing.lg - viewportHeight.current;
    if (y > scrollY.current) scroll.current?.scrollTo({ y, animated: true });
  };
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
  // Headings aren't steps: only the step strings count. "Method · N" counts the path the card shows.
  const steps = stepTexts(recipe.steps).length;
  const methodCount = stepPath(recipe.steps, methodPicks).length;

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

  const editLink = () =>
    Alert.prompt(
      t('recipes.link.label'),
      undefined,
      (text) => updateRecipeLink(recipe.id, normalizeRecipeLink(text ?? '')),
      'plain-text',
      recipe.sourceUrl ?? '',
      'url',
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

  // Spec 4.5 Marking from a recipe: marks or unmarks the ingredient for the recipe's household at once, with Undo.
  const toggleStaple = (ingredient: RecipeIngredient) => {
    const on = !isStaple(recipe.householdId, ingredient.ingredientName);
    setStaple(recipe.householdId, ingredient.ingredientName, on, getAccount()?.userId ?? null);
    // Each change flips `on`, so the key differs from the toast before and the new one restarts its timer.
    setStapled({ key: `${ingredient.id}-${on}`, ingredientName: ingredient.ingredientName, displayName: ingredient.displayName, on });
  };

  // Spec 4.5: long-pressing an ingredient (light haptic) offers the household's open lists, the current one first,
  // and adds it at the stepper's servings, as its row shows it. The screen stays put, with Undo and Open list.
  // Then Always have (Don't always have for a staple), offered with no open list too.
  const addToListMenu = (ingredient: RecipeIngredient) => {
    const userId = getAccount()?.userId ?? null;
    const all = listsWithCountsQuery().all();
    const open = all.filter((l) => l.archivedAt === null);
    const offered = ingredientMenuLists(all, recipe.householdId, resolveCurrentListId(open, userId));
    const staple = isStaple(recipe.householdId, ingredient.ingredientName);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const multiplier = base !== null && servings !== null ? servingsMultiplier(servings, base) : 1;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: displayItemName(ingredient.displayName),
        options: [
          ...offered.map((l) => quickAddTitle(l.name)),
          t(staple ? 'recipes.screen.unmarkAlwaysHave' : 'recipes.screen.markAlwaysHave'),
          t('common.cancel'),
        ],
        cancelButtonIndex: offered.length + 1,
      },
      (index) => {
        if (index === offered.length) return toggleStaple(ingredient);
        const list = offered[index];
        if (!list) return;
        const add = addIngredientToList(list.id, id, ingredient, multiplier, userId);
        void categorizePending(add.pendingNames);
        setAdded({ key: `${ingredient.id}-${Date.now()}`, name: ingredient.displayName, listId: list.id, listName: list.name, add });
      },
    );
  };

  // Swipe left (or VoiceOver's Delete) on an ingredient, with Undo in a toast.
  const removeIngredient = (ingredient: RecipeIngredient) => {
    deleteRecipeIngredient(ingredient.id);
    ensureStepMatchSoon(id);
    setDeleted(ingredient);
  };

  // Spec 4.16: the plan modal, for Plan and the plan badges.
  const openPlan = () => router.push({ pathname: '/plan-recipe', params: { recipeId: id } });
  // Spec 4.5: the Choose a photo sheet, for the Add photo tile and Change photo….
  const openPhoto = () => router.push({ pathname: '/recipe/[id]/photo', params: { id } });
  // Spec 4.5: a photo import's original pages, full screen, from the ⋯ menu and the Method card's credit.
  const pageCount = recipe.sourcePages?.length ?? 0;
  const openPages = () => router.push({ pathname: '/recipe/[id]/pages', params: { id } });

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
          tint, so back and actions sit on it (board 06). Title on photo always has its photo or tile colour (board E). */}
      <Stack.Screen
        options={
          photoSource || titleOnPhoto
            ? { headerTransparent: true, headerStyle: { backgroundColor: 'transparent' }, headerShadowVisible: false }
            : { headerTransparent: false, headerStyle: { backgroundColor: aisles[hue].soft } }
        }
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel={t('recipes.screen.actions')}>
          <Stack.Toolbar.MenuAction icon="pencil" onPress={() => promptRecipeName(id, recipe.name)}>
            {t('recipes.screen.rename')}
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="rectangle.stack" onPress={() => openCollections(id)}>
            {t('recipes.collections.addTo')}
          </Stack.Toolbar.MenuAction>
          {/* The band no longer shows "Serves 4", so the recipe's own servings are edited from here. */}
          {base !== null ? (
            <Stack.Toolbar.MenuAction icon="person.2" onPress={editServings}>
              {t('recipes.servings.edit')}
            </Stack.Toolbar.MenuAction>
          ) : null}
          {/* Title on photo's byline has no link field, so the link is added or edited from here. */}
          {titleOnPhoto ? (
            <Stack.Toolbar.MenuAction icon="link" onPress={editLink}>
              {recipe.sourceUrl ? t('recipes.link.edit') : t('recipes.link.add')}
            </Stack.Toolbar.MenuAction>
          ) : null}
          {pageCount > 0 ? (
            <Stack.Toolbar.MenuAction icon="doc.text" onPress={openPages}>
              {t('recipes.pages.see')}
            </Stack.Toolbar.MenuAction>
          ) : null}
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
      <KeyboardAvoidingView
        style={styles.flex}
        behavior="padding"
        keyboardVerticalOffset={photoSource || titleOnPhoto ? 0 : headerHeight}>
        {/* The actions float over the scroll view's bottom (spec 4.5), and its content ends above them. */}
        {/* A tap out that no row or control claims tucks a kept add bar away; while the field is focused,
            the scroll view's own tap out hides the keyboard instead. */}
        <View
          testID="recipe-viewport"
          style={styles.flex}
          onStartShouldSetResponder={() => tapOutHidesBar}
          onResponderRelease={() => setAddTucked(true)}>
          <ScrollView
            ref={scroll}
            style={styles.flex}
            onLayout={(e) => (viewportHeight.current = e.nativeEvent.layout.height)}
            onScroll={(e) => (scrollY.current = e.nativeEvent.contentOffset.y)}
            scrollEventThrottle={16}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            // The photo runs up under the status bar and the header's buttons.
            contentInsetAdjustmentBehavior="never"
            // The last row and the Method card's last line scroll clear of the dock, hidden while adding.
            contentContainerStyle={{ paddingBottom: (showAddBar ? 0 : dockHeight) + spacing.lg }}>
            {titleOnPhoto ? (
              <>
                <RecipeTitlePhoto
                  name={recipe.name}
                  source={photoSource}
                  tint={aisles[hue]}
                  uploading={uploading}
                  generating={!hasPhoto && generation?.status === 'generating'}
                  headerHeight={headerHeight}
                  onError={uploading ? () => {} : photo.onError}
                  onAddPhoto={openPhoto}
                />
                <RecipeByline recipe={recipe} hue={hue} hasIngredients={ingredients.length > 0} onPlan={openPlan} />
              </>
            ) : (
              <>
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
                  showAddPhoto={!hasPhoto && !uploading && generation?.status !== 'generating'}
                  generating={!hasPhoto && generation?.status === 'generating'}
                  hasIngredients={ingredients.length > 0}
                  onEditServings={editServings}
                  onPlan={openPlan}
                  onAddPhoto={openPhoto}
                />
              </>
            )}
            {/* The actions are in the dock (spec 4.5), so the band runs straight into the switch or the card. */}
            <View style={{ height: spacing.lg }} />
            {/* With steps, one card at a time under the switch; without, Ingredients over the Method's Add steps. */}
            {steps > 0 ? (
              <View onLayout={(e) => (switchY.current = e.nativeEvent.layout.y)} style={{ paddingBottom: spacing.md }}>
                <SegmentedControl
                  segments={[{ value: 'ingredients', label: t('recipes.screen.ingredients') }, { value: 'method', ...methodTab(methodCount) }]}
                  value={tab}
                  onChange={switchTab}
                />
              </View>
            ) : null}
            {steps === 0 || tab === 'ingredients' ? (
              <View testID="recipe-ingredients" onLayout={ingredientsLayout}>
              <Card>
                <SectionHeader
                  title={t('recipes.screen.ingredients')}
                  count={ingredients.length}
                  countPlacement="title"
                  countUnit={ingredientUnit()}
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
                    ) : titleOnPhoto && base === null ? (
                      // The byline has no room for it, so title on photo offers Add servings here.
                      <Pill dashed icon="person.2" label={t('recipes.servings.add')} onPress={editServings} />
                    ) : undefined
                  }
                />
                {ingredientsLoading ? null : ingredients.length === 0 ? (
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
                      onAddToList={() => addToListMenu(item)}
                      staple={staples.has(item.ingredientName)}
                      onToggleStaple={() => toggleStaple(item)}
                      onDelete={() => removeIngredient(item)}
                    />
                  ))
                )}
                <AddIngredientRow onPress={openAdd} />
              </Card>
              </View>
            ) : null}
            {steps === 0 ? <View style={{ height: spacing.md }} /> : null}
            {steps === 0 || tab === 'method' ? (
              <RecipeMethodCard
                steps={recipe.steps}
                hue={hue}
                picks={methodPicks}
                onPick={(group, option) => setMethodPicks((current) => withPick(current, group, option))}
                sourceUrl={recipe.sourceUrl}
                pageCount={pageCount}
                onViewPages={openPages}
                onEdit={() => router.push({ pathname: '/recipe/[id]/steps', params: { id } })}
              />
            ) : null}
          </ScrollView>
          {/* The toasts float above the dock. */}
          <RecipeActionDock
            tint={aisles[hue].strong}
            addDisabled={ingredients.length === 0}
            onAddToList={() =>
              router.push({
                pathname: '/recipe/[id]/add-to-list',
                // Board 17: the sheet starts at the stepper's servings when it's off the base.
                params: servings !== null && servings !== base ? { id, servings: String(servings) } : { id },
              })
            }
            onCook={
              steps > 0
                ? () =>
                    router.push({
                      pathname: '/recipe/[id]/cook',
                      // Board 19: the ingredients are scaled to the stepper's servings.
                      params: servings !== null ? { id, servings: String(servings) } : { id },
                    })
                : undefined
            }
            onPlan={openPlan}
            onHeight={setDockHeight}
            hidden={showAddBar}>
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
            {generation?.status === 'failed' ? (
              <View style={{ paddingBottom: spacing.sm }}>
                <Toast
                  key={`generate-${generation.key}`}
                  message={photoGenerationMessage(generation)}
                  actions={
                    // The server released the slot, so only a plain failure can be tried again.
                    generation.error === 'failed'
                      ? [{ label: t('common.tryAgain'), onPress: () => void generateRecipePhoto(id) }]
                      : []
                  }
                  onDismiss={dismissGenerationToast}
                />
              </View>
            ) : null}
            {pagesDeleted ? (
              <View style={{ paddingBottom: spacing.sm }}>
                <Toast key={`pages-${pagesDeleted.key}`} message={t('recipes.pages.deleted')} actions={[]} onDismiss={dismissPagesToast} />
              </View>
            ) : null}
            {added ? (
              <View style={{ paddingBottom: spacing.sm }}>
                <Toast
                  key={added.key}
                  {...addedIngredientToast(added.name, added.listName)}
                  actions={[
                    { label: t('common.undo'), onPress: () => (undoRecipeAdd(added.add), setAdded(null)) },
                    { label: t('recipes.tab.openList'), onPress: () => (setAdded(null), openList(added.listId)) },
                  ]}
                  onDismiss={dismissAddedToast}
                />
              </View>
            ) : null}
            {stapled ? (
              <View style={{ paddingBottom: spacing.sm }}>
                <Toast
                  key={stapled.key}
                  {...stapleToast(recipe.householdId, stapled.displayName, stapled.on)}
                  actions={[
                    {
                      label: t('common.undo'),
                      onPress: () => (
                        setStaple(recipe.householdId, stapled.ingredientName, !stapled.on, getAccount()?.userId ?? null),
                        setStapled(null)
                      ),
                    },
                  ]}
                  onDismiss={dismissStapledToast}
                />
              </View>
            ) : null}
            {deleted ? (
              <View style={{ paddingBottom: spacing.sm }}>
                <Toast
                  key={deleted.id}
                  message={t('recipes.screen.removed', { name: displayItemName(deleted.displayName) })}
                  actions={[
                    {
                      label: t('common.undo'),
                      onPress: () => (undeleteRecipeIngredient(deleted.id), ensureStepMatchSoon(id), setDeleted(null)),
                    },
                  ]}
                  onDismiss={dismissToast}
                />
              </View>
            ) : null}
          </RecipeActionDock>
        </View>
        {showAddBar ? (
          <ItemAddBar
            householdId={recipe.householdId}
            onAdd={(text) => {
              void categorizePending(addRecipeIngredient(id, text)?.pendingNames ?? []);
              ensureStepMatchSoon(id);
              scrollAfterAdd.current = true;
            }}
            onTextChange={setAddText}
            onFocusChange={addFocusChange}
            placeholder={t('recipes.screen.addPlaceholder')}
            accessibilityLabel={t('recipes.screen.addLabel')}
            inputRef={addInputRef}
            initialText={addText}
            autoFocus
          />
        ) : null}
      </KeyboardAvoidingView>
    </Screen>
  );
}

/**
 * The header band in the recipe's soft tint: its name, source link, one line of tags (RecipeTagRow), the
 * collections it's in (RecipeCollectionsRow, left out in none) and notes. The notes show as two lines of text, or a small "+ Add notes", and a tap turns them into the field,
 * saved when it loses focus; the link row is RecipeLinkRow. Without servings, a dashed "Add servings" beside
 * the link opens the servings prompt (`onEditServings`). Under the name, the
 * recipe's upcoming plan badges open the plan modal (`onPlan`). Without a photo (`showAddPhoto`), a
 * dashed Add photo tile at the top, where the photo would be, opens the Choose a photo sheet (`onAddPhoto`);
 * while Generate with AI runs (`generating`), a placeholder sits there instead.
 */
function RecipeBand({
  recipe,
  hue,
  showAddPhoto,
  generating,
  hasIngredients,
  onEditServings,
  onPlan,
  onAddPhoto,
}: {
  recipe: Recipe;
  hue: AisleHue;
  showAddPhoto: boolean;
  generating: boolean;
  hasIngredients: boolean;
  onEditServings: () => void;
  onPlan: () => void;
  onAddPhoto: () => void;
}) {
  const t = useT();
  const { colors, aisles, spacing, typography, sizes, opacity } = useTheme();
  // Suggest tags is on every plan (spec 4.12); it needs ingredients.
  const canSuggest = hasIngredients;
  // The notes show as text (or "+ Add notes") until tapped, then as the field, focused.
  const { notes, setNotes, editingNotes, startNotes, endNotes } = useNotesEditor(recipe);
  const [sourceUrl, showSavedLink] = useSavedValue(recipe.sourceUrl ?? '');
  const saveLink = (text: string) => {
    const link = normalizeRecipeLink(text);
    updateRecipeLink(recipe.id, link);
    showSavedLink(link.trim());
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
      {generating ? <GeneratingPhoto /> : null}
      <ThemedText variant="screenTitle" accessibilityRole="header">
        {recipe.name}
      </ThemedText>
      <PlanBadges recipeId={recipe.id} onOpen={onPlan} />
      {/* The link, and Add servings beside it while the recipe has none (boards 13 and 15). The
          servings themselves show on the ingredients card's stepper. */}
      <View style={[styles.row, { gap: spacing.md + spacing.xxs }]}>
        <View style={styles.flex}>
          <RecipeLinkRow value={sourceUrl} hue={hue} onSave={saveLink} />
        </View>
        {recipe.servings === null ? (
          <Pill dashed icon="person.2" label={t('recipes.servings.add')} onPress={onEditServings} />
        ) : null}
      </View>
      <RecipeTagRow
        recipe={recipe}
        onEdit={() => router.push({ pathname: '/recipe/[id]/tags', params: { id: recipe.id } })}
        onSuggest={
          canSuggest
            ? () => router.push({ pathname: '/recipe/[id]/tags', params: { id: recipe.id, suggest: '1' } })
            : undefined
        }
      />
      <RecipeCollectionsRow recipeId={recipe.id} onEdit={() => openCollections(recipe.id)} />
      {editingNotes ? (
        <TextInput
          value={notes}
          onChangeText={setNotes}
          onEndEditing={endNotes}
          autoFocus
          placeholder={t('recipes.screen.addNotes')}
          placeholderTextColor={colors.inkSecondary}
          selectionColor={tint.strong}
          accessibilityLabel={t('recipes.screen.notes')}
          multiline
          style={[typography.subhead, { color: colors.ink, minHeight: sizes.minTapTarget }]}
        />
      ) : notes.trim() ? (
        <Pressable
          onPress={startNotes}
          accessibilityRole="button"
          accessibilityLabel={t('recipes.screen.notesLabel', { notes: notes.trim() })}
          style={({ pressed }) => [styles.center, { minHeight: sizes.minTapTarget, opacity: pressed ? opacity.pressed : 1 }]}>
          <ThemedText variant="subhead" numberOfLines={2} ellipsizeMode="tail">
            {notes.trim()}
          </ThemedText>
        </Pressable>
      ) : (
        <Pressable
          onPress={startNotes}
          accessibilityRole="button"
          accessibilityLabel={t('recipes.screen.addNotes')}
          style={({ pressed }) => [
            styles.row,
            styles.start,
            { gap: spacing.xs, minHeight: sizes.minTapTarget, opacity: pressed ? opacity.pressed : 1 },
          ]}>
          <Icon name="plus" color="inkSecondary" size={sizes.iconSmall} weight="semibold" />
          <ThemedText variant="footnote" color="inkSecondary">
            {t('recipes.screen.addNotes')}
          </ThemedText>
        </Pressable>
      )}
    </View>
  );
}

/**
 * The notes field's state for the band and the byline. Outside editing, `notes` is the live query's, so a
 * household-mate's edit shows; a tap copies it into the draft, and ending the edit writes only the notes
 * column, and only when the draft changed, so leaving the field untouched doesn't write back a stale copy.
 */
function useNotesEditor(recipe: Recipe) {
  const [shown, showSaved] = useSavedValue(recipe.notes ?? '');
  const [draft, setDraft] = useState('');
  const [started, setStarted] = useState<string | null>(null);
  const editingNotes = started !== null;
  const startNotes = () => {
    setDraft(shown);
    setStarted(shown);
  };
  const endNotes = () => {
    if (started !== null && draft !== started) {
      updateRecipeNotes(recipe.id, draft);
      showSaved(draft.trim());
    }
    setStarted(null);
  };
  return { notes: editingNotes ? draft : shown, setNotes: setDraft, editingNotes, startNotes, endNotes };
}

/**
 * A stored value as shown: `stored` (the live query's), except that a value just saved shows until the
 * query catches up, and goes as soon as the stored value changes (our save, or someone else's edit).
 */
function useSavedValue(stored: string): [string, (value: string) => void] {
  const [saved, setSaved] = useState<{ before: string; value: string } | null>(null);
  const shown = saved && saved.before === stored ? saved.value : stored;
  return [shown, (value) => setSaved({ before: stored, value })];
}

/**
 * Title on photo's byline (spec 4.5, board E), under the name on the photo, in the recipe's soft tint: the plan
 * badges, then one line of the link's host (a `link` glyph and the host in the hue's `strong` `amount`, opening
 * Safari) and the tags (RecipeTagRow), then under a `border` hairline the notes on one line after a `note.text`
 * glyph, tapped to edit as the band's are, or "+ Add notes". No link field: the ⋯ menu adds or edits the link.
 */
function RecipeByline({
  recipe,
  hue,
  hasIngredients,
  onPlan,
}: {
  recipe: Recipe;
  hue: AisleHue;
  hasIngredients: boolean;
  onPlan: () => void;
}) {
  const t = useT();
  const { colors, aisles, spacing, typography, sizes, opacity } = useTheme();
  const canSuggest = hasIngredients;
  const { notes, setNotes, editingNotes, startNotes, endNotes } = useNotesEditor(recipe);
  const tint = aisles[hue];
  const link = recipeLinkParts(recipe.sourceUrl);

  return (
    <View
      testID="recipe-byline"
      style={{ backgroundColor: tint.soft, paddingHorizontal: spacing.lg + spacing.xs, paddingVertical: spacing.xs }}>
      <PlanBadges recipeId={recipe.id} onOpen={onPlan} />
      <View style={[styles.row, { gap: spacing.md }]}>
        {recipe.sourceUrl && link ? (
          <Pressable
            onPress={() => void openRecipeLink(recipe.sourceUrl ?? '')}
            accessibilityRole="link"
            accessibilityLabel={t('recipes.link.row', { link: link.host })}
            accessibilityHint={t('recipes.link.openHint')}
            style={({ pressed }) => [
              styles.row,
              styles.linkHost,
              { gap: spacing.xs, minHeight: sizes.minTapTarget, opacity: pressed ? opacity.pressed : 1 },
            ]}>
            <Icon name="link" tint={tint.strong} size={sizes.iconSmall} weight="bold" />
            <ThemedText variant="amount" numberOfLines={1} style={[styles.shrink, { color: tint.strong }]}>
              {link.host}
            </ThemedText>
          </Pressable>
        ) : null}
        <View style={styles.flex}>
          <RecipeTagRow
            recipe={recipe}
            onEdit={() => router.push({ pathname: '/recipe/[id]/tags', params: { id: recipe.id } })}
            onSuggest={
              canSuggest
                ? () => router.push({ pathname: '/recipe/[id]/tags', params: { id: recipe.id, suggest: '1' } })
                : undefined
            }
          />
        </View>
      </View>
      <RecipeCollectionsRow recipeId={recipe.id} onEdit={() => openCollections(recipe.id)} />
      <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}>
        {editingNotes ? (
          <TextInput
            value={notes}
            onChangeText={setNotes}
            onEndEditing={endNotes}
            autoFocus
            placeholder={t('recipes.screen.addNotes')}
            placeholderTextColor={colors.inkSecondary}
            selectionColor={tint.strong}
            accessibilityLabel={t('recipes.screen.notes')}
            multiline
            style={[typography.subhead, { color: colors.ink, minHeight: sizes.minTapTarget, paddingVertical: spacing.sm }]}
          />
        ) : (
          <Pressable
            onPress={startNotes}
            accessibilityRole="button"
            accessibilityLabel={notes.trim() ? t('recipes.screen.notesLabel', { notes: notes.trim() }) : t('recipes.screen.addNotes')}
            style={({ pressed }) => [
              styles.row,
              { gap: spacing.sm, minHeight: sizes.minTapTarget, opacity: pressed ? opacity.pressed : 1 },
            ]}>
            {notes.trim() ? (
              <>
                <Icon name="note.text" color="inkSecondary" size={sizes.iconSmall} />
                <ThemedText variant="subhead" numberOfLines={1} ellipsizeMode="tail" style={styles.shrink}>
                  {notes.trim()}
                </ThemedText>
              </>
            ) : (
              <>
                <Icon name="plus" color="inkSecondary" size={sizes.iconSmall} weight="semibold" />
                <ThemedText variant="footnote" color="inkSecondary">
                  {t('recipes.screen.addNotes')}
                </ThemedText>
              </>
            )}
          </Pressable>
        )}
      </View>
    </View>
  );
}

/** The Add to collection sheet (recipe collections board C), from the ⋯ menu and the collections line. */
const openCollections = (id: string) => router.push({ pathname: '/recipe/[id]/collections', params: { id } });

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


/**
 * Where the photo will be while Generate with AI runs (spec 4.5): a 16:9 `surfaceMuted` tile, radius
 * `md`, with a spinner over "Generating photo…" (`footnote` `inkSecondary`), read as one progress bar.
 */
function GeneratingPhoto() {
  const t = useT();
  const { colors, spacing, rounded } = useTheme();
  return (
    <View
      testID="photo-generating"
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t('recipes.photo.generating')}
      style={[
        styles.generating,
        { gap: spacing.sm, marginBottom: spacing.xs, borderRadius: rounded.md, backgroundColor: colors.surfaceMuted },
      ]}>
      <ActivityIndicator color={colors.inkSecondary} />
      <ThemedText variant="footnote" color="inkSecondary">
        {t('recipes.photo.generating')}
      </ThemedText>
    </View>
  );
}

type RecipeTab = 'ingredients' | 'method';

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { justifyContent: 'center' },
  start: { alignSelf: 'flex-start' },
  shrink: { flexShrink: 1 },
  // The host keeps up to half the byline's line; the tags take the rest and truncate.
  linkHost: { flexShrink: 0, maxWidth: '50%' },
  generating: { aspectRatio: 16 / 9, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderCurve: 'continuous' },
});
