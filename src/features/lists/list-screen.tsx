import * as Haptics from 'expo-haptics';
import { router, Stack, useFocusEffect, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActionSheetIOS,
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  Share,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeInDown, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { aisleHeaderBand, categoryColors, listHeaderColors, prominentButtonTint } from '@/components/appearance';
import { PrimaryButton } from '@/components/button';
import { Card } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { Icon } from '@/components/icon';
import { IconTile } from '@/components/icon-tile';
import { FoldingSection } from '@/components/section-header';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { Toast, type ToastAction } from '@/components/toast';
import { Motion } from '@/constants/theme';
import { categories, lists, userCategoryOrder } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { LIST_HUES, aisleColor, listColorName, listHue, recipeHue } from '@/domain/aisle-color';
import {
  groupByCategory,
  orderCategories,
  sectionAccessibilityLabel,
  SORTING_CATEGORY_ID,
} from '@/domain/category-resolver';
import { groupByRecipe } from '@/domain/recipe-grouping';
import { usualUnitsByKey } from '@/domain/usual-unit';
import { getAccount } from '@/features/auth/account';
import { useMyInvites } from '@/features/households/my-invites';
import { categoriesQuery } from '@/features/categories/categories';
import { ItemAddBar } from '@/features/lists/add-bar';
import { LIST_ADD_LABEL, LIST_ADD_PLACEHOLDER } from '@/features/lists/add-bar-copy';
import { ItemRow } from '@/features/lists/item-row';
import {
  addItem,
  checkItems,
  clearChecked,
  deleteItem,
  groupItems,
  LIST_ITEMS_QUERY_TABLES,
  LIST_RECIPE_LINKS_QUERY_TABLES,
  listItemsQuery,
  listRecipeLinksQuery,
  orderByAisle,
  removeRecipeFromList,
  restoreItems,
  restoreRecipeOnList,
  setItemChecked,
  uncheckAll,
  uncheckItems,
  undeleteItem,
  undoAdd,
  undoMove,
  USUAL_UNITS_QUERY_TABLES,
  usualUnitsQuery,
  type ItemView,
} from '@/features/lists/items';
import {
  addedToast,
  aisleSectionKey,
  alsoInHint,
  CHECK_LINGER_MS,
  checkedAllToast,
  clearCheckedLabel,
  clearedToast,
  collapsedSectionsKey,
  collapsedShowing,
  compactHeaderSubtitle,
  DEFAULT_LIST_VIEW_MODE,
  deletedToast,
  duplicateQuery,
  expandSection,
  fromRecipesHint,
  isAlreadyOnList,
  movedToast,
  orderByNewest,
  readCollapsedSections,
  recipeSectionKey,
  removedRecipeToast,
  siriAddedToast,
  switcherAccessibilityLabel,
  toGetLabel,
  toggleCollapsedSection,
  viewModeKey,
  withLingering,
  type ListViewMode,
  type SectionedViewMode,
} from '@/features/lists/list-view';
import { deleteList, listQuery, setDefaultList, setListColor } from '@/features/lists/lists';
import { promptListName } from '@/features/lists/prompt-list-name';
import { takeMoveResult } from '@/features/lists/move-result';
import { ViewMenuButton } from '@/features/lists/view-menu-button';
import { listShareText } from '@/features/lists/share';
import { onRecipeAddResult, startAdjust, takeRecipeAddResult } from '@/features/lists/recipe-add-result';
import type { RecipeSuggestion } from '@/features/lists/suggestions';
import { categorizePending } from '@/features/categories/categorization';
import { useFeature } from '@/features/plans/features';
import { addWholeRecipeToList, undoRecipeAdd } from '@/features/recipes/add-to-list';
import { importedToast, savedRecipeToast, sharedImportsToast } from '@/features/recipes/import-sheet';
import { openRecipeLink, recipeLinkUrl } from '@/features/recipes/recipe-link';
import { onShareImports } from '@/features/recipes/share-drain';
import { addedRecipeToListToast, addedToRecipeToast } from '@/features/recipes/recipe-view';
import { getAisleColorStyle, getDeviceSetting, getItemRowStyle, setDeviceSetting } from '@/features/settings/device-settings';
import { onSiriAdds } from '@/features/siri/drain';
import { recordListOpened } from '@/features/siri/list-snapshot';
import { useMotion } from '@/hooks/use-motion';
import { useTheme } from '@/hooks/use-theme';
import { parseQuantity } from '@/shared';

type Entry = { key: string; item: ItemView; amountText?: string; hint?: string };

/** One card each (the Checked header sits above its card). */
type Block =
  | { kind: 'newest'; key: string; entries: Entry[] }
  | {
      kind: 'aisle';
      key: string;
      title: string;
      accessibilityLabel: string;
      slug: string | null;
      sorting: boolean;
      collapsed: boolean;
      entries: Entry[];
    }
  | { kind: 'recipe'; key: string; title: string; recipeId: string | null; itemIds: string[]; collapsed: boolean; entries: Entry[] }
  | { kind: 'checked'; key: string; count: number; entries: Entry[] };

/**
 * A list (spec 4.1), the List tab's root: the green header with the list's name, which opens the
 * Your lists sheet, then its rows and the add bar.
 */
export function ListScreen({ id }: { id: string }) {
  const { colors, aisles, spacing, sizes, rounded, opacity, scheme } = useTheme();
  const header = listHeaderColors(colors);
  const headerHeight = useHeaderHeight();
  // Light status bar content on the green header, also while this list's item sheets are up over it.
  const pathname = usePathname();
  const onThisList = pathname === '/lists' || pathname.startsWith(`/list/${id}/`);
  const userId = getAccount()?.userId ?? null;
  // Invites wait in the Your lists sheet; a dot on the switcher says so.
  const invites = useMyInvites();

  const { data: listRows } = useLiveQueryOn(listQuery(id), [lists], [id]);
  const list = listRows[0];
  const { data: itemRows } = useLiveQueryOn(listItemsQuery(id), LIST_ITEMS_QUERY_TABLES, [id]);
  const { data: unitRows } = useLiveQueryOn(usualUnitsQuery(id), USUAL_UNITS_QUERY_TABLES, [id]);
  const { data: recipeLinkRows } = useLiveQueryOn(listRecipeLinksQuery(id), LIST_RECIPE_LINKS_QUERY_TABLES, [id]);
  // Only links that open (spec 4.5): plain text in a recipe's link field gets no Visit recipe on web.
  const recipeLinks = useMemo(
    () => new Map(recipeLinkRows.flatMap((r) => (r.sourceUrl && recipeLinkUrl(r.sourceUrl) ? [[r.id, r.sourceUrl] as const] : []))),
    [recipeLinkRows],
  );
  const usualUnits = useMemo(() => usualUnitsByKey(unitRows), [unitRows]);
  // Without `categorize`, nothing is waiting for an aisle: new names show in Other (spec 4.12).
  const sorts = useFeature('categorize');
  // Spec 4.12: recipe import is a plus feature; without it the menu doesn't offer it.
  const canImport = useFeature('recipe_import');
  const { unchecked, checked } = useMemo(() => groupItems(itemRows, usualUnits, sorts), [itemRows, usualUnits, sorts]);
  // A row checked off by tap stays in place, struck through, for a moment before it moves to Checked,
  // so a second tap can take it back.
  const [lingering, setLingering] = useState<ReadonlySet<string>>(new Set());
  const lingerTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = lingerTimers.current;
    return () => timers.forEach(clearTimeout);
  }, []);
  const stopLingering = useCallback((itemId: string) => {
    clearTimeout(lingerTimers.current.get(itemId));
    lingerTimers.current.delete(itemId);
    setLingering((prev) => {
      if (!prev.has(itemId)) return prev;
      const next = new Set(prev);
      next.delete(itemId);
      return next;
    });
  }, []);
  const toggleChecked = (item: ItemView) => {
    const checking = item.checkedAt === null;
    setItemChecked(item.id, checking, userId);
    if (!checking) return stopLingering(item.id);
    setLingering((prev) => new Set(prev).add(item.id));
    lingerTimers.current.set(item.id, setTimeout(() => stopLingering(item.id), CHECK_LINGER_MS));
  };
  const { placed, checked: shownChecked } = useMemo(
    () => withLingering(unchecked, checked, lingering),
    [unchecked, checked, lingering],
  );
  // Rows are placed by `placed`, but drawn (checked or not) as the item really is.
  const itemById = useMemo(() => new Map([...unchecked, ...checked].map((item) => [item.id, item])), [unchecked, checked]);
  // The list household's aisles (spec 4.3.2), in this user's order.
  const householdId = list?.householdId ?? '';
  const { data: categoryRows } = useLiveQueryOn(
    categoriesQuery(userId ?? '', householdId),
    [categories, userCategoryOrder],
    [userId, householdId],
  );
  const orderedCategories = useMemo(() => orderCategories(categoryRows), [categoryRows]);
  const sections = useMemo(() => groupByCategory(orderedCategories, placed), [orderedCategories, placed]);

  // Spec 4.1: the next cold launch opens the list that last gained focus; 4.10: so does the share sheet.
  useFocusEffect(useCallback(() => recordListOpened(id, userId), [id, userId]));

  const [showChecked, setShowChecked] = useState(false);
  const [selection, setSelection] = useState<Set<string> | null>(null);
  // Spec 4.6: the last choice per list is remembered on this device.
  const [viewMode, setViewModeState] = useState<ListViewMode>(() => getDeviceSetting(viewModeKey(id), DEFAULT_LIST_VIEW_MODE));
  const setViewMode = (mode: ListViewMode) => {
    setViewModeState(mode);
    setDeviceSetting(viewModeKey(id), mode);
  };
  // Settings > Aisle colours: By aisle tints each row (the default) or only the aisle's header. Read on
  // focus, since it's changed on the Settings tab.
  const [aisleColors, setAisleColors] = useState(getAisleColorStyle);
  // Settings > Aisle colours > Item rows: colour bands (the default) or white tiles.
  const [rowStyle, setRowStyle] = useState(getItemRowStyle);
  useFocusEffect(
    useCallback(() => {
      setAisleColors(getAisleColorStyle());
      setRowStyle(getItemRowStyle());
    }, []),
  );
  // White tiles: a card whose rows take their aisle colours is just its tiles on the screen's ground.
  const tiles = rowStyle === 'tiles';
  const tintedGround = tiles ? colors.background : colors.surface;
  // Spec 4.6: sections folded away in By aisle and By recipe, remembered per list and mode on this device.
  // The device setting is the source of truth; this state mirrors it so the list re-renders.
  const readCollapsed = useCallback(
    (mode: SectionedViewMode) => readCollapsedSections(getDeviceSetting<unknown>(collapsedSectionsKey(id, mode), null)),
    [id],
  );
  const [collapsedSaved, setCollapsedSaved] = useState(() => ({ category: readCollapsed('category'), recipe: readCollapsed('recipe') }));
  const saveCollapsed = useCallback(
    (mode: SectionedViewMode, keys: readonly string[]) => {
      setDeviceSetting(collapsedSectionsKey(id, mode), keys);
      setCollapsedSaved((prev) => ({ ...prev, [mode]: [...keys] }));
    },
    [id],
  );
  const toggleSection = (mode: SectionedViewMode, key: string) => {
    const saved = readCollapsed(mode);
    saveCollapsed(mode, toggleCollapsedSection(saved, key));
  };
  const openSection = useCallback(
    (mode: SectionedViewMode, key: string) => {
      const saved = readCollapsed(mode);
      const next = expandSection(saved, key);
      if (next === saved) return;
      saveCollapsed(mode, next);
    },
    [readCollapsed, saveCollapsed],
  );
  // The toast for an add that merged into an item tints that item's row while it shows (spec 4.4).
  const [toast, setToast] = useState<{
    key: string;
    message: string;
    emphasis?: string;
    actions: ToastAction[];
    itemId?: string;
  } | null>(null);
  const highlightedId = toast?.itemId ?? null;
  const slugById = useMemo(() => new Map(categoryRows.map((c) => [c.id, c.slug])), [categoryRows]);
  const nameById = useMemo(() => new Map(categoryRows.map((c) => [c.id, c.name])), [categoryRows]);
  const listRef = useRef<FlatList<Block>>(null);

  // Add mode: while the add field is focused the big title and view button collapse into the native header,
  // and items matching the typed text are marked "already on list".
  const [adding, setAdding] = useState(false);
  const [addText, setAddText] = useState('');
  const addMode = adding && !selection;
  const query = addMode ? duplicateQuery(addText) : null;
  const typedName = parseQuantity(addText).name;
  // Leaving add mode scrolls back to where it started: adds scroll to their section, which would leave the
  // re-expanded title above the fold.
  const scrollOffset = useRef(0);
  const addModeOffset = useRef<number | null>(null);
  useEffect(() => {
    if (addMode) {
      addModeOffset.current = scrollOffset.current;
      return;
    }
    if (addModeOffset.current === null) return;
    listRef.current?.scrollToOffset({ offset: addModeOffset.current, animated: true });
    addModeOffset.current = null;
  }, [addMode]);
  // Select mode swaps the add bar out, and it comes back empty.
  const startSelecting = (ids: string[]) => {
    setAdding(false);
    setAddText('');
    setSelection(new Set(ids));
  };

  const blocks = useMemo<Block[]>(() => {
    const out: Block[] =
      viewMode === 'newest'
        ? // As added: one card, no header, latest add at the top; each row shows its aisle's dot.
          placed.length > 0
          ? [{ kind: 'newest', key: 'newest', entries: orderByNewest(placed).map((item) => ({ key: item.id, item })) }]
          : []
        : viewMode === 'category'
        ? // By aisle: a card per aisle in the user's order, empty ones hidden, items by when added.
          sections.map(({ category, items }): Block => ({
            kind: 'aisle',
            key: aisleSectionKey(category.id),
            title: category.name,
            accessibilityLabel: sectionAccessibilityLabel(category),
            slug: slugById.get(category.id) ?? null,
            sorting: category.id === SORTING_CATEGORY_ID,
            // The Sorting… card has no header, so it never folds.
            collapsed: category.id !== SORTING_CATEGORY_ID && collapsedSaved.category.includes(aisleSectionKey(category.id)),
            entries: items.map((item) => ({ key: item.id, item })),
          }))
        : // By recipe: a card per recipe (an item can be under several), then Other items; in each,
          // Sorting… first, then the user's aisle order, then by when added.
          groupByRecipe(orderByAisle(placed, orderedCategories)).map(
            (section): Block => ({
              kind: 'recipe',
              key: recipeSectionKey(section.recipeId),
              title: section.name,
              recipeId: section.recipeId,
              collapsed: collapsedSaved.recipe.includes(recipeSectionKey(section.recipeId)),
              itemIds: section.entries.map((e) => e.item.id),
              entries: section.entries.map((e) => ({
                key: `${section.recipeId ?? 'other'}-${e.item.id}`,
                item: e.item,
                amountText: e.amountText,
                hint: alsoInHint(e.alsoIn),
              })),
            }),
          );
    if (shownChecked.length > 0) {
      out.push({
        kind: 'checked',
        key: 'checked',
        count: shownChecked.length,
        // An item from a recipe still says so once checked.
        entries: showChecked
          ? shownChecked.map((item) => ({ key: item.id, item, hint: fromRecipesHint(item.contributions) }))
          : [],
      });
    }
    return out;
  }, [viewMode, sections, orderedCategories, placed, shownChecked, showChecked, slugById, collapsedSaved]);

  // The sections Collapse all and Expand all work on: every header in this view (Sorting… has none).
  const sectionMode: SectionedViewMode | null = viewMode === 'newest' ? null : viewMode;
  const foldableKeys = blocks.flatMap((b) => ((b.kind === 'aisle' && !b.sorting) || b.kind === 'recipe' ? [b.key] : []));
  const foldedCount = sectionMode ? collapsedShowing(collapsedSaved[sectionMode], foldableKeys).size : 0;

  // An add or Combine that lands in a folded section opens it, so its highlight shows. By recipe can show
  // an item in several sections; one open one is enough.
  const blocksRef = useRef(blocks);
  useEffect(() => {
    blocksRef.current = blocks;
  }, [blocks]);
  const openSectionOf = useCallback(
    (itemId: string) => {
      const holding = blocksRef.current.filter(
        (b): b is Extract<Block, { kind: 'aisle' | 'recipe' }> =>
          (b.kind === 'aisle' || b.kind === 'recipe') && b.entries.some((e) => e.item.id === itemId),
      );
      if (holding.length === 0 || holding.some((b) => !b.collapsed)) return;
      openSection(holding[0].kind === 'aisle' ? 'category' : 'recipe', holding[0].key);
    },
    [openSection],
  );

  // By aisle and By recipe put a new item in its section, so scroll that section into view once it's there.
  const revealRef = useRef<string | null>(null);
  useEffect(() => {
    const itemId = revealRef.current;
    if (!itemId) return;
    const index = blocks.findIndex((block) => block.entries.some((e) => e.item.id === itemId));
    if (index === -1) return;
    revealRef.current = null;
    openSectionOf(itemId);
    listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0 });
  }, [blocks, openSectionOf]);

  // Select mode (spec 4.5): pick items, then Add to recipe opens the sheet. When it closes having
  // added them, leave Select mode, switch to By recipe and say where they went.
  const addToRecipe = () => {
    if (!selection || selection.size === 0) return;
    router.push({ pathname: '/list/[id]/add-to-recipe', params: { id, items: [...selection].join(',') } });
  };
  useFocusEffect(
    useCallback(() => {
      // Taken on focus, and while showing too: an import's notification tapped on this list (spec 4.10).
      const show = () => {
        // An item moved here from its sheet (spec 4.4): a Combine tints the row it joined, as an add does.
        const moved = takeMoveResult(id);
        if (moved) {
          if (moved.kind === 'combine') openSectionOf(moved.targetItemId);
          setToast({
            key: `moved-${moved.itemId}-${Date.now()}`,
            ...movedToast(moved),
            itemId: moved.kind === 'combine' ? moved.targetItemId : undefined,
            actions: [{ label: 'Undo', onPress: () => (undoMove(moved), setToast(null)) }],
          });
          return;
        }
        const result = takeRecipeAddResult(id);
        if (!result) return;
        if (result.kind === 'toList') {
          // A recipe added from its screen (spec 4.4): items land where this view puts them; one Undo.
          setToast({
            key: `recipe-add-${result.recipeId}-${Date.now()}`,
            ...addedRecipeToListToast(result.recipeName, result.count),
            actions: [{ label: 'Undo', onPress: () => (undoRecipeAdd(result), setToast(null)) }],
          });
          return;
        }
        if (result.kind === 'imported') {
          // A recipe imported from a link (spec 4.10): Undo takes back the adds (and a recipe it created).
          setToast({
            key: `import-${result.recipeId}-${Date.now()}`,
            ...importedToast(result.recipeName, result.count),
            actions: [
              { label: 'Undo', onPress: () => (result.undo(), setToast(null)) },
              {
                label: 'View recipe',
                onPress: () => (setToast(null), router.push({ pathname: '/recipe/[id]', params: { id: result.recipeId } })),
              },
            ],
          });
          return;
        }
        if (result.kind === 'saved') {
          // Saved from this list's menu without adding to it (spec 4.10): Undo only takes back a recipe it created.
          setToast({
            key: `saved-${result.recipeId}-${Date.now()}`,
            ...savedRecipeToast(result.recipeName, result.created),
            actions: [
              ...(result.created ? [{ label: 'Undo', onPress: () => (result.undo(), setToast(null)) }] : []),
              {
                label: 'View recipe',
                onPress: () => (setToast(null), router.push({ pathname: '/recipe/[id]', params: { id: result.recipeId } })),
              },
            ],
          });
          return;
        }
        setSelection(null);
        setViewModeState('recipe');
        setDeviceSetting(viewModeKey(id), 'recipe');
        setToast({
          key: `recipe-${result.recipeId}-${Date.now()}`,
          ...addedToRecipeToast(result.count, result.recipeName),
          actions: [
            {
              label: 'View recipe',
              onPress: () => (setToast(null), router.push({ pathname: '/recipe/[id]', params: { id: result.recipeId } })),
            },
          ],
        });
      };
      show();
      return onRecipeAddResult(show);
    }, [id, openSectionOf]),
  );
  // Adds Siri queued while the app was closed (spec 4.9): one toast, on whichever list is showing.
  useFocusEffect(
    useCallback(
      () =>
        onSiriAdds((count) =>
          setToast({ key: `siri-${Date.now()}`, ...siriAddedToast(count), actions: [] }),
        ),
      [],
    ),
  );
  // Recipes shared to the extension (spec 4.10): one with Undo and View recipe, several as one toast.
  // Recipe-only shares put nothing on a list, so they get no list toast.
  useFocusEffect(
    useCallback(
      () =>
        onShareImports((all) => {
          const imported = all.filter((result) => result.listId !== null);
          if (imported.length === 0) return;
          if (imported.length > 1) {
            setToast({ key: `shared-${Date.now()}`, ...sharedImportsToast(imported.length), actions: [] });
            return;
          }
          const [result] = imported;
          setToast({
            key: `shared-${result.recipeId}-${Date.now()}`,
            ...importedToast(result.recipeName, result.added),
            actions: [
              { label: 'Undo', onPress: () => (result.undo(), setToast(null)) },
              {
                label: 'View recipe',
                onPress: () => (setToast(null), router.push({ pathname: '/recipe/[id]', params: { id: result.recipeId } })),
              },
            ],
          });
        }),
      [],
    ),
  );

  // Spec 4.6: Check all on a section (its header's swipe right, a recipe's menu), with Undo.
  const checkAll = (itemIds: string[]) => {
    const checked = checkItems(itemIds, userId);
    if (checked.ids.length === 0) return;
    setToast({
      key: `checked-${checked.checkedAt.getTime()}`,
      ...checkedAllToast(checked.ids.length),
      actions: [{ label: 'Undo', onPress: () => (uncheckItems(checked), setToast(null)) }],
    });
  };

  // Spec 4.6: Remove recipe from list (its header's swipe left, its menu), with Undo.
  const removeRecipe = (recipeId: string, recipeName: string) => {
    const removed = removeRecipeFromList(id, recipeId);
    if (removed.contributionIds.length === 0) return;
    setToast({
      key: `removed-${recipeId}-${removed.deletedAt.getTime()}`,
      ...removedRecipeToast(recipeName),
      actions: [{ label: 'Undo', onPress: () => (restoreRecipeOnList(removed), setToast(null)) }],
    });
  };

  // Spec 4.6: long-pressing a recipe's header (light haptic) opens its menu; VoiceOver gets the same as actions.
  const recipeActions = (
    block: Extract<Block, { kind: 'recipe' }>,
  ): { label: string; onPress: () => void; destructive?: boolean }[] => {
    const recipeId = block.recipeId;
    if (!recipeId) return [];
    const link = recipeLinks.get(recipeId);
    return [
      { label: 'Check all', onPress: () => checkAll(block.itemIds) },
      ...(link ? [{ label: 'Visit recipe on web', onPress: () => void openRecipeLink(link) }] : []),
      { label: 'Remove recipe from list', destructive: true, onPress: () => removeRecipe(recipeId, block.title) },
    ];
  };

  const recipeMenu = (block: Extract<Block, { kind: 'recipe' }>) => {
    const actions = recipeActions(block);
    if (actions.length === 0) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: block.title,
        options: [...actions.map((a) => a.label), 'Cancel'],
        destructiveButtonIndex: actions.findIndex((a) => a.destructive),
        cancelButtonIndex: actions.length,
      },
      (index) => actions[index]?.onPress(),
    );
  };

  const add = (value: string) => {
    const result = addItem(id, value, userId);
    if (result) void categorizePending(result.pendingNames);
    // In As added a new or re-added item lands at the top, so bring the top into view; elsewhere, its section.
    if (viewMode === 'newest' && result && result.kind !== 'combine') listRef.current?.scrollToOffset({ offset: 0, animated: true });
    if (viewMode !== 'newest' && result) revealRef.current = result.itemId;
    if (result?.kind !== 'combine') return;
    // Spec 4.4: Combine without a prompt, tint the row, and offer Undo.
    setToast({
      key: result.contributionId,
      ...addedToast(result.existingName ?? value.trim(), result.totalAmountText),
      itemId: result.itemId,
      actions: [{ label: 'Undo', onPress: () => (undoAdd(result), setToast(null)) }],
    });
  };

  // Spec 4.2: a recipe picked in the add bar adds all its ingredients at 1× (Combine as 4.4 bulk add), with Undo,
  // and Adjust, which opens the recipe's add sheet; adding from there replaces this add.
  const addRecipe = (recipe: RecipeSuggestion) => {
    const added = addWholeRecipeToList(id, recipe.id, userId);
    if (!added) return;
    void categorizePending(added.pendingNames);
    if (viewMode === 'newest') listRef.current?.scrollToOffset({ offset: 0, animated: true });
    setToast({
      key: `recipe-add-${recipe.id}-${Date.now()}`,
      ...addedRecipeToListToast(added.recipeName, added.count),
      actions: [
        { label: 'Undo', onPress: () => (undoRecipeAdd(added), setToast(null)) },
        {
          label: 'Adjust',
          onPress: () => {
            setToast(null);
            const adjust = startAdjust({ listId: id, recipeId: recipe.id, results: added.results });
            router.push({ pathname: '/recipe/[id]/add-to-list', params: { id: recipe.id, list: id, adjust } });
          },
        },
      ],
    });
  };

  const remove = useCallback((item: ItemView) => {
    deleteItem(item.id);
    setToast({
      key: `deleted-${item.id}`,
      ...deletedToast(item.displayName),
      actions: [{ label: 'Undo', onPress: () => (undeleteItem(item.id), setToast(null)) }],
    });
  }, []);

  // Spec 4.1, 4.6: no confirmation; the toast's Undo brings exactly those items back.
  const clear = useCallback(() => {
    const cleared = clearChecked(id);
    if (cleared.ids.length === 0) return;
    setToast({
      key: `cleared-${cleared.deletedAt.getTime()}`,
      ...clearedToast(cleared.ids.length),
      actions: [{ label: 'Undo', onPress: () => (restoreItems(cleared.ids, cleared.deletedAt), setToast(null)) }],
    });
  }, [id]);

  const checkedMenu = (count: number) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    ActionSheetIOS.showActionSheetWithOptions(
      { options: [clearCheckedLabel(count), 'Uncheck all', 'Cancel'], destructiveButtonIndex: 0, cancelButtonIndex: 2 },
      (index) => {
        if (index === 0) clear();
        if (index === 1) uncheckAll(id);
      },
    );
  };

  const dismissToast = useCallback(() => setToast(null), []);

  const renderEntry = (
    entry: Entry,
    index: number,
    background: string,
    sorting = false,
    aisle?: { name: string },
    plain = false,
    tile = false,
  ) => {
    const item = itemById.get(entry.item.id) ?? entry.item;
    return (
      <ItemRow
        key={entry.key}
        item={item}
        background={background}
        tint={entry.item.id === highlightedId ? aisles[aisleColor(slugById.get(entry.item.categoryId))].soft : undefined}
        // Unchecked rows take their aisle's tint (grey while Sorting…); checked ones stay plain so they recede,
        // as do rows under a coloured aisle header.
        look={item.checkedAt === null && !plain ? categoryColors(slugById.get(entry.item.categoryId), scheme, rowStyle) : undefined}
        tile={tile}
        alreadyOnList={isAlreadyOnList(item, query) ? { typed: typedName } : undefined}
        first={index === 0}
        sorting={sorting}
        amountText={entry.amountText}
        hint={entry.hint}
        aisle={aisle}
        selected={selection ? selection.has(entry.item.id) : undefined}
        onToggle={() => (selection ? setSelection(toggleIn(selection, entry.item.id)) : toggleChecked(item))}
        onDelete={() => remove(entry.item)}
        onEdit={() => router.push({ pathname: '/list/[id]/item/[itemId]', params: { id, itemId: entry.item.id } })}
        onSelect={selection ? undefined : () => startSelecting([entry.item.id])}
      />
    );
  };

  // As added and By recipe mix aisles in one card: each row's tint shows its aisle, and VoiceOver reads its name.
  const renderEntryWithAisle = (e: Entry, i: number) => {
    const categoryId = e.item.categoryId;
    return renderEntry(e, i, tintedGround, categoryId === SORTING_CATEGORY_ID, { name: nameById.get(categoryId) ?? '' }, false, tiles);
  };

  const renderBlock = (block: Block) => {
    if (block.kind === 'newest') {
      return <Card background={tiles ? 'background' : undefined}>{block.entries.map(renderEntryWithAisle)}</Card>;
    }
    if (block.kind === 'aisle') {
      if (block.sorting) {
        // No header: the dashed checks and each row's "Sorting…" label say what this card is.
        return (
          <Card background={tiles ? 'background' : undefined}>
            {block.entries.map((e, i) => renderEntry(e, i, tintedGround, true, undefined, false, tiles))}
          </Card>
        );
      }
      const plain = aisleColors === 'header';
      const tiled = tiles && !plain;
      return (
        <Card background={tiled ? 'background' : undefined}>
          <FoldingSection
            title={block.title}
            accessibilityLabel={block.accessibilityLabel}
            ground={tiled ? colors.background : undefined}
            dotColor={aisles[aisleColor(block.slug)].dot}
            band={plain ? aisleHeaderBand(block.slug, scheme) : undefined}
            count={block.entries.length}
            collapsed={block.collapsed}
            onToggle={() => toggleSection('category', block.key)}
            // Spec 4.6: swipe right to check the aisle off; no swipe to delete. VoiceOver gets it as an action.
            onSwipeCheck={selection ? undefined : () => checkAll(block.entries.map((e) => e.item.id))}
            actions={selection ? undefined : [{ label: 'Check all', onPress: () => checkAll(block.entries.map((e) => e.item.id)) }]}>
            {block.entries.map((e, i) => renderEntry(e, i, tiled ? colors.background : colors.surface, false, undefined, plain, tiled))}
          </FoldingSection>
        </Card>
      );
    }
    if (block.kind === 'recipe') {
      const recipeId = block.recipeId;
      return (
        <Card background={tiles ? 'background' : undefined}>
          <FoldingSection
            title={block.title}
            ground={tiles ? colors.background : undefined}
            leading={block.recipeId ? <IconTile hue={recipeHue(block.recipeId)} name="fork.knife" /> : undefined}
            onLongPress={block.recipeId ? () => recipeMenu(block) : undefined}
            actions={recipeActions(block)}
            // Spec 4.6: swipe right to check all, left to remove the recipe (not Other items).
            onSwipeCheck={selection ? undefined : () => checkAll(block.itemIds)}
            onSwipeRemove={selection || !recipeId ? undefined : () => removeRecipe(recipeId, block.title)}
            // The count shows while folded, so you can see what's hidden; VoiceOver always reads it.
            count={block.entries.length}
            hideCount={!block.collapsed}
            collapsed={block.collapsed}
            onToggle={() => toggleSection('recipe', block.key)}>
            {block.entries.map(renderEntryWithAisle)}
          </FoldingSection>
        </Card>
      );
    }
    return (
      <View>
        <View style={[styles.row, { paddingRight: spacing.lg + spacing.xs - spacing.sm }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showChecked }}
            accessibilityLabel={`Checked, ${block.count} ${block.count === 1 ? 'item' : 'items'}`}
            onPress={() => setShowChecked((v) => !v)}
            onLongPress={() => checkedMenu(block.count)}
            style={({ pressed }) => [
              styles.row,
              styles.flex,
              {
                minHeight: sizes.minTapTarget,
                paddingLeft: spacing.lg + spacing.xs,
                paddingRight: spacing.sm,
                gap: spacing.sm,
                opacity: pressed ? opacity.pressed : 1,
              },
            ]}>
            <ThemedText variant="sectionLabel" color="inkSecondary" style={styles.flex}>
              Checked ({block.count})
            </ThemedText>
            <Icon name={showChecked ? 'chevron.down' : 'chevron.right'} color="inkSecondary" size={sizes.iconSmall} />
          </Pressable>
          <ClearCheckedButton count={block.count} onPress={clear} />
        </View>
        {block.entries.length > 0 ? (
          <Card>{block.entries.map((e, i) => renderEntry(e, i, colors.surface))}</Card>
        ) : null}
      </View>
    );
  };

  const confirmDelete = () => {
    if (!list) return;
    Alert.alert(`Delete “${list.name}”?`, 'Its items are deleted too.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          // The List tab moves on to the next list by itself.
          deleteList(id);
        },
      },
    ]);
  };

  // Loading (a few ms), or just deleted on the way back.
  if (!list) return <Screen />;

  return (
    <Screen>
      <Stack.Screen options={{ headerStyle: { backgroundColor: header.ground }, headerTintColor: header.title }} />
      {onThisList ? <StatusBar style="light" /> : null}
      {addMode ? (
        <Stack.Title asChild>
          <CompactTitle name={list.name} subtitle={compactHeaderSubtitle(unchecked.length, viewMode)} />
        </Stack.Title>
      ) : null}
      {/* At rest the list's name sits in the header's left slot, on one row with ⋯; add mode swaps it for CompactTitle. */}
      {addMode ? null : (
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.View hidesSharedBackground>
            <SwitcherTitle name={list.name} invites={invites.length} />
          </Stack.Toolbar.View>
        </Stack.Toolbar>
      )}
      <Stack.Toolbar placement="right" tintColor={header.title}>
        {selection ? (
          <Stack.Toolbar.Button variant="done" tintColor={prominentButtonTint(scheme, colors)} onPress={() => setSelection(null)}>
            Done
          </Stack.Toolbar.Button>
        ) : null}
        {/* A white wash, as the view pill, with a white ⋯. */}
        <Stack.Toolbar.Menu
          icon="ellipsis"
          variant="prominent"
          tintColor={header.viewButton.fill}
          accessibilityLabel="List actions"
          hidden={!!selection}>
          <Stack.Toolbar.MenuAction icon="checkmark.circle" disabled={unchecked.length === 0} onPress={() => startSelecting([])}>
            Select items
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="square.and.arrow.up" onPress={() => Share.share({ message: listShareText(list.name, unchecked) })}>
            Share as text
          </Stack.Toolbar.MenuAction>
          {canImport ? (
            <Stack.Toolbar.MenuAction icon="link" onPress={() => router.push({ pathname: '/import-recipe', params: { list: id } })}>
              Add recipe from link…
            </Stack.Toolbar.MenuAction>
          ) : null}
          <Stack.Toolbar.MenuAction icon="arrow.uturn.backward" disabled={checked.length === 0} onPress={() => uncheckAll(id)}>
            Uncheck all
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="xmark.circle" disabled={checked.length === 0} onPress={clear}>
            Clear checked items
          </Stack.Toolbar.MenuAction>
          {sectionMode ? (
            <Stack.Toolbar.MenuAction
              icon="rectangle.compress.vertical"
              disabled={foldableKeys.length === 0 || foldedCount === foldableKeys.length}
              onPress={() => saveCollapsed(sectionMode, foldableKeys)}>
              Collapse all
            </Stack.Toolbar.MenuAction>
          ) : null}
          {sectionMode ? (
            <Stack.Toolbar.MenuAction
              icon="rectangle.expand.vertical"
              disabled={foldedCount === 0}
              onPress={() => saveCollapsed(sectionMode, [])}>
              Expand all
            </Stack.Toolbar.MenuAction>
          ) : null}
          <Stack.Toolbar.MenuAction icon="arrow.up.arrow.down" onPress={() => router.push('/category-order')}>
            Reorder sections
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="pencil" onPress={() => promptListName(list.id, list.name)}>
            Rename
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.Menu icon="paintpalette">
            <Stack.Toolbar.Label>Colour</Stack.Toolbar.Label>
            {[null, ...LIST_HUES].map((hue) => (
              <Stack.Toolbar.MenuAction key={hue ?? 'default'} isOn={listHue(list.color) === hue} onPress={() => setListColor(id, hue)}>
                {listColorName(hue)}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
          {userId ? (
            <Stack.Toolbar.MenuAction icon="mic" onPress={() => setDefaultList(userId, id)}>
              Make default for Siri
            </Stack.Toolbar.MenuAction>
          ) : null}
          <Stack.Toolbar.MenuAction icon="trash" destructive onPress={confirmDelete}>
            Delete list
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={headerHeight}>
        <FlatList
          ref={listRef}
          style={styles.flex}
          data={blocks}
          keyExtractor={(block) => block.key}
          ListHeaderComponent={
            <View>
              <View style={{ backgroundColor: header.ground }}>
                {/* Pulling down past the top shows more green, not the list's ground. */}
                <View style={[styles.overscroll, { backgroundColor: header.ground }]} />
                <CollapsingHeader collapsed={addMode}>
                  <View
                    style={[
                      styles.title,
                      { columnGap: spacing.md, paddingTop: spacing.xs, paddingBottom: spacing.md, paddingHorizontal: spacing.lg + spacing.xs },
                    ]}>
                    {toGetLabel(unchecked.length) ? (
                      <ThemedText variant="amount" color="onHeaderSecondary">
                        {toGetLabel(unchecked.length)}
                      </ThemedText>
                    ) : null}
                    <ViewMenuButton value={viewMode} onChange={setViewMode} />
                  </View>
                </CollapsingHeader>
                <View style={{ height: rounded.card }} />
              </View>
              {/* The list's sheet: rounded top corners over the bottom of the green. */}
              <View
                style={[
                  styles.sheetTop,
                  {
                    height: rounded.card,
                    marginTop: -rounded.card,
                    borderTopLeftRadius: rounded.card,
                    borderTopRightRadius: rounded.card,
                    backgroundColor: colors.background,
                  },
                ]}
              />
            </View>
          }
          ItemSeparatorComponent={() => <View style={{ height: spacing.sm + spacing.xxs }} />}
          // Add mode: scrolling or checking off rows keeps the keyboard up.
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="none"
          onScroll={(e) => (scrollOffset.current = e.nativeEvent.contentOffset.y)}
          scrollEventThrottle={16}
          contentContainerStyle={blocks.length === 0 ? styles.flex : { paddingBottom: spacing.lg }}
          ListEmptyComponent={<EmptyState message="Nothing on this list yet. Add an item below." />}
          renderItem={({ item: block }) => renderBlock(block)}
          onScrollToIndexFailed={({ index, averageItemLength }) =>
            listRef.current?.scrollToOffset({ offset: index * averageItemLength, animated: true })
          }
        />

        {toast ? (
          <View style={{ paddingBottom: spacing.sm }}>
            <Toast
              key={toast.key}
              message={toast.message}
              emphasis={toast.emphasis}
              actions={toast.actions}
              onDismiss={dismissToast}
            />
          </View>
        ) : null}

        {selection ? (
          <SelectionBar count={selection.size} onAddToRecipe={addToRecipe} />
        ) : (
          <ItemAddBar
            householdId={list.householdId}
            onAdd={add}
            onAddRecipe={addRecipe}
            onTextChange={setAddText}
            onFocusChange={setAdding}
            placeholder={LIST_ADD_PLACEHOLDER}
            accessibilityLabel={LIST_ADD_LABEL}
          />
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}

/**
 * The list's name with a small chevron after it: one button that opens the Your lists sheet (spec 4.1,
 * board E). A long name truncates so the chevron, and ⋯ beside it, stay in view. A dot on the chevron
 * while an invite is waiting, which the sheet shows.
 */
function SwitcherTitle({ name, invites }: { name: string; invites: number }) {
  const { colors, aisles, spacing, sizes, rounded, opacity } = useTheme();
  const look = listHeaderColors(colors);
  const { width } = useWindowDimensions();
  // Leaves room for the bar's two 16 pt margins, ⋯ and a gap before it. The bar's margin is 4 pt short of
  // the sheet's 20 pt gutter, so the name is padded over to line up with "N to get".
  const maxWidth = width - spacing.lg * 2 - sizes.minTapTarget - spacing.md;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={switcherAccessibilityLabel(name, invites)}
      accessibilityHint="Shows your other lists"
      onPress={() => router.push('/lists-sheet')}
      style={({ pressed }) => [
        styles.switcher,
        {
          maxWidth,
          minHeight: sizes.minTapTarget,
          paddingLeft: spacing.xs,
          gap: spacing.xs + spacing.xxs,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <ThemedText variant="screenTitle" color="onHeader" numberOfLines={1} style={styles.shrink}>
        {name}
      </ThemedText>
      <View>
        <Icon name="chevron.down" color="onHeaderSecondary" size={sizes.iconSmall + spacing.xs} weight="bold" />
        {invites > 0 ? (
          <View
            style={[
              styles.inviteDot,
              {
                width: sizes.inviteDot + sizes.inviteDotRing * 2,
                height: sizes.inviteDot + sizes.inviteDotRing * 2,
                top: -sizes.inviteDot,
                right: -sizes.inviteDot,
                borderRadius: rounded.full,
                borderWidth: sizes.inviteDotRing,
                borderColor: look.ground,
                backgroundColor: aisles.amber.dot,
              },
            ]}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * Add mode's title in the native header, beside ⋯: the list's name over
 * "8 to get · As added". Tapping it hides the keyboard, which leaves add mode.
 */
function CompactTitle({ name, subtitle }: { name: string; subtitle: string }) {
  const { sizes } = useTheme();
  const { reduceMotion } = useMotion();
  return (
    <Animated.View entering={(reduceMotion ? FadeIn : FadeInDown).duration(Motion.duration)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${name}, ${subtitle}`}
        accessibilityHint="Hides the keyboard"
        onPress={Keyboard.dismiss}
        style={[styles.compactTitle, { minHeight: sizes.minTapTarget }]}>
        <ThemedText variant="headline" color="onHeader" numberOfLines={1}>
          {name}
        </ThemedText>
        <ThemedText variant="footnote" color="onHeaderSecondary" numberOfLines={1}>
          {subtitle}
        </ThemedText>
      </Pressable>
    </Animated.View>
  );
}

/**
 * The title and view button above the list, collapsed in add mode: it shrinks, lifts and fades while its height
 * closes, so the list takes the space. Under Reduce Motion it only fades, and the height snaps.
 */
function CollapsingHeader({ collapsed, children }: { collapsed: boolean; children: ReactNode }) {
  const { spacing } = useTheme();
  const { reduceMotion } = useMotion();
  const height = useSharedValue<number | null>(null);
  // Once measured, the content is laid out apart from the shrinking box, so a re-layout while collapsed (the
  // "8 to get" count changing) still measures its full height rather than the squeezed one.
  const [measured, setMeasured] = useState(false);
  const progress = useSharedValue(collapsed ? 1 : 0);
  const target = collapsed ? 1 : 0;
  useEffect(() => {
    progress.value = withTiming(target, { duration: Motion.duration });
  }, [progress, target]);
  const lift = spacing.lg;
  const style = useAnimatedStyle(() => {
    const p = progress.value;
    const shut = reduceMotion ? target : p;
    return {
      opacity: 1 - p,
      height: height.value === null ? undefined : height.value * (1 - shut),
      transform: reduceMotion ? [] : [{ translateY: -lift * p }, { scale: 1 - 0.1 * p }],
    };
  });
  return (
    <Animated.View
      style={[styles.collapsing, style]}
      pointerEvents={collapsed ? 'none' : 'auto'}
      accessibilityElementsHidden={collapsed}
      importantForAccessibility={collapsed ? 'no-hide-descendants' : 'auto'}>
      <View
        style={measured ? styles.measured : null}
        onLayout={(e) => {
          height.value = e.nativeEvent.layout.height;
          setMeasured(true);
        }}>
        {children}
      </View>
    </Animated.View>
  );
}

function toggleIn(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function SelectionBar({ count, onAddToRecipe }: { count: number; onAddToRecipe: () => void }) {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        gap: spacing.sm,
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.sm,
        paddingBottom: Math.max(insets.bottom, spacing.sm),
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: colors.border,
      }}>
      <ThemedText variant="footnote" color="inkSecondary" accessibilityLiveRegion="polite">
        {count === 0 ? 'Tap items to select them' : `${count} selected`}
      </ThemedText>
      <PrimaryButton label="Add to recipe" disabled={count === 0} onPress={onAddToRecipe} />
    </View>
  );
}

/** The Checked header's Clear: a small soft destructive pill with a 44 pt hit area. */
function ClearCheckedButton({ count, onPress }: { count: number; onPress: () => void }) {
  const { colors, sizes, spacing, rounded, opacity } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={clearCheckedLabel(count)}
      onPress={onPress}
      style={({ pressed }) => [
        styles.round,
        { minHeight: sizes.minTapTarget, paddingHorizontal: spacing.sm, opacity: pressed ? opacity.pressed : 1 },
      ]}>
      <View
        style={{
          backgroundColor: colors.dangerSoft,
          borderRadius: rounded.full,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.xs,
        }}>
        <ThemedText variant="sectionLabel" color="danger">
          Clear
        </ThemedText>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  title: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  switcher: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
  shrink: { flexShrink: 1 },
  inviteDot: { position: 'absolute' },
  round: { alignItems: 'center', justifyContent: 'center' },
  compactTitle: { alignItems: 'center', justifyContent: 'center' },
  // Clips the title while its height closes; the scale shrinks it toward its top.
  collapsing: { overflow: 'hidden', transformOrigin: 'top' },
  measured: { position: 'absolute', top: 0, left: 0, right: 0 },
  overscroll: { position: 'absolute', left: 0, right: 0, bottom: '100%', height: 1000 },
  sheetTop: { overflow: 'hidden', borderCurve: 'continuous' },
});
