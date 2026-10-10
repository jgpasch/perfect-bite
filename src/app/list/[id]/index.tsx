import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActionSheetIOS, Alert, FlatList, KeyboardAvoidingView, Pressable, Share, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, PrimaryButton } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { SegmentedControl } from '@/components/segmented-control';
import { Toast, type ToastAction } from '@/components/toast';
import { categories, lists, userCategoryOrder } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { groupByCategory, orderCategories, sectionAccessibilityLabel } from '@/domain/category-resolver';
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
  removeRecipeFromList,
  setItemChecked,
  uncheckAll,
  undeleteItem,
  undoAdd,
  USUAL_UNITS_QUERY_TABLES,
  usualUnitsQuery,
  type ItemView,
} from '@/features/lists/items';
import { deleteList, listQuery, setDefaultList } from '@/features/lists/lists';
import { promptListName } from '@/features/lists/prompt-list-name';
import { listShareText } from '@/features/lists/share';
import { categorizePending } from '@/features/categories/categorization';
import { addItemsToRecipe, makeRecipeFromItems } from '@/features/recipes/from-list';
import { recipesQuery } from '@/features/recipes/recipes';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { useTheme } from '@/hooks/use-theme';

type Row =
  | { kind: 'item'; key: string; item: ItemView; amountText?: string; hint?: string }
  | { kind: 'section'; key: string; name: string; accessibilityLabel?: string; recipeId?: string; itemIds?: string[] }
  | { kind: 'checkedHeader'; key: string; count: number };

type ViewMode = 'category' | 'recipe';
const VIEW_MODES: { value: ViewMode; label: string }[] = [
  { value: 'category', label: 'By category' },
  { value: 'recipe', label: 'By recipe' },
];
const viewModeKey = (listId: string) => `list.${listId}.viewMode`;

export default function ListScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { spacing, sizes, opacity } = useTheme();
  const headerHeight = useHeaderHeight();
  const userId = getAccount()?.userId ?? null;

  const { data: listRows } = useLiveQueryOn(listQuery(id), [lists], [id]);
  const list = listRows[0];
  const { data: itemRows } = useLiveQueryOn(listItemsQuery(id, userId), LIST_ITEMS_QUERY_TABLES, [id, userId]);
  const { data: unitRows } = useLiveQueryOn(usualUnitsQuery(id), USUAL_UNITS_QUERY_TABLES, [id]);
  const usualUnits = useMemo(() => usualUnitsByKey(unitRows), [unitRows]);
  const { unchecked, checked } = useMemo(() => groupItems(itemRows, usualUnits), [itemRows, usualUnits]);
  const { data: categoryRows } = useLiveQueryOn(categoriesQuery(userId ?? ''), [categories, userCategoryOrder], [userId]);
  const sections = useMemo(() => groupByCategory(orderCategories(categoryRows), unchecked), [categoryRows, unchecked]);

  const [showChecked, setShowChecked] = useState(false);
  const [selection, setSelection] = useState<Set<string> | null>(null);
  // Spec 4.6: the last choice per list is remembered on this device.
  const [viewMode, setViewModeState] = useState<ViewMode>(() => getDeviceSetting(viewModeKey(id), 'category'));
  const setViewMode = (mode: ViewMode) => {
    setViewModeState(mode);
    setDeviceSetting(viewModeKey(id), mode);
  };
  const [toast, setToast] = useState<{ key: string; message: string; actions: ToastAction[] } | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] =
      viewMode === 'category'
        ? // By category: sections in the user's order, empty ones hidden, items by when added.
          sections.flatMap(({ category, items }): Row[] => [
            {
              kind: 'section',
              key: `c-${category.id}`,
              name: category.name,
              accessibilityLabel: sectionAccessibilityLabel(category),
            },
            ...items.map((item): Row => ({ kind: 'item', key: item.id, item })),
          ])
        : // By recipe: a section per recipe (an item can be under several), then Other items.
          groupByRecipe(unchecked).flatMap((section): Row[] => [
            {
              kind: 'section',
              key: `r-${section.recipeId ?? 'other'}`,
              name: section.name,
              recipeId: section.recipeId ?? undefined,
              itemIds: section.entries.map((e) => e.item.id),
            },
            ...section.entries.map(
              (e): Row => ({
                kind: 'item',
                key: `${section.recipeId ?? 'other'}-${e.item.id}`,
                item: e.item,
                amountText: e.amountText,
                hint: e.alsoIn.length > 0 ? `also in: ${e.alsoIn.join(', ')}` : undefined,
              }),
            ),
          ]);
    if (checked.length > 0) {
      out.push({ kind: 'checkedHeader', key: 'checked', count: checked.length });
      if (showChecked) out.push(...checked.map((item): Row => ({ kind: 'item', key: item.id, item })));
    }
    return out;
  }, [viewMode, sections, unchecked, checked, showChecked]);

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

  const recipeMenu = (row: Extract<Row, { kind: 'section' }>) => {
    if (!row.recipeId) return;
    const recipeId = row.recipeId;
    ActionSheetIOS.showActionSheetWithOptions(
      { title: row.name, options: ['Check all', 'Remove recipe from list', 'Cancel'], destructiveButtonIndex: 1, cancelButtonIndex: 2 },
      (index) => {
        if (index === 0) checkItems(row.itemIds ?? [], userId);
        if (index === 1) removeRecipeFromList(id, recipeId);
      },
    );
  };

  const add = (value: string) => {
    const result = addItem(id, value, userId);
    if (result) void categorizePending(result.pendingNames);
    if (result?.kind !== 'combine') return;
    // Spec 4.4: Combine without a prompt, highlight the row, and offer Undo.
    setHighlightedId(result.itemId);
    const amount = result.totalAmountText ? ` (now ${result.totalAmountText})` : '';
    setToast({
      key: result.contributionId,
      message: `Added to ${result.existingName}${amount}`,
      actions: [{ label: 'Undo', onPress: () => (undoAdd(result), setToast(null)) }],
    });
  };

  const remove = useCallback((item: ItemView) => {
    deleteItem(item.id);
    setToast({
      key: `deleted-${item.id}`,
      message: `Deleted ${item.displayName}`,
      actions: [{ label: 'Undo', onPress: () => (undeleteItem(item.id), setToast(null)) }],
    });
  }, []);

  const dismissToast = useCallback(() => setToast(null), []);

  useEffect(() => {
    if (!highlightedId) return;
    const timer = setTimeout(() => setHighlightedId(null), 1200);
    return () => clearTimeout(timer);
  }, [highlightedId]);

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
      <Stack.Screen options={{ title: list.name }} />
      <Stack.Toolbar placement="right">
        {selection ? (
          <Stack.Toolbar.Button variant="done" onPress={() => setSelection(null)}>
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
          style={styles.flex}
          data={rows}
          keyExtractor={(row) => row.key}
          ListHeaderComponent={
            <View style={{ marginTop: spacing.sm }}>
              <SegmentedControl
                segments={VIEW_MODES}
                value={viewMode}
                onChange={setViewMode}
              />
            </View>
          }
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={rows.length === 0 ? styles.flex : { paddingBottom: spacing.lg }}
          ListEmptyComponent={<EmptyState message="Nothing on this list yet. Add an item below." />}
          renderItem={({ item: row, index }) =>
            row.kind === 'section' ? (
              <Pressable
                disabled={!row.recipeId}
                onPress={() => recipeMenu(row)}
                accessibilityRole={row.recipeId ? 'button' : 'header'}
                accessibilityLabel={row.accessibilityLabel ?? row.name}
                accessibilityHint={row.recipeId ? 'Shows recipe actions' : undefined}
                style={[
                  styles.checkedHeader,
                  { paddingHorizontal: spacing.lg, paddingTop: index === 0 ? spacing.md : spacing.xl, paddingBottom: spacing.xs, gap: spacing.sm },
                ]}>
                <ThemedText variant="footnote" color="inkSecondary" style={styles.flex}>
                  {row.name}
                </ThemedText>
                {row.recipeId ? <Icon name="ellipsis" color="inkSecondary" size={sizes.icon} /> : null}
              </Pressable>
            ) : row.kind === 'item' ? (
              <ItemRow
                item={row.item}
                amountText={row.amountText}
                hint={row.hint}
                highlighted={row.item.id === highlightedId}
                selected={selection ? selection.has(row.item.id) : undefined}
                onToggle={() =>
                  selection
                    ? setSelection(toggleIn(selection, row.item.id))
                    : setItemChecked(row.item.id, row.item.checkedAt === null, userId)
                }
                onDelete={() => remove(row.item)}
                onEdit={() => router.push({ pathname: '/list/[id]/item/[itemId]', params: { id, itemId: row.item.id } })}
              />
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded: showChecked }}
                accessibilityLabel={`Checked, ${row.count} ${row.count === 1 ? 'item' : 'items'}`}
                onPress={() => setShowChecked((v) => !v)}
                style={({ pressed }) => [
                  styles.checkedHeader,
                  {
                    minHeight: sizes.minTapTarget,
                    paddingHorizontal: spacing.lg,
                    marginTop: spacing.md,
                    gap: spacing.sm,
                    opacity: pressed ? opacity.pressed : 1,
                  },
                ]}>
                <ThemedText variant="footnote" color="inkSecondary" style={styles.flex}>
                  Checked ({row.count})
                </ThemedText>
                <Icon name={showChecked ? 'chevron.down' : 'chevron.right'} color="inkSecondary" size={sizes.iconSmall} />
              </Pressable>
            )
          }
        />

        {toast ? (
          <View style={{ paddingBottom: spacing.sm }}>
            <Toast key={toast.key} message={toast.message} actions={toast.actions} onDismiss={dismissToast} />
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
      <View style={[styles.checkedHeader, { gap: spacing.sm }]}>
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

const styles = StyleSheet.create({
  flex: { flex: 1 },
  checkedHeader: { flexDirection: 'row', alignItems: 'center' },
});
