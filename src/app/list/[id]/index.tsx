import * as Haptics from 'expo-haptics';
import { router, Stack, useFocusEffect, useLocalSearchParams, usePathname } from 'expo-router';
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
import { AISLE_HUES, aisleColor, listColorName, listHue, recipeHue } from '@/domain/aisle-color';
import {
  groupByCategory,
  orderCategories,
  sectionAccessibilityLabel,
  SORTING_CATEGORY_ID,
} from '@/domain/category-resolver';
import { groupByRecipe } from '@/domain/recipe-grouping';
import { usualUnitsByKey } from '@/domain/usual-unit';
import { getAccount } from '@/features/auth/account';
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
  listItemsQuery,
  orderByAisle,
  removeRecipeFromList,
  restoreItems,
  setItemChecked,
  uncheckAll,
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
  siriAddedToast,
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
import { addWholeRecipeToList, undoRecipeAdd } from '@/features/recipes/add-to-list';
import { importedToast, sharedImportsToast } from '@/features/recipes/import-sheet';
import { onShareImports } from '@/features/recipes/share-drain';
import { addedRecipeToListToast, addedToRecipeToast } from '@/features/recipes/recipe-view';
import { getAisleColorStyle, getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
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

export default function ListScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, aisles, spacing, sizes, rounded, opacity, scheme } = useTheme();
  const header = listHeaderColors(colors);
  const headerHeight = useHeaderHeight();
  // Light status bar content on the green header, also while this list's item sheets are up over it.
  const pathname = usePathname();
  const onThisList = pathname === `/list/${id}` || pathname.startsWith(`/list/${id}/`);
  const userId = getAccount()?.userId ?? null;

  const { data: listRows } = useLiveQueryOn(listQuery(id), [lists], [id]);
  const list = listRows[0];
  const { data: itemRows } = useLiveQueryOn(listItemsQuery(id), LIST_ITEMS_QUERY_TABLES, [id]);
  const { data: unitRows } = useLiveQueryOn(usualUnitsQuery(id), USUAL_UNITS_QUERY_TABLES, [id]);
  const usualUnits = useMemo(() => usualUnitsByKey(unitRows), [unitRows]);
  const { unchecked, checked } = useMemo(() => groupItems(itemRows, usualUnits), [itemRows, usualUnits]);
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
  useFocusEffect(useCallback(() => setAisleColors(getAisleColorStyle()), []));
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
  useFocusEffect(
    useCallback(
      () =>
        onShareImports((imported) => {
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

  const recipeMenu = (block: Extract<Block, { kind: 'recipe' }>) => {
    if (!block.recipeId) return;
    const recipeId = block.recipeId;
    ActionSheetIOS.showActionSheetWithOptions(
      { title: block.title, options: ['Check all', 'Remove recipe from list', 'Cancel'], destructiveButtonIndex: 1, cancelButtonIndex: 2 },
      (index) => {
        if (index === 0) checkItems(block.itemIds, userId);
        if (index === 1) removeRecipeFromList(id, recipeId);
      },
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
        look={item.checkedAt === null && !plain ? categoryColors(slugById.get(entry.item.categoryId), scheme) : undefined}
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
    return renderEntry(e, i, colors.surface, categoryId === SORTING_CATEGORY_ID, { name: nameById.get(categoryId) ?? '' });
  };

  const renderBlock = (block: Block) => {
    if (block.kind === 'newest') {
      return <Card>{block.entries.map(renderEntryWithAisle)}</Card>;
    }
    if (block.kind === 'aisle') {
      if (block.sorting) {
        // No header: the dashed checks and each row's "Sorting…" label say what this card is.
        return (
          <Card>
            {block.entries.map((e, i) => renderEntry(e, i, colors.surface, true))}
          </Card>
        );
      }
      return (
        <Card>
          <FoldingSection
            title={block.title}
            accessibilityLabel={block.accessibilityLabel}
            dotColor={aisles[aisleColor(block.slug)].dot}
            band={aisleColors === 'header' ? aisleHeaderBand(block.slug, scheme) : undefined}
            count={block.entries.length}
            collapsed={block.collapsed}
            onToggle={() => toggleSection('category', block.key)}>
            {block.entries.map((e, i) => renderEntry(e, i, colors.surface, false, undefined, aisleColors === 'header'))}
          </FoldingSection>
        </Card>
      );
    }
    if (block.kind === 'recipe') {
      return (
        <Card>
          <FoldingSection
            title={block.title}
            leading={block.recipeId ? <IconTile hue={recipeHue(block.recipeId)} name="fork.knife" /> : undefined}
            trailing={block.recipeId ? <RecipeActionsButton name={block.title} onPress={() => recipeMenu(block)} /> : undefined}
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
          deleteList(id);
          router.back();
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
      <Stack.Toolbar placement="right" tintColor={header.title}>
        {selection ? (
          <Stack.Toolbar.Button variant="done" tintColor={prominentButtonTint(scheme, colors)} onPress={() => setSelection(null)}>
            Done
          </Stack.Toolbar.Button>
        ) : null}
        <Stack.Toolbar.Menu icon="ellipsis.circle" accessibilityLabel="List actions" hidden={!!selection}>
          <Stack.Toolbar.MenuAction icon="checkmark.circle" disabled={unchecked.length === 0} onPress={() => startSelecting([])}>
            Select items
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="square.and.arrow.up" onPress={() => Share.share({ message: listShareText(list.name, unchecked) })}>
            Share as text
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="link" onPress={() => router.push({ pathname: '/import-recipe', params: { list: id } })}>
            Add recipe from link…
          </Stack.Toolbar.MenuAction>
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
            {[null, ...AISLE_HUES].map((hue) => (
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
                  <View style={{ gap: spacing.md, paddingBottom: spacing.md }}>
                    <View
                      style={[
                        styles.title,
                        { paddingHorizontal: spacing.lg + spacing.xs, paddingTop: spacing.sm, columnGap: spacing.sm + spacing.xxs },
                      ]}>
                      <ThemedText variant="screenTitle" color="onHeader" accessibilityRole="header">
                        {list.name}
                      </ThemedText>
                      {toGetLabel(unchecked.length) ? (
                        <ThemedText variant="amount" color="onHeaderSecondary">
                          {toGetLabel(unchecked.length)}
                        </ThemedText>
                      ) : null}
                    </View>
                    <View style={{ paddingHorizontal: spacing.lg + spacing.xs }}>
                      <ViewMenuButton value={viewMode} onChange={setViewMode} />
                    </View>
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
            listId={id}
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
 * Add mode's title in the native header, between its back button and ⋯: the list's name over
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
      <View onLayout={(e) => (height.value = e.nativeEvent.layout.height)}>{children}</View>
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

/** A recipe card's actions button (board 03): a 36 pt round button with a 44 pt hit area. */
function RecipeActionsButton({ name, onPress }: { name: string; onPress: () => void }) {
  const { colors, sizes, rounded, opacity } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name} actions`}
      onPress={onPress}
      hitSlop={(sizes.minTapTarget - sizes.iconWell) / 2}
      style={({ pressed }) => [
        styles.round,
        {
          width: sizes.iconWell,
          height: sizes.iconWell,
          borderRadius: rounded.full,
          backgroundColor: colors.background,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <Icon name="ellipsis" color="ink" />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  title: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline' },
  round: { alignItems: 'center', justifyContent: 'center' },
  compactTitle: { alignItems: 'center', justifyContent: 'center' },
  // Clips the title while its height closes; the scale shrinks it toward its top.
  collapsing: { overflow: 'hidden', transformOrigin: 'top' },
  overscroll: { position: 'absolute', left: 0, right: 0, bottom: '100%', height: 1000 },
  sheetTop: { overflow: 'hidden', borderCurve: 'continuous' },
});
