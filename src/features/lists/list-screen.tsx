import * as Haptics from 'expo-haptics';
import { router, Stack, useFocusEffect, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  ActionSheetIOS,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  Share,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeInDown, useAnimatedRef, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { aisleHeaderBand, categoryColors, listHeaderColors, prominentButtonTint } from '@/components/appearance';
import { Button, PrimaryButton } from '@/components/button';
import { Card } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { Icon } from '@/components/icon';
import { IconTile } from '@/components/icon-tile';
import { FoldingSection } from '@/components/section-header';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { Toast, type ToastAction } from '@/components/toast';
import { Motion } from '@/constants/theme';
import { categories, db, households, lists, userCategoryOrder } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { aisleColor, memberHue, recipeHue } from '@/domain/aisle-color';
import {
  groupByCategory,
  orderCategories,
  sectionAccessibilityLabel,
  SORTING_CATEGORY_ID,
} from '@/domain/category-resolver';
import { groupByRecipe } from '@/domain/recipe-grouping';
import { usualUnitsByKey } from '@/domain/usual-unit';
import { getAccount } from '@/features/auth/account';
import { avatarInitial, combineLanguagesQuery } from '@/features/households/households';
import { nameOf, useMemberNames } from '@/features/households/member-names';
import { useMyInvites } from '@/features/households/my-invites';
import { aisleRowActions, aisleRowLabel, moveId } from '@/features/categories/aisle-order';
import { categoriesQuery, localFamilyKey } from '@/features/categories/categories';
import { ItemAddBar } from '@/features/lists/add-bar';
import { LIST_ADD_LABEL, LIST_ADD_PLACEHOLDER } from '@/features/lists/add-bar-copy';
import { AddingPill } from '@/features/lists/adding-pill';
import { arrivalPillText, inSight, useArrivalAnnouncements, useListArrivals } from '@/features/lists/arrivals';
import { ItemRow, type RowMove } from '@/features/lists/item-row';
import { shoppingOnList, useForeground, useKeepListAwake } from '@/features/lists/keep-awake';
import { newsNames, rowNews, useListVisitNews } from '@/features/lists/list-news';
import { NewsCard } from '@/features/lists/news-card';
import { useAddingTail, useListPresence } from '@/features/lists/presence';
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
  recheckItems,
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
  applyManualOrder,
  alsoInHint,
  CHECK_LINGER_MS,
  checkedAllToast,
  checkedChoiceAfterAllDoneChange,
  checkedSectionOpen,
  checkedHeaderLabel,
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
  alreadyOnListMatch,
  manualOrderKey,
  movedToast,
  orderByNewest,
  readCollapsedSections,
  recipeSectionKey,
  removedRecipeToast,
  siriAddedToast,
  switcherAccessibilityLabel,
  toGetLabel,
  toggleCollapsedSection,
  uncheckedAllToast,
  viewModeKey,
  withLingering,
  type ListViewMode,
  type SectionedViewMode,
} from '@/features/lists/list-view';
import { listQuery } from '@/features/lists/lists';
import { takeMoveResult } from '@/features/lists/move-result';
import { ReorderableRows } from '@/features/lists/reorderable-rows';
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
import { addedRecipeToListToast, addedRecipeWithStaplesToast, addedToRecipeToast } from '@/features/recipes/recipe-view';
import {
  clearManualOrder,
  getAisleColorStyle,
  getAlwaysShowChecked,
  getDeviceSetting,
  getItemRowStyle,
  getManualOrder,
  saveManualOrder,
  setDeviceSetting,
} from '@/features/settings/device-settings';
import { onSiriAdds } from '@/features/siri/drain';
import { recordListOpened } from '@/features/siri/list-snapshot';
import { useMotion } from '@/hooks/use-motion';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';
import { withAisleNames } from '@/i18n/vocabulary';
import { displayItemName } from '@/shared';

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
 * Spec 4.1: checking off (one item, or Check all once) plays a light tick, a selection haptic rather
 * than an impact's thud. The only place it's played, so the row, its swipe and Check all can't drift apart.
 */
function checkHaptic() {
  void Haptics.selectionAsync();
}

/**
 * A list (spec 4.1), the List tab's root: the green header with the list's name, which opens the
 * Your lists sheet, then its rows and the add bar.
 */
export function ListScreen({ id }: { id: string }) {
  const { colors, aisles, spacing, sizes, rounded, opacity, scheme } = useTheme();
  const t = useT();
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
    checkHaptic();
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
  const { data: storedCategoryRows } = useLiveQueryOn(
    categoriesQuery(userId ?? '', householdId),
    [categories, userCategoryOrder],
    [userId, householdId],
  );
  // System aisles named in the app's language (spec 4.15).
  const categoryRows = useMemo(() => withAisleNames(storedCategoryRows), [storedCategoryRows]);
  const orderedCategories = useMemo(() => orderCategories(categoryRows), [categoryRows]);
  const sections = useMemo(() => groupByCategory(orderedCategories, placed), [orderedCategories, placed]);

  // Spec 4.1: the screen stays on while shopping this list and something on it is still to get.
  useKeepListAwake(id, shoppingOnList(pathname, id) && unchecked.length > 0);
  // Spec 4.1: by the same rule, leaving the list moves its last-seen marker. What others added since it
  // shows as a card and NEW rows for this visit.
  const { news, dismissed: newsDismissed, dismiss: dismissNews } = useListVisitNews(id, shoppingOnList(pathname, id));
  const memberNames = useMemberNames(list?.householdId);
  // Spec 4.1: another member's add arriving while the list is on screen (in the foreground) gets a cue.
  const foreground = useForeground();
  const watching = shoppingOnList(pathname, id) && foreground;
  const allItems = useMemo(() => [...unchecked, ...checked], [unchecked, checked]);
  const arrivals = useListArrivals(id, allItems, watching, userId);
  useArrivalAnnouncements(arrivals.latest, watching, memberNames, userId);

  // Spec 4.1: the next cold launch opens the list that last gained focus; 4.10: so does the share sheet.
  useFocusEffect(useCallback(() => recordListOpened(id, userId), [id, userId]));

  // Spec 4.6: Checked opens by itself once nothing is left to get (the last check's linger is the pause
  // before it does), or always with Always show checked items on; a tap on its header overrides either.
  const allDone = placed.length === 0;
  const [checkedChoice, setCheckedChoice] = useState<boolean | null>(null);
  const [wasAllDone, setWasAllDone] = useState(allDone);
  if (wasAllDone !== allDone) {
    setWasAllDone(allDone);
    setCheckedChoice(checkedChoiceAfterAllDoneChange);
  }
  const [selection, setSelection] = useState<Set<string> | null>(null);
  // Spec 4.6: the last choice per list is remembered on this device.
  const [viewMode, setViewModeState] = useState<ListViewMode>(() => getDeviceSetting(viewModeKey(id), DEFAULT_LIST_VIEW_MODE));
  const setViewMode = (mode: ListViewMode) => {
    setViewModeState(mode);
    setDeviceSetting(viewModeKey(id), mode);
  };
  // Spec 4.6: the order dragged in As added, saved per list on this device; this state mirrors it.
  const [manualOrder, setManualOrder] = useState(() => getManualOrder(id));
  // While a row is lifted the list doesn't scroll under the finger.
  const [dragging, setDragging] = useState(false);
  // Settings > Aisle colours: By aisle tints each row (the default) or only the aisle's header. Read on
  // focus, since it's changed on the Settings tab.
  const [aisleColors, setAisleColors] = useState(getAisleColorStyle);
  // Settings > Aisle colours > Item rows: colour bands (the default) or white rows.
  const [rowStyle, setRowStyle] = useState(getItemRowStyle);
  // Settings > Shopping > Always show checked items.
  const [alwaysShowChecked, setAlwaysShowChecked] = useState(getAlwaysShowChecked);
  useFocusEffect(
    useCallback(() => {
      setAisleColors(getAisleColorStyle());
      setRowStyle(getItemRowStyle());
      setAlwaysShowChecked(getAlwaysShowChecked());
    }, []),
  );
  const showChecked = checkedSectionOpen(checkedChoice, allDone, alwaysShowChecked);
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
  // An animated ref, so a drag in As added can scroll the list from the UI thread.
  const listRef = useAnimatedRef<FlatList<Block>>();

  // Add mode: while the add field is focused the big title and view button collapse into the native header,
  // and items matching the typed text are marked "already on list".
  const [adding, setAdding] = useState(false);
  const [addText, setAddText] = useState('');
  const addMode = adding && !selection;
  const query = addMode ? duplicateQuery(addText) : null;
  // Spec 4.1: "Alex is adding". This user counts as adding while the add field is focused and for 10 s
  // after their last add; the header shows the other members who are.
  const { adding: addingNow, noteAdd } = useAddingTail(adding);
  const othersAdding = useListPresence(id, watching, userId, addingNow);
  // Its family key (spec 4.15), so `pepino` marks Cucumber too, when the household combines languages.
  const { data: combineRows } = useLiveQueryOn(combineLanguagesQuery(householdId), [households], [householdId]);
  const combine = combineRows[0]?.on ?? false;
  const queryFamily = useMemo(() => (query === null || !combine ? null : localFamilyKey(db, query)), [query, combine]);
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
  }, [addMode, listRef]);
  // Select mode swaps the add bar out, and it comes back empty.
  const startSelecting = (ids: string[]) => {
    setAdding(false);
    setAddText('');
    setSelection(new Set(ids));
  };

  const blocks = useMemo<Block[]>(() => {
    const out: Block[] =
      viewMode === 'newest'
        ? // As added: one card, no header, latest add at the top, then the rows the user dragged in their order;
          // each row shows its aisle's dot.
          placed.length > 0
          ? [
              {
                kind: 'newest',
                key: 'newest',
                entries: applyManualOrder(orderByNewest(placed), manualOrder).map((item) => ({ key: item.id, item })),
              },
            ]
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
  }, [viewMode, sections, orderedCategories, placed, shownChecked, showChecked, slugById, collapsedSaved, manualOrder]);

  // The sections Collapse all and Expand all work on: every header in this view (Sorting… has none).
  const sectionMode: SectionedViewMode | null = viewMode === 'newest' ? null : viewMode;
  const foldableKeys = blocks.flatMap((b) => ((b.kind === 'aisle' && !b.sorting) || b.kind === 'recipe' ? [b.key] : []));
  const foldedCount = sectionMode ? collapsedShowing(collapsedSaved[sectionMode], foldableKeys).size : 0;
  // Collapse all / Expand all in the ⋯ menu: only in a view that has sections to fold.
  const fold =
    sectionMode && foldableKeys.length > 0
      ? {
          canCollapse: foldedCount < foldableKeys.length,
          canExpand: foldedCount > 0,
          onCollapseAll: () => saveCollapsed(sectionMode, foldableKeys),
          onExpandAll: () => saveCollapsed(sectionMode, []),
        }
      : null;

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

  // Arrived rows out of sight (spec 4.1): each row's view, measured against the list's, puts the ones
  // still unseen in the pill above the add bar. A row that isn't drawn (a folded section, or far off) is
  // out of sight too.
  const viewportRef = useRef<View>(null);
  const arrivalNodes = useRef(new Map<string, View>());
  const arrivalRefs = useRef(new Map<string, (node: View | null) => void>());
  const arrivalRefFor = (itemId: string) => {
    let ref = arrivalRefs.current.get(itemId);
    if (!ref) {
      ref = (node) => (node ? arrivalNodes.current.set(itemId, node) : arrivalNodes.current.delete(itemId));
      arrivalRefs.current.set(itemId, ref);
    }
    return ref;
  };
  const [outOfSight, setOutOfSight] = useState<ReadonlySet<string>>(new Set());
  const unseenRef = useRef(arrivals.unseen);
  const { markSeen } = arrivals;
  const checkSeen = useCallback(() => {
    const ids = [...unseenRef.current.keys()];
    const viewport = viewportRef.current;
    if (ids.length === 0 || !viewport) return;
    viewport.measureInWindow((_x, top, _width, height) => {
      const seen: string[] = [];
      const out = new Set<string>();
      let left = ids.length;
      const done = () => {
        if (--left > 0) return;
        markSeen(seen);
        setOutOfSight((prev) => (prev.size === out.size && [...out].every((v) => prev.has(v)) ? prev : out));
      };
      for (const itemId of ids) {
        const node = arrivalNodes.current.get(itemId);
        if (!node) {
          out.add(itemId);
          done();
          continue;
        }
        node.measureInWindow((_rx, y, _rw, rowHeight) => {
          if (inSight({ y, height: rowHeight }, { y: top, height })) seen.push(itemId);
          else out.add(itemId);
          done();
        });
      }
    });
  }, [markSeen]);
  useEffect(() => {
    unseenRef.current = arrivals.unseen;
    checkSeen();
  }, [arrivals.unseen, checkSeen]);
  const pillIds = [...arrivals.unseen.keys()].filter((itemId) => outOfSight.has(itemId));
  const pillText = arrivalPillText(
    pillIds.map((itemId) => arrivals.unseen.get(itemId)!),
    memberNames,
    userId,
  );
  // The pill scrolls to the first of its rows, in the order the list shows them.
  const showFirstArrival = () => {
    const blockIndex = blocks.findIndex((b) => b.entries.some((e) => pillIds.includes(e.item.id)));
    if (blockIndex === -1) return;
    const itemId = blocks[blockIndex].entries.find((e) => pillIds.includes(e.item.id))!.item.id;
    const node = arrivalNodes.current.get(itemId);
    const viewport = viewportRef.current;
    if (!node || !viewport) {
      openSectionOf(itemId);
      listRef.current?.scrollToIndex({ index: blockIndex, animated: true, viewPosition: 0.5 });
      return;
    }
    viewport.measureInWindow((_x, top, _width, height) =>
      node.measureInWindow((_rx, y, _rw, rowHeight) =>
        listRef.current?.scrollToOffset({
          offset: Math.max(0, scrollOffset.current + y - top - (height - rowHeight) / 2),
          animated: true,
        }),
      ),
    );
  };

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
  }, [blocks, openSectionOf, listRef]);

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
            actions: [{ label: t('common.undo'), onPress: () => (undoMove(moved), setToast(null)) }],
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
            actions: [{ label: t('common.undo'), onPress: () => (undoRecipeAdd(result), setToast(null)) }],
          });
          return;
        }
        if (result.kind === 'imported') {
          // A recipe imported from a link (spec 4.10): Undo takes back the adds (and a recipe it created).
          setToast({
            key: `import-${result.recipeId}-${Date.now()}`,
            ...importedToast(result.recipeName, result.count),
            actions: [
              { label: t('common.undo'), onPress: () => (result.undo(), setToast(null)) },
              {
                label: t('common.viewRecipe'),
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
              ...(result.created ? [{ label: t('common.undo'), onPress: () => (result.undo(), setToast(null)) }] : []),
              {
                label: t('common.viewRecipe'),
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
              label: t('common.viewRecipe'),
              onPress: () => (setToast(null), router.push({ pathname: '/recipe/[id]', params: { id: result.recipeId } })),
            },
          ],
        });
      };
      show();
      return onRecipeAddResult(show);
    }, [id, openSectionOf, t]),
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
              { label: t('common.undo'), onPress: () => (result.undo(), setToast(null)) },
              {
                label: t('common.viewRecipe'),
                onPress: () => (setToast(null), router.push({ pathname: '/recipe/[id]', params: { id: result.recipeId } })),
              },
            ],
          });
        }),
      [t],
    ),
  );

  // Spec 4.6: Check all on a section (its header's swipe right, a recipe's menu), with Undo.
  const checkAll = (itemIds: string[]) => {
    const checked = checkItems(itemIds, userId);
    if (checked.ids.length === 0) return;
    checkHaptic();
    setToast({
      key: `checked-${checked.checkedAt.getTime()}`,
      ...checkedAllToast(checked.ids.length),
      actions: [{ label: t('common.undo'), onPress: () => (uncheckItems(checked), setToast(null)) }],
    });
  };

  // Spec 4.6: Remove recipe from list (its header's swipe left, its menu), with Undo.
  const removeRecipe = (recipeId: string, recipeName: string) => {
    const removed = removeRecipeFromList(id, recipeId);
    if (removed.contributionIds.length === 0) return;
    setToast({
      key: `removed-${recipeId}-${removed.deletedAt.getTime()}`,
      ...removedRecipeToast(recipeName),
      actions: [{ label: t('common.undo'), onPress: () => (restoreRecipeOnList(removed), setToast(null)) }],
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
      { label: t('lists.sections.checkAll'), onPress: () => checkAll(block.itemIds) },
      ...(link ? [{ label: t('lists.sections.visitRecipe'), onPress: () => void openRecipeLink(link) }] : []),
      { label: t('lists.sections.removeRecipe'), destructive: true, onPress: () => removeRecipe(recipeId, block.title) },
    ];
  };

  const recipeMenu = (block: Extract<Block, { kind: 'recipe' }>) => {
    const actions = recipeActions(block);
    if (actions.length === 0) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: block.title,
        options: [...actions.map((a) => a.label), t('common.cancel')],
        destructiveButtonIndex: actions.findIndex((a) => a.destructive),
        cancelButtonIndex: actions.length,
      },
      (index) => actions[index]?.onPress(),
    );
  };

  const add = (value: string) => {
    const result = addItem(id, value, userId);
    if (result) {
      noteAdd();
      void categorizePending(result.pendingNames);
    }
    // In As added a new or re-added item lands at the top, so bring the top into view; elsewhere, its section.
    if (viewMode === 'newest' && result && result.kind !== 'combine') listRef.current?.scrollToOffset({ offset: 0, animated: true });
    if (viewMode !== 'newest' && result) revealRef.current = result.itemId;
    if (result?.kind !== 'combine') return;
    // Spec 4.4: Combine without a prompt, tint the row, and offer Undo.
    setToast({
      key: result.contributionId,
      ...addedToast(result.existingName ?? value.trim(), result.totalAmountText),
      itemId: result.itemId,
      actions: [{ label: t('common.undo'), onPress: () => (undoAdd(result), setToast(null)) }],
    });
  };

  // Spec 4.2: a recipe picked in the add bar adds all its ingredients at 1× (Combine as 4.4 bulk add), with Undo,
  // and Adjust, which opens the recipe's add sheet; adding from there replaces this add. The household's staples
  // (Always have, 4.5) are left out and named; when that's all of them, nothing is added and only Adjust is offered.
  const addRecipe = (recipe: RecipeSuggestion) => {
    const added = addWholeRecipeToList(id, recipe.id, userId);
    if (!added) return;
    noteAdd();
    void categorizePending(added.pendingNames);
    if (viewMode === 'newest' && added.count > 0) listRef.current?.scrollToOffset({ offset: 0, animated: true });
    setToast({
      key: `recipe-add-${recipe.id}-${Date.now()}`,
      ...addedRecipeWithStaplesToast(added.recipeName, added.count, added.skipped),
      actions: [
        ...(added.count === 0 && added.skipped.length > 0
          ? []
          : [{ label: t('common.undo'), onPress: () => (undoRecipeAdd(added), setToast(null)) }]),
        {
          label: t('lists.toasts.adjust'),
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
      actions: [{ label: t('common.undo'), onPress: () => (undeleteItem(item.id), setToast(null)) }],
    });
  }, [t]);

  // Spec 4.1, 4.6: no confirmation; the toast's Undo brings exactly those items back.
  const clear = useCallback(() => {
    const cleared = clearChecked(id);
    if (cleared.ids.length === 0) return;
    setToast({
      key: `cleared-${cleared.deletedAt.getTime()}`,
      ...clearedToast(cleared.ids.length),
      actions: [{ label: t('common.undo'), onPress: () => (restoreItems(cleared.ids, cleared.deletedAt), setToast(null)) }],
    });
  }, [id, t]);

  // Spec 4.6: no confirmation either; Undo checks those items again as they were.
  const uncheck = useCallback(() => {
    const unchecked = uncheckAll(id);
    if (unchecked.length === 0) return;
    setToast({
      key: `unchecked-${unchecked[0].id}-${Date.now()}`,
      ...uncheckedAllToast(unchecked.length),
      actions: [{ label: t('common.undo'), onPress: () => (recheckItems(unchecked), setToast(null)) }],
    });
  }, [id, t]);

  const checkedMenu = (count: number) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    ActionSheetIOS.showActionSheetWithOptions(
      { options: [clearCheckedLabel(count), t('lists.checked.uncheckAll'), t('common.cancel')], destructiveButtonIndex: 0, cancelButtonIndex: 2 },
      (index) => {
        if (index === 0) clear();
        if (index === 1) uncheck();
      },
    );
  };

  const dismissToast = useCallback(() => setToast(null), []);

  // Spec 4.6: rows move by drag (and VoiceOver's Move up / Move down) in As added only, outside Select mode
  // and add mode. Each move saves the whole order on screen.
  const canReorder = viewMode === 'newest' && !selection && !addMode;
  const moveInAsAdded = (ids: readonly string[], from: number, to: number) => {
    setManualOrder(saveManualOrder(id, moveId(ids, from, to), [...unchecked, ...checked]));
  };
  const moveActions = (ids: readonly string[], index: number, item: ItemView): RowMove[] =>
    aisleRowActions(index, ids.length).map((action) => ({
      ...action,
      onPress: () => {
        const to = action.name === 'moveUp' ? index - 1 : index + 1;
        moveInAsAdded(ids, index, to);
        AccessibilityInfo.announceForAccessibility(aisleRowLabel(displayItemName(item.displayName), to, ids.length));
      },
    }));
  // Back to plain As added, no confirm; Undo puts the saved order back.
  const resetOrder = () => {
    const previous = getManualOrder(id);
    clearManualOrder(id);
    setManualOrder([]);
    setToast({
      key: `order-reset-${Date.now()}`,
      message: t('lists.toasts.orderReset'),
      actions: [
        {
          label: t('common.undo'),
          onPress: () => (setDeviceSetting(manualOrderKey(id), previous), setManualOrder(previous), setToast(null)),
        },
      ],
    });
  };

  const renderEntry = (
    entry: Entry,
    index: number,
    background: string,
    sorting = false,
    aisle?: { name: string },
    plain = false,
    moves?: RowMove[],
  ) => {
    const item = itemById.get(entry.item.id) ?? entry.item;
    const match = alreadyOnListMatch(item, query, queryFamily);
    // Spec 4.1: an add by another member that arrived during this visit; its tag until the list scrolls.
    const cue = item.checkedAt === null ? arrivals.cues.get(item.id) : undefined;
    const tagged = cue ? arrivals.tags.get(item.id) : undefined;
    return (
      <ItemRow
        key={entry.key}
        item={item}
        background={background}
        tint={entry.item.id === highlightedId ? aisles[aisleColor(slugById.get(entry.item.categoryId))].soft : undefined}
        // Unchecked rows take their aisle's tint (grey while Sorting…); checked ones stay plain so they recede,
        // as do rows under a coloured aisle header.
        look={item.checkedAt === null && !plain ? categoryColors(slugById.get(entry.item.categoryId), scheme, rowStyle) : undefined}
        alreadyOnList={match === null ? undefined : { query: match }}
        first={index === 0}
        sorting={sorting}
        amountText={entry.amountText}
        hint={entry.hint}
        // Spec 4.1: another member's add since the list was last seen, until it leaves the screen.
        news={item.checkedAt === null ? rowNews(news, item.id, memberNames, userId) : undefined}
        arrival={cue ? { key: cue.contributionId, grow: cue.grow } : undefined}
        tag={tagged ? arrivalTag(nameOf(memberNames, tagged.userId, userId), tagged.userId) : undefined}
        arrivalRef={cue ? arrivalRefFor(item.id) : undefined}
        onArrivalLayout={cue ? checkSeen : undefined}
        aisle={aisle}
        selected={selection ? selection.has(entry.item.id) : undefined}
        onToggle={() => (selection ? setSelection(toggleIn(selection, entry.item.id)) : toggleChecked(item))}
        onDelete={() => remove(entry.item)}
        onEdit={() => router.push({ pathname: '/list/[id]/item/[itemId]', params: { id, itemId: entry.item.id } })}
        onSelect={selection ? undefined : () => startSelecting([entry.item.id])}
        reorderable={moves !== undefined}
        moves={moves}
      />
    );
  };

  // As added and By recipe mix aisles in one card: each row's tint shows its aisle, and VoiceOver reads its name.
  // `moves`: an As added row that can be dragged.
  const renderEntryWithAisle = (e: Entry, i: number, moves?: RowMove[]) => {
    const categoryId = e.item.categoryId;
    return renderEntry(e, i, colors.surface, categoryId === SORTING_CATEGORY_ID, { name: nameById.get(categoryId) ?? '' }, false, moves);
  };

  const renderBlock = (block: Block) => {
    if (block.kind === 'newest') {
      const ids = block.entries.map((e) => e.item.id);
      // A checked row lingering in place doesn't move.
      const movable = (e: Entry) => canReorder && (itemById.get(e.item.id) ?? e.item).checkedAt === null;
      return (
        <Card>
          <ReorderableRows
            scrollRef={listRef}
            rows={block.entries.map((e, i) => ({
              id: e.item.id,
              draggable: movable(e),
              node: renderEntryWithAisle(e, i, movable(e) ? moveActions(ids, i, e.item) : undefined),
            }))}
            onMove={(from, to) => moveInAsAdded(ids, from, to)}
            onSelect={(itemId) => startSelecting([itemId])}
            onDragChange={setDragging}
          />
        </Card>
      );
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
      const plain = aisleColors === 'header';
      return (
        <Card>
          <FoldingSection
            title={block.title}
            accessibilityLabel={block.accessibilityLabel}
            dotColor={aisles[aisleColor(block.slug)].dot}
            band={plain ? aisleHeaderBand(block.slug, scheme) : undefined}
            count={block.entries.length}
            collapsed={block.collapsed}
            onToggle={() => toggleSection('category', block.key)}
            // Spec 4.6: swipe right to check the aisle off; no swipe to delete. VoiceOver gets it as an action.
            onSwipeCheck={selection ? undefined : () => checkAll(block.entries.map((e) => e.item.id))}
            actions={selection ? undefined : [{ label: t('lists.sections.checkAll'), onPress: () => checkAll(block.entries.map((e) => e.item.id)) }]}>
            {block.entries.map((e, i) => renderEntry(e, i, colors.surface, false, undefined, plain))}
          </FoldingSection>
        </Card>
      );
    }
    if (block.kind === 'recipe') {
      const recipeId = block.recipeId;
      return (
        <Card>
          <FoldingSection
            title={block.title}
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
            {block.entries.map((e, i) => renderEntryWithAisle(e, i))}
          </FoldingSection>
        </Card>
      );
    }
    return (
      <View>
        {/* "Checked · 2" folds the section; Uncheck all and Clear sit at its trailing end (the long-press
            menu offers the same). */}
        <View style={[styles.row, { paddingRight: spacing.lg, gap: spacing.sm }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showChecked }}
            accessibilityLabel={checkedHeaderLabel(block.count)}
            onPress={() => setCheckedChoice(!showChecked)}
            onLongPress={() => checkedMenu(block.count)}
            style={({ pressed }) => [
              styles.row,
              styles.flex,
              {
                minHeight: sizes.minTapTarget,
                paddingLeft: spacing.lg + spacing.xs,
                gap: spacing.sm,
                opacity: pressed ? opacity.pressed : 1,
              },
            ]}>
            <ThemedText variant="sectionLabel" color="inkSecondary" numberOfLines={1} style={styles.shrink}>
              {t('lists.checked.header', { count: block.count })}
            </ThemedText>
            <Icon name={showChecked ? 'chevron.down' : 'chevron.right'} color="inkSecondary" size={sizes.iconSmall} />
          </Pressable>
          <Button label={t('lists.checked.uncheckAll')} variant="plain" onPress={uncheck} />
          <Button label={t('lists.checked.clear')} accessibilityLabel={clearCheckedLabel(block.count)} variant="plain" onPress={clear} />
        </View>
        {block.entries.length > 0 ? (
          <Card>{block.entries.map((e, i) => renderEntry(e, i, colors.surface))}</Card>
        ) : null}
      </View>
    );
  };

  // Loading (a few ms), or just deleted on the way back.
  if (!list) return <Screen />;

  return (
    <Screen>
      <Stack.Screen options={{ headerStyle: { backgroundColor: header.ground }, headerTintColor: header.title }} />
      {onThisList ? <StatusBar style="light" /> : null}
      {addMode ? (
        <Stack.Title asChild>
          <CompactTitle name={list.name} subtitle={compactHeaderSubtitle(unchecked.length, viewMode, checked.length)} />
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
            {t('common.done')}
          </Stack.Toolbar.Button>
        ) : null}
        {/* A white wash, as the view pill, with a white ⋯. */}
        <Stack.Toolbar.Menu
          icon="ellipsis"
          variant="prominent"
          tintColor={header.viewButton.fill}
          accessibilityLabel={t('lists.screen.listActions')}
          hidden={!!selection}>
          {/* Inline groups, so the native menu draws a divider between them. */}
          <Stack.Toolbar.Menu inline>
            <Stack.Toolbar.MenuAction icon="checkmark.circle" disabled={unchecked.length === 0} onPress={() => startSelecting([])}>
              {t('lists.screen.selectItems')}
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="square.and.arrow.up" onPress={() => Share.share({ message: listShareText(list.name, unchecked) })}>
              {t('lists.screen.shareList')}
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
          {fold ? (
            <Stack.Toolbar.Menu inline>
              <Stack.Toolbar.MenuAction icon="rectangle.compress.vertical" disabled={!fold.canCollapse} onPress={fold.onCollapseAll}>
                {t('lists.viewModes.collapseAll')}
              </Stack.Toolbar.MenuAction>
              <Stack.Toolbar.MenuAction icon="rectangle.expand.vertical" disabled={!fold.canExpand} onPress={fold.onExpandAll}>
                {t('lists.viewModes.expandAll')}
              </Stack.Toolbar.MenuAction>
            </Stack.Toolbar.Menu>
          ) : null}
          <Stack.Toolbar.Menu inline>
            <Stack.Toolbar.MenuAction icon="pencil" onPress={() => router.push({ pathname: '/list/[id]/edit', params: { id } })}>
              {t('lists.screen.editList')}
            </Stack.Toolbar.MenuAction>
            {/* By aisle: a way to the aisle order (also in Settings). */}
            {viewMode === 'category' ? (
              <Stack.Toolbar.MenuAction icon="arrow.up.arrow.down" onPress={() => router.push('/category-order')}>
                {t('lists.screen.reorderAisles')}
              </Stack.Toolbar.MenuAction>
            ) : null}
          </Stack.Toolbar.Menu>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={headerHeight}>
        <View ref={viewportRef} testID="list-viewport" style={styles.flex}>
          <FlatList
            ref={listRef}
            scrollEnabled={!dragging}
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
                      {toGetLabel(unchecked.length, checked.length) ? (
                        <ThemedText variant="amount" color="onHeaderSecondary">
                          {toGetLabel(unchecked.length, checked.length)}
                        </ThemedText>
                      ) : null}
                      <ViewMenuButton
                        value={viewMode}
                        onChange={setViewMode}
                        onResetOrder={viewMode === 'newest' && manualOrder.length > 0 ? resetOrder : undefined}
                      />
                    </View>
                    {/* Spec 4.1: "Alex is adding", under the count and view; gone with the header in add mode. */}
                    <AddingPill
                      userIds={othersAdding}
                      hidden={addMode}
                      names={memberNames}
                      currentUserId={userId}
                      style={{ marginBottom: spacing.md, marginHorizontal: spacing.lg + spacing.xs }}
                    />
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
                {/* Spec 4.1: "since you looked", above the first section in every view, until ✕. */}
                {news && !newsDismissed ? (
                  <View style={{ paddingBottom: spacing.sm + spacing.xxs }}>
                    <NewsCard news={news} names={newsNames(news, memberNames, userId)} onDismiss={dismissNews} />
                  </View>
                ) : null}
              </View>
            }
            ItemSeparatorComponent={() => <View style={{ height: spacing.sm + spacing.xxs }} />}
            // Add mode: scrolling or checking off rows keeps the keyboard up.
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="none"
            onScroll={(e) => {
              scrollOffset.current = e.nativeEvent.contentOffset.y;
              checkSeen();
            }}
            // Spec 4.1: scrolling the list takes arrived rows' name tags off.
            onScrollBeginDrag={arrivals.clearTags}
            scrollEventThrottle={16}
            contentContainerStyle={blocks.length === 0 ? styles.flex : { paddingBottom: spacing.lg }}
            ListEmptyComponent={<EmptyState message={t('lists.screen.empty')} />}
            renderItem={({ item: block }) => renderBlock(block)}
            onScrollToIndexFailed={({ index, averageItemLength }) =>
              listRef.current?.scrollToOffset({ offset: index * averageItemLength, animated: true })
            }
          />
          {/* Spec 4.1: arrivals out of sight, 8 pt above the add bar (or the toast). */}
          {pillText ? (
            <View pointerEvents="box-none" style={[styles.pillSlot, { bottom: spacing.sm }]}>
              <ArrivalPill label={pillText} onPress={showFirstArrival} />
            </View>
          ) : null}
        </View>

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
 * The list's name with a small chevron after it: one button that opens the Your lists sheet (spec 4.1,
 * board E). A long name truncates so the chevron, and ⋯ beside it, stay in view. A dot on the chevron
 * while an invite is waiting, which the sheet shows.
 */
function SwitcherTitle({ name, invites }: { name: string; invites: number }) {
  const { colors, aisles, spacing, sizes, rounded, opacity } = useTheme();
  const t = useT();
  const look = listHeaderColors(colors);
  const { width } = useWindowDimensions();
  // Leaves room for the bar's two 16 pt margins, ⋯ and a gap before it. The bar's margin is 4 pt short of
  // the sheet's 20 pt gutter, so the name is padded over to line up with "N to get".
  const maxWidth = width - spacing.lg * 2 - sizes.minTapTarget - spacing.md;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={switcherAccessibilityLabel(name, invites)}
      accessibilityHint={t('lists.screen.switchListHint')}
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
  const t = useT();
  const { reduceMotion } = useMotion();
  return (
    <Animated.View entering={(reduceMotion ? FadeIn : FadeInDown).duration(Motion.duration)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('lists.screen.compactTitle', { name, subtitle })}
        accessibilityHint={t('lists.screen.compactTitleHint')}
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

/**
 * "2 new from Alex ↓" (spec 4.1): rows another member added that landed out of sight. Tapping it
 * scrolls to the first of them.
 */
function ArrivalPill({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const t = useT();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={t('lists.arrivals.pillHint')}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: sizes.pill,
          paddingHorizontal: spacing.lg,
          gap: spacing.xs + spacing.xxs,
          borderRadius: rounded.full,
          backgroundColor: colors.primary,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <ThemedText variant="headline" color="onPrimary">
        {label}
      </ThemedText>
      <Icon name="arrow.down" color="onPrimary" size={sizes.iconSmall} weight="bold" />
    </Pressable>
  );
}

/** An arrived row's name tag: the member's short name, its initial, and their avatar's hue. */
function arrivalTag(name: string, userId: string) {
  return { name, initial: avatarInitial(name), hue: memberHue(userId) };
}

function toggleIn(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function SelectionBar({ count, onAddToRecipe }: { count: number; onAddToRecipe: () => void }) {
  const { colors, spacing } = useTheme();
  const t = useT();
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
        {count === 0 ? t('lists.select.tapToSelect') : t('lists.select.selected', { count })}
      </ThemedText>
      <PrimaryButton label={t('lists.select.addToRecipe')}disabled={count === 0} onPress={onAddToRecipe} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  center: { justifyContent: 'center' },
  title: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  switcher: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
  shrink: { flexShrink: 1 },
  inviteDot: { position: 'absolute' },
  compactTitle: { alignItems: 'center', justifyContent: 'center' },
  // Clips the title while its height closes; the scale shrinks it toward its top.
  collapsing: { overflow: 'hidden', transformOrigin: 'top' },
  measured: { position: 'absolute', top: 0, left: 0, right: 0 },
  overscroll: { position: 'absolute', left: 0, right: 0, bottom: '100%', height: 1000 },
  sheetTop: { overflow: 'hidden', borderCurve: 'continuous' },
  pillSlot: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
});
