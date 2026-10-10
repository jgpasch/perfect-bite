import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActionSheetIOS, Alert, FlatList, KeyboardAvoidingView, Pressable, Share, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { prominentButtonTint } from '@/components/appearance';
import { Button, PrimaryButton } from '@/components/button';
import { Card } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { Icon } from '@/components/icon';
import { IconTile } from '@/components/icon-tile';
import { SectionHeader } from '@/components/section-header';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { SegmentedControl } from '@/components/segmented-control';
import { Toast, type ToastAction } from '@/components/toast';
import { categories, lists, userCategoryOrder } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { aisleColor, recipeHue } from '@/domain/aisle-color';
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
  setItemChecked,
  uncheckAll,
  undeleteItem,
  undoAdd,
  USUAL_UNITS_QUERY_TABLES,
  usualUnitsQuery,
  type ItemView,
} from '@/features/lists/items';
import {
  addedToast,
  alsoInHint,
  DEFAULT_LIST_VIEW_MODE,
  LIST_VIEW_MODES,
  orderByNewest,
  toGetLabel,
  viewModeKey,
  type ListViewMode,
} from '@/features/lists/list-view';
import { deleteList, listQuery, setDefaultList, setLastOpenedList } from '@/features/lists/lists';
import { promptListName } from '@/features/lists/prompt-list-name';
import { listShareText } from '@/features/lists/share';
import { categorizePending } from '@/features/categories/categorization';
import { addItemsToRecipe, makeRecipeFromItems } from '@/features/recipes/from-list';
import { recipesQuery } from '@/features/recipes/recipes';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { useTheme } from '@/hooks/use-theme';

type Entry = { key: string; item: ItemView; amountText?: string; hint?: string };

/** One card each (the Checked header sits above its card). */
type Block =
  | { kind: 'newest'; key: string; entries: Entry[] }
  | { kind: 'aisle'; key: string; title: string; accessibilityLabel: string; slug: string | null; sorting: boolean; entries: Entry[] }
  | { kind: 'recipe'; key: string; title: string; recipeId: string | null; itemIds: string[]; entries: Entry[] }
  | { kind: 'checked'; key: string; count: number; entries: Entry[] };

export default function ListScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, aisles, spacing, sizes, opacity, scheme } = useTheme();
  const headerHeight = useHeaderHeight();
  const userId = getAccount()?.userId ?? null;

  const { data: listRows } = useLiveQueryOn(listQuery(id), [lists], [id]);
  const list = listRows[0];
  const { data: itemRows } = useLiveQueryOn(listItemsQuery(id, userId), LIST_ITEMS_QUERY_TABLES, [id, userId]);
  const { data: unitRows } = useLiveQueryOn(usualUnitsQuery(id), USUAL_UNITS_QUERY_TABLES, [id]);
  const usualUnits = useMemo(() => usualUnitsByKey(unitRows), [unitRows]);
  const { unchecked, checked } = useMemo(() => groupItems(itemRows, usualUnits), [itemRows, usualUnits]);
  const { data: categoryRows } = useLiveQueryOn(categoriesQuery(userId ?? ''), [categories, userCategoryOrder], [userId]);
  const orderedCategories = useMemo(() => orderCategories(categoryRows), [categoryRows]);
  const sections = useMemo(() => groupByCategory(orderedCategories, unchecked), [orderedCategories, unchecked]);

  // Spec 4.1: the next cold launch opens the list that last gained focus.
  useFocusEffect(useCallback(() => setLastOpenedList(id), [id]));

  const [showChecked, setShowChecked] = useState(false);
  const [selection, setSelection] = useState<Set<string> | null>(null);
  // Spec 4.6: the last choice per list is remembered on this device.
  const [viewMode, setViewModeState] = useState<ListViewMode>(() => getDeviceSetting(viewModeKey(id), DEFAULT_LIST_VIEW_MODE));
  const setViewMode = (mode: ListViewMode) => {
    setViewModeState(mode);
    setDeviceSetting(viewModeKey(id), mode);
  };
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

  const blocks = useMemo<Block[]>(() => {
    const out: Block[] =
      viewMode === 'newest'
        ? // Newest: one card, no header, latest add at the top; each row shows its aisle's dot.
          unchecked.length > 0
          ? [{ kind: 'newest', key: 'newest', entries: orderByNewest(unchecked).map((item) => ({ key: item.id, item })) }]
          : []
        : viewMode === 'category'
        ? // By aisle: a card per aisle in the user's order, empty ones hidden, items by when added.
          sections.map(({ category, items }): Block => ({
            kind: 'aisle',
            key: `c-${category.id}`,
            title: category.name,
            accessibilityLabel: sectionAccessibilityLabel(category),
            slug: slugById.get(category.id) ?? null,
            sorting: category.id === SORTING_CATEGORY_ID,
            entries: items.map((item) => ({ key: item.id, item })),
          }))
        : // By recipe: a card per recipe (an item can be under several), then Other items; in each,
          // Sorting… first, then the user's aisle order, then by when added.
          groupByRecipe(orderByAisle(unchecked, orderedCategories)).map(
            (section): Block => ({
              kind: 'recipe',
              key: `r-${section.recipeId ?? 'other'}`,
              title: section.name,
              recipeId: section.recipeId,
              itemIds: section.entries.map((e) => e.item.id),
              entries: section.entries.map((e) => ({
                key: `${section.recipeId ?? 'other'}-${e.item.id}`,
                item: e.item,
                amountText: e.amountText,
                hint: alsoInHint(e.alsoIn),
              })),
            }),
          );
    if (checked.length > 0) {
      out.push({
        kind: 'checked',
        key: 'checked',
        count: checked.length,
        entries: showChecked ? checked.map((item) => ({ key: item.id, item })) : [],
      });
    }
    return out;
  }, [viewMode, sections, orderedCategories, unchecked, checked, showChecked, slugById]);

  // Select mode (spec 4.5): pick items, then Make recipe... or Add to recipe...
  const finishSelection = () => {
    setSelection(null);
    setViewMode('recipe');
  };
  const makeRecipe = () => {
    if (!selection) return;
    const ids = [...selection];
    Alert.prompt('New recipe', `From ${ids.length} ${ids.length === 1 ? 'item' : 'items'}`, (name) => {
      if (!name?.trim()) return;
      void categorizePending(makeRecipeFromItems(name, ids, userId).pendingNames);
      finishSelection();
    });
  };
  const addToRecipe = () => {
    if (!selection) return;
    const ids = [...selection];
    const all = recipesQuery().all();
    if (all.length === 0) return makeRecipe();
    ActionSheetIOS.showActionSheetWithOptions(
      { title: 'Add to recipe', options: [...all.map((r) => r.name), 'Cancel'], cancelButtonIndex: all.length },
      (index) => {
        if (index >= all.length) return;
        void categorizePending(addItemsToRecipe(all[index].id, ids, userId));
        finishSelection();
      },
    );
  };

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
    // In Newest a new or re-added item lands at the top, so bring the top into view.
    if (viewMode === 'newest' && result && result.kind !== 'combine') listRef.current?.scrollToOffset({ offset: 0, animated: true });
    if (result?.kind !== 'combine') return;
    // Spec 4.4: Combine without a prompt, tint the row, and offer Undo.
    setToast({
      key: result.contributionId,
      ...addedToast(result.existingName ?? value.trim(), result.totalAmountText),
      itemId: result.itemId,
      actions: [{ label: 'Undo', onPress: () => (undoAdd(result), setToast(null)) }],
    });
  };

  const remove = useCallback((item: ItemView) => {
    deleteItem(item.id);
    setToast({
      key: `deleted-${item.id}`,
      message: `Deleted ${item.displayName}`,
      emphasis: item.displayName,
      actions: [{ label: 'Undo', onPress: () => (undeleteItem(item.id), setToast(null)) }],
    });
  }, []);

  const dismissToast = useCallback(() => setToast(null), []);

  const renderEntry = (
    entry: Entry,
    index: number,
    background: string,
    sorting = false,
    aisle?: { name: string; dot: string },
  ) => (
    <ItemRow
      key={entry.key}
      item={entry.item}
      background={background}
      tint={entry.item.id === highlightedId ? aisles[aisleColor(slugById.get(entry.item.categoryId))].soft : undefined}
      first={index === 0}
      sorting={sorting}
      amountText={entry.amountText}
      hint={entry.hint}
      aisle={aisle}
      selected={selection ? selection.has(entry.item.id) : undefined}
      onToggle={() =>
        selection
          ? setSelection(toggleIn(selection, entry.item.id))
          : setItemChecked(entry.item.id, entry.item.checkedAt === null, userId)
      }
      onDelete={() => remove(entry.item)}
      onEdit={() => router.push({ pathname: '/list/[id]/item/[itemId]', params: { id, itemId: entry.item.id } })}
    />
  );

  // Newest and By recipe mix aisles in one card, so each row shows its aisle's dot (or Sorting…).
  const renderEntryWithAisle = (e: Entry, i: number) => {
    const categoryId = e.item.categoryId;
    const aisle = { name: nameById.get(categoryId) ?? '', dot: aisles[aisleColor(slugById.get(categoryId))].dot };
    return renderEntry(e, i, colors.surface, categoryId === SORTING_CATEGORY_ID, aisle);
  };

  const renderBlock = (block: Block) => {
    if (block.kind === 'newest') {
      return <Card>{block.entries.map(renderEntryWithAisle)}</Card>;
    }
    if (block.kind === 'aisle') {
      if (block.sorting) {
        // No header: the dashed checks and each row's "Sorting…" label say what this card is.
        return <Card background="pendingSoft">{block.entries.map((e, i) => renderEntry(e, i, colors.pendingSoft, true))}</Card>;
      }
      return (
        <Card>
          <SectionHeader
            title={block.title}
            accessibilityLabel={block.accessibilityLabel}
            dotColor={aisles[aisleColor(block.slug)].dot}
            count={block.entries.length}
          />
          {block.entries.map((e, i) => renderEntry(e, i, colors.surface))}
        </Card>
      );
    }
    if (block.kind === 'recipe') {
      return (
        <Card>
          <SectionHeader
            title={block.title}
            leading={block.recipeId ? <IconTile hue={recipeHue(block.recipeId)} name="fork.knife" /> : undefined}
            trailing={block.recipeId ? <RecipeActionsButton name={block.title} onPress={() => recipeMenu(block)} /> : undefined}
          />
          {block.entries.map(renderEntryWithAisle)}
        </Card>
      );
    }
    return (
      <View>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: showChecked }}
          accessibilityLabel={`Checked, ${block.count} ${block.count === 1 ? 'item' : 'items'}`}
          onPress={() => setShowChecked((v) => !v)}
          style={({ pressed }) => [
            styles.row,
            {
              minHeight: sizes.minTapTarget,
              paddingHorizontal: spacing.lg + spacing.xs,
              gap: spacing.sm,
              opacity: pressed ? opacity.pressed : 1,
            },
          ]}>
          <ThemedText variant="sectionLabel" color="inkSecondary" style={styles.flex}>
            Checked ({block.count})
          </ThemedText>
          <Icon name={showChecked ? 'chevron.down' : 'chevron.right'} color="inkSecondary" size={sizes.iconSmall} />
        </Pressable>
        {block.entries.length > 0 ? <Card>{block.entries.map((e, i) => renderEntry(e, i, colors.surface))}</Card> : null}
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
      <Stack.Toolbar placement="right">
        {selection ? (
          <Stack.Toolbar.Button variant="done" tintColor={prominentButtonTint(scheme, colors)} onPress={() => setSelection(null)}>
            Done
          </Stack.Toolbar.Button>
        ) : null}
        <Stack.Toolbar.Menu icon="ellipsis.circle" accessibilityLabel="List actions" hidden={!!selection}>
          <Stack.Toolbar.MenuAction icon="checkmark.circle" disabled={unchecked.length === 0} onPress={() => setSelection(new Set())}>
            Select items
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="square.and.arrow.up" onPress={() => Share.share({ message: listShareText(list.name, unchecked) })}>
            Share as text
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="arrow.uturn.backward" disabled={checked.length === 0} onPress={() => uncheckAll(id)}>
            Uncheck all
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="xmark.circle" disabled={checked.length === 0} onPress={() => clearChecked(id)}>
            Clear checked items
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="arrow.up.arrow.down" onPress={() => router.push('/category-order')}>
            Reorder sections
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="pencil" onPress={() => promptListName(list.id, list.name)}>
            Rename
          </Stack.Toolbar.MenuAction>
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
            <View style={{ gap: spacing.md, paddingBottom: spacing.md }}>
              <View
                style={[
                  styles.title,
                  { paddingHorizontal: spacing.lg + spacing.xs, paddingTop: spacing.sm, columnGap: spacing.sm + spacing.xxs },
                ]}>
                <ThemedText variant="screenTitle" accessibilityRole="header">
                  {list.name}
                </ThemedText>
                {toGetLabel(unchecked.length) ? (
                  <ThemedText variant="amount" color="inkSecondary">
                    {toGetLabel(unchecked.length)}
                  </ThemedText>
                ) : null}
              </View>
              <SegmentedControl segments={LIST_VIEW_MODES} value={viewMode} onChange={setViewMode} />
            </View>
          }
          ItemSeparatorComponent={() => <View style={{ height: spacing.sm + spacing.xxs }} />}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={blocks.length === 0 ? styles.flex : { paddingBottom: spacing.lg }}
          ListEmptyComponent={<EmptyState message="Nothing on this list yet. Add an item below." />}
          renderItem={({ item: block }) => renderBlock(block)}
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
          <SelectionBar
            count={selection.size}
            onMakeRecipe={makeRecipe}
            onAddToRecipe={addToRecipe}
          />
        ) : (
          <ItemAddBar
            householdId={list.householdId}
            listId={id}
            onAdd={add}
            placeholder="Add an item, like 2 lbs chicken thighs"
            accessibilityLabel="Add an item"
          />
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}

function toggleIn(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function SelectionBar({
  count,
  onMakeRecipe,
  onAddToRecipe,
}: {
  count: number;
  onMakeRecipe: () => void;
  onAddToRecipe: () => void;
}) {
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
      <View style={[styles.row, { gap: spacing.sm }]}>
        <View style={styles.flex}>
          <PrimaryButton label="Make recipe…" disabled={count === 0} onPress={onMakeRecipe} />
        </View>
        <View style={styles.flex}>
          <Button label="Add to recipe…" variant="secondary" disabled={count === 0} onPress={onAddToRecipe} />
        </View>
      </View>
    </View>
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
});
