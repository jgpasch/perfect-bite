// A recipe's row and tile, as the Recipes tab and a collection's screen show them (spec 4.5): the link to the
// recipe, its long-press menu, the swipe to delete and the saved marks.
import { Link, router } from 'expo-router';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Pressable, StyleSheet, View } from 'react-native';
import ReanimatedSwipeable, { type SwipeableMethods } from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { useAnimatedReaction, useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { Badge } from '@/components/badge';
import { CheckCircle } from '@/components/check-circle';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import type { ToastAction } from '@/components/toast';
import { households, listItems, lists, userSettings } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { getAccount } from '@/features/auth/account';
import { categorizePending } from '@/features/categories/categorization';
import { openList, resolveCurrentListId, useCurrentListVersion } from '@/features/lists/current-list';
import { getList, listsWithCountsQuery } from '@/features/lists/lists';
import { useTheme } from '@/hooks/use-theme';
import { i18n, useT } from '@/i18n';
import type { RecipeTags } from '@/shared/recipe-tags';

import { addWholeRecipeToList, undoRecipeAdd } from './add-to-list';
import { favoriteLabel, setMyFavorite, type RecipeFavorite } from './favorites';
import { promptRecipeName } from './prompt-recipe-name';
import { quickAddTitle, type QuickAddCandidate } from './quick-add';
import { openRecipeLink, recipeLinkUrl } from './recipe-link';
import { RecipePhotoCover, RecipePhotoTile } from './recipe-photo';
import type { RecipeGroup } from './recipe-sort';
import { addedRecipeWithStaplesToast, recipeMetaLine, recipeRowLabel, recipeSavedMarks, recipeTimeLabel } from './recipe-view';
import { deleteRecipe, setRecipeSaved, type RecipeSummary } from './recipes';

/** A toast on a screen of recipes; `recipeId` is outlined while it shows. */
export type RecipeToast = { key: string; message: string; emphasis?: string; actions: ToastAction[]; recipeId?: string };

/** A collection screen's "Remove from Mom's cookbook" in a recipe's long-press menu. */
export type RemoveFromCollection = { name: string; onPress: () => void };

/**
 * The current list (the List tab's) the card menu's quick add goes to, re-resolved as lists change, and the add
 * itself: at 1× as the add bar does (staples left out), staying on the screen with a toast holding Undo and
 * Open list.
 */
export function useRecipeQuickAdd(onToast: (toast: RecipeToast | null) => void) {
  const t = useT();
  const { data: allLists } = useLiveQueryOn(listsWithCountsQuery(), [lists, listItems, households, userSettings]);
  const userId = getAccount()?.userId ?? null;
  const listVersion = useCurrentListVersion();
  const currentList = useMemo((): QuickAddCandidate | null => {
    const id = resolveCurrentListId(allLists.filter((l) => l.archivedAt === null), userId);
    return id ? (allLists.find((l) => l.id === id) ?? getList(id) ?? null) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `listVersion`: another screen picked a list
  }, [allLists, userId, listVersion]);

  const quickAdd = (recipeId: string, list: { id: string; name: string }) => {
    const added = addWholeRecipeToList(list.id, recipeId, userId);
    if (!added) return;
    void categorizePending(added.pendingNames);
    const nothingAdded = added.count === 0 && added.skipped.length > 0;
    onToast({
      key: `quick-add-${recipeId}-${Date.now()}`,
      recipeId,
      ...addedRecipeWithStaplesToast(added.recipeName, added.count, added.skipped, list.name),
      actions: [
        ...(nothingAdded ? [] : [{ label: t('common.undo'), onPress: () => (undoRecipeAdd(added), onToast(null)) }]),
        { label: t('recipes.tab.openList'), onPress: () => (onToast(null), openList(list.id)) },
      ],
    });
  };
  return { currentList, quickAdd };
}

/** Spec 4.5: one card's Delete open at a time; opening another or scrolling (`closeOpenCard`) closes it. */
export function useOneOpenCard() {
  const openCard = useRef<SwipeableMethods | null>(null);
  const cardOpened = useCallback((card: SwipeableMethods) => {
    if (openCard.current !== card) openCard.current?.close();
    openCard.current = card;
  }, []);
  const cardClosed = useCallback((card: SwipeableMethods) => {
    if (openCard.current === card) openCard.current = null;
  }, []);
  const closeOpenCard = useCallback(() => openCard.current?.close(), []);
  return { cardOpened, cardClosed, closeOpenCard };
}

/**
 * A recipe's row in its household's card (spec 4.5): the photo tile, the name on one line, and under it the
 * meta line ("Dinner · 35 min"), or "Has …" when a search matched only an ingredient. With `select` (Select
 * mode) the row ticks instead of opening: a round tick first, no menu and no swipe.
 */
export function RecipeRow({
  recipe,
  group,
  ingredientMatch,
  onList,
  favorite,
  highlighted,
  quickAddTo,
  onQuickAdd,
  onSwipeOpen,
  onSwipeClose,
  removeFrom,
  select,
}: {
  recipe: RecipeSummary;
  /** The tab's grouping: grouped by cuisine, the meta line shows the cuisine in place of the meal. */
  group: RecipeGroup;
  /** Search matched it only through this ingredient (spec 4.14): "Has …" in place of the meta line. */
  ingredientMatch: string | null;
  onList: string | null;
  /** Who has it as a favorite (4.14), or null. */
  favorite: RecipeFavorite | null;
  /** Just imported: outlined in `primary` while the toast shows. */
  highlighted: boolean;
  /** The list the menu's Add to <list> adds to (`quickAddList`), or null to leave it out. */
  quickAddTo: { id: string; name: string } | null;
  onQuickAdd: (recipeId: string, list: { id: string; name: string }) => void;

  /** Its swipe opened or closed, so the screen keeps only one card open. */
  onSwipeOpen: (card: SwipeableMethods) => void;
  onSwipeClose: (card: SwipeableMethods) => void;
  /** On a collection's screen: the menu's Remove from <collection>. */
  removeFrom?: RemoveFromCollection;
  /** Select mode: whether it's ticked, and the tap that ticks or unticks it. */
  select?: { on: boolean; onToggle: () => void };
}) {
  const t = useT();
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const swipeable = useRef<SwipeableMethods>(null);
  const [width, setWidth] = useState(0);
  // Dragged past FULL_SWIPE of the card: letting go asks to delete, rather than leaving Delete showing.
  const fullSwipe = useRef(false);
  const setFullSwipe = useCallback((full: boolean) => (fullSwipe.current = full), []);
  const meta = recipeMetaLine(recipe, group);

  // The menu's Delete, the swipe's and VoiceOver's; Cancel closes a swiped card.
  const confirmDelete = () => confirmDeleteRecipe(recipe, () => swipeable.current?.close());

  const row = (pressed = false) => (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={[
        styles.row,
        {
          minHeight: sizes.recipeTile + spacing.md * 2,
          paddingVertical: spacing.md - sizes.focusRing,
          paddingHorizontal: spacing.lg - sizes.focusRing,
          gap: spacing.md,
          backgroundColor: select?.on ? colors.primarySoft : colors.surface,
          borderWidth: sizes.focusRing,
          // The outline follows the card's corners, so it isn't clipped on the first and last rows.
          borderRadius: highlighted ? rounded.card : 0,
          borderColor: highlighted ? colors.primary : 'transparent',
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      {select ? <CheckCircle checked={select.on} /> : null}
      <RecipePhotoTile recipeId={recipe.id} imageUrl={recipe.imageUrl} photoPath={recipe.photoPath} />
      <View style={styles.flex}>
        <View style={[styles.nameLine, { gap: spacing.xs }]}>
          <ThemedText variant="headline" numberOfLines={1} style={styles.shrink}>
            {recipe.name}
          </ThemedText>
          <SavedMarks tags={recipe.tags} favorite={favorite} />
        </View>
        {ingredientMatch ? (
          <ThemedText variant="footnote" color="inkSecondary">
            {t('recipes.tab.has')}{' '}
            <ThemedText variant="footnote" color="inkSecondary" style={styles.match}>
              {ingredientMatch}
            </ThemedText>
          </ThemedText>
        ) : meta ? (
          <ThemedText variant="footnote" color="inkSecondary">
            {meta}
          </ThemedText>
        ) : null}
      </View>
      {onList ? (
        // Badge pins itself to the top; the wrapper centres it in the row.
        <View>
          <Badge label={t('recipes.tab.onList', { name: onList })} />
        </View>
      ) : null}
    </View>
  );

  if (select) {
    return (
      <Pressable
        testID="recipe-select-row"
        accessibilityRole="checkbox"
        accessibilityState={{ checked: select.on }}
        accessibilityLabel={recipe.name}
        onPress={select.onToggle}>
        {({ pressed }) => row(pressed)}
      </Pressable>
    );
  }

  // eslint-disable-next-line react-hooks/refs -- `confirmDelete` reads the ref only when pressed, not during render
  const card = recipeLink({
    recipe,
    group,
    onList,
    ingredientMatch,
    favorite,
    quickAddTo,
    onQuickAdd,
    onDelete: confirmDelete,
    removeFrom,
    children: row(),
  });

  return (
    <ReanimatedSwipeable
      ref={swipeable}
      // Follows the finger like a list row; a short swipe leaves Delete showing, a full one asks at once.
      friction={1}
      overshootLeft={false}
      onSwipeableWillOpen={() => {
        if (swipeable.current) onSwipeOpen(swipeable.current);
        if (fullSwipe.current) confirmDelete();
      }}
      onSwipeableClose={() => swipeable.current && onSwipeClose(swipeable.current)}
      renderRightActions={(_progress, translation) => (
        <DeleteAction
          translation={translation}
          fullAt={width > 0 ? width * FULL_SWIPE : Infinity}
          onFull={setFullSwipe}
          onPress={confirmDelete}
        />
      )}>
      {card}
    </ReanimatedSwipeable>
  );
}

/** Asks before deleting a recipe (the menu's Delete, a swipe's and VoiceOver's); `onCancel` closes a swiped row. */
export function confirmDeleteRecipe(recipe: { id: string; name: string }, onCancel?: () => void) {
  Alert.alert(i18n.t('recipes.tab.deleteTitle', { name: recipe.name }), i18n.t('recipes.tab.deleteMessage'), [
    { text: i18n.t('common.cancel'), style: 'cancel', onPress: onCancel },
    { text: i18n.t('common.delete'), style: 'destructive', onPress: () => deleteRecipe(recipe.id) },
  ]);
}

/**
 * A recipe's row or tile as a link to the recipe (spec 4.5): its VoiceOver label and Delete action, and the
 * long-press menu (Add to <list>, Add to a list, Plan…, Visit recipe, Favorite, Want to try, Add to collection…,
 * Remove from <collection> on a collection's screen, Rename, Delete). A plain function, so a row's swipeable
 * wraps the Link itself. Callers re-render on a language change through `useT`.
 */
export function recipeLink({
  recipe,
  group,
  onList,
  ingredientMatch,
  favorite,
  quickAddTo,
  onQuickAdd,
  onDelete,
  removeFrom,
  label,
  children,
}: {
  recipe: RecipeSummary;
  group: RecipeGroup;
  onList: string | null;
  ingredientMatch: string | null;
  favorite: RecipeFavorite | null;
  quickAddTo: { id: string; name: string } | null;
  onQuickAdd: (recipeId: string, list: { id: string; name: string }) => void;
  onDelete: () => void;
  removeFrom?: RemoveFromCollection;
  /** VoiceOver's label in place of the row's, e.g. a shelf tile's "Tacos, Thursday dinner". */
  label?: string;
  children: ReactNode;
}) {
  const t = i18n.t.bind(i18n);
  // Only a link that opens (spec 4.5); plain text in the link field gets no Visit recipe on web.
  const link = recipeLinkUrl(recipe.sourceUrl) ? recipe.sourceUrl : null;
  const marks = recipeSavedMarks(recipe.tags, favorite);
  const mine = marks.favorite === 'mine';
  return (
    <Link href={{ pathname: '/recipe/[id]', params: { id: recipe.id } }} asChild>
      <Link.Trigger>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            label ??
            recipeRowLabel(recipe, onList, ingredientMatch, group, favorite && favoriteLabel(favorite.mine, favorite.others))
          }
          accessibilityActions={[{ name: 'delete', label: t('common.delete') }]}
          onAccessibilityAction={({ nativeEvent }) => nativeEvent.actionName === 'delete' && onDelete()}>
          {/* Layout lives on the children: Link's trigger replaces the Pressable's style. */}
          {children}
        </Pressable>
      </Link.Trigger>
      <Link.Menu>
        {/* Spec 4.5: one-step add to the current list, when it's open and in the recipe's household. */}
        {quickAddTo ? (
          <Link.MenuAction
            title={quickAddTitle(quickAddTo.name)}
            icon="cart.badge.plus"
            onPress={() => onQuickAdd(recipe.id, quickAddTo)}
          />
        ) : null}
        {/* The recipe screen's Add to a list sheet (spec 4.5); left out, as that button is disabled, with no ingredients. */}
        {recipe.ingredientCount > 0 ? (
          <Link.MenuAction
            title={t('recipes.tab.addToAList')}
            icon="cart"
            onPress={() => router.push({ pathname: '/recipe/[id]/add-to-list', params: { id: recipe.id } })}
          />
        ) : null}
        {/* Spec 4.16: the plan modal, whatever the Plan tab setting. */}
        <Link.MenuAction
          title={t('recipes.tab.plan')}
          icon="calendar"
          onPress={() => router.push({ pathname: '/plan-recipe', params: { recipeId: recipe.id } })}
        />
        {link ? (
          <Link.MenuAction title={t('lists.sections.visitRecipe')} icon="safari" onPress={() => void openRecipeLink(link)} />
        ) : null}
        {/* Spec 4.5: the user's own favorite, whatever other members have, and the Want to try slug. */}
        <Link.MenuAction
          title={t(mine ? 'recipes.tab.unfavorite' : 'recipes.tab.favorite')}
          icon={mine ? 'heart.slash' : 'heart'}
          onPress={() => setMyFavorite(recipe.id, !mine)}
        />
        <Link.MenuAction
          title={t(marks.wantToTry ? 'recipes.tab.triedIt' : 'recipes.tab.wantToTry')}
          icon={marks.wantToTry ? 'checkmark' : 'bookmark'}
          onPress={() => setRecipeSaved(recipe.id, !marks.wantToTry)}
        />
        {/* Recipe collections board C: the recipe screen's Add to collection sheet. */}
        <Link.MenuAction
          title={t('recipes.collections.addTo')}
          icon="rectangle.stack"
          onPress={() => router.push({ pathname: '/recipe/[id]/collections', params: { id: recipe.id } })}
        />
        {/* Recipe collections board B: on a collection's screen. */}
        {removeFrom ? (
          <Link.MenuAction
            title={t('recipes.collections.removeFrom', { name: removeFrom.name })}
            icon="minus.circle"
            onPress={removeFrom.onPress}
          />
        ) : null}
        <Link.MenuAction title={t('recipes.tab.rename')} icon="pencil" onPress={() => promptRecipeName(recipe.id, recipe.name)} />
        <Link.MenuAction title={t('common.delete')} icon="trash" destructive onPress={onDelete} />
      </Link.Menu>
    </Link>
  );
}

/**
 * A recipe's tile with large photos (spec 4.5): a small card holding the photo at 4:3 with the "On <list>" badge over its top
 * corner, the name on up to two lines, and the time (or "Has …" when a search matched only an ingredient).
 * No swipe: Delete is in the menu and a VoiceOver action.
 */
export function RecipeTile({
  recipe,
  group,
  ingredientMatch,
  onList,
  favorite,
  highlighted,
  quickAddTo,
  onQuickAdd,
}: {
  recipe: RecipeSummary;
  group: RecipeGroup;
  ingredientMatch: string | null;
  onList: string | null;
  favorite: RecipeFavorite | null;
  /** Just imported: outlined in `primary` while the toast shows. */
  highlighted: boolean;
  quickAddTo: { id: string; name: string } | null;
  onQuickAdd: (recipeId: string, list: { id: string; name: string }) => void;
}) {
  const t = useT();
  const { colors, spacing, sizes, rounded } = useTheme();
  const time = recipeTimeLabel(recipe.totalMinutes);
  return recipeLink({
    recipe,
    group,
    onList,
    ingredientMatch,
    favorite,
    quickAddTo,
    onQuickAdd,
    onDelete: () => confirmDeleteRecipe(recipe),
    children: (
      <View
        style={{
          gap: spacing.xxs,
          padding: spacing.sm - sizes.focusRing,
          backgroundColor: colors.surface,
          borderWidth: sizes.focusRing,
          // Concentric with the photo's corners, 8 pt in.
          borderRadius: rounded.md + spacing.sm,
          borderColor: highlighted ? colors.primary : 'transparent',
          borderCurve: 'continuous',
        }}>
        <View style={{ marginBottom: spacing.xs }}>
          <RecipePhotoCover recipeId={recipe.id} imageUrl={recipe.imageUrl} photoPath={recipe.photoPath} />
          {onList ? (
            <View style={[styles.tileBadge, { top: spacing.xs, end: spacing.xs }]}>
              <Badge label={t('recipes.tab.onList', { name: onList })} />
            </View>
          ) : null}
        </View>
        <View style={[styles.nameLine, { gap: spacing.xs }]}>
          <ThemedText variant="headline" numberOfLines={2} style={styles.shrink}>
            {recipe.name}
          </ThemedText>
          <SavedMarks tags={recipe.tags} favorite={favorite} />
        </View>
        {ingredientMatch ? (
          <ThemedText variant="footnote" color="inkSecondary">
            {t('recipes.tab.has')}{' '}
            <ThemedText variant="footnote" color="inkSecondary" style={styles.match}>
              {ingredientMatch}
            </ThemedText>
          </ThemedText>
        ) : time ? (
          <ThemedText variant="footnote" color="inkSecondary">
            {time}
          </ThemedText>
        ) : null}
      </View>
    ),
  });
}

/**
 * After a recipe's name (spec 4.5): a small filled `primary` heart when it's the user's favorite, else an outlined
 * `inkSecondary` one when only other members have it, and a bookmark when it's Want to try. Decorative: the row's
 * VoiceOver label says them.
 */
function SavedMarks({ tags, favorite }: { tags: RecipeTags | null; favorite: RecipeFavorite | null }) {
  const { sizes } = useTheme();
  const marks = recipeSavedMarks(tags, favorite);
  return (
    <>
      {marks.favorite === 'mine' ? (
        <Icon name="heart.fill" color="primary" size={sizes.iconSmall} />
      ) : marks.favorite === 'others' ? (
        <Icon name="heart" color="inkSecondary" size={sizes.iconSmall} />
      ) : null}
      {marks.wantToTry ? <Icon name="bookmark" color="inkSecondary" size={sizes.iconSmall} /> : null}
    </>
  );
}

/** How far across the card a swipe goes before letting go asks to delete it. */
const FULL_SWIPE = 0.6;

/** The `danger` Delete behind a swiped card: it widens as the card overshoots, and says when a swipe is full. */
function DeleteAction({
  translation,
  fullAt,
  onFull,
  onPress,
}: {
  translation: SharedValue<number>;
  fullAt: number;
  onFull: (full: boolean) => void;
  onPress: () => void;
}) {
  const t = useT();
  const { colors, spacing, opacity } = useTheme();
  useAnimatedReaction(
    () => translation.get() <= -fullAt,
    (full, was) => {
      if (full !== was) scheduleOnRN(onFull, full);
    },
    [fullAt, onFull],
  );
  const fill = useAnimatedStyle(() => ({ width: Math.max(0, -translation.get()) }));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('common.delete')}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        { backgroundColor: colors.danger, paddingHorizontal: spacing.xl, opacity: pressed ? opacity.pressed : 1 },
      ]}>
      <Animated.View pointerEvents="none" style={[styles.fill, { backgroundColor: colors.danger }, fill]} />
      <Icon name="trash" color="onPrimary" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  shrink: { flexShrink: 1 },
  nameLine: { flexDirection: 'row', alignItems: 'center' },
  match: { fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
  tileBadge: { position: 'absolute', maxWidth: '80%' },
  action: { alignItems: 'center', justifyContent: 'center' },
  fill: { position: 'absolute', top: 0, bottom: 0, right: 0 },
});
