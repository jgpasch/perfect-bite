import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Keyboard, KeyboardAvoidingView, Pressable, ScrollView, Share, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmptyState } from '@/components/empty-state';
import { Icon } from '@/components/icon';
import { TextField } from '@/components/text-field';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { UndoToast, type ToastAction } from '@/components/undo-toast';
import { categories, lists, userCategoryOrder } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { orderCategories, groupByCategory } from '@/domain/category-resolver';
import { getAccount } from '@/features/auth/account';
import { categoriesQuery } from '@/features/categories/categories';
import { ItemRow } from '@/features/lists/item-row';
import {
  addItem,
  clearChecked,
  deleteItem,
  groupItems,
  keepExisting,
  LIST_ITEMS_QUERY_TABLES,
  listItemsQuery,
  setItemChecked,
  uncheckAll,
  undeleteItem,
  undoAdd,
  type ItemView,
} from '@/features/lists/items';
import { deleteList, listQuery, setDefaultList } from '@/features/lists/lists';
import { promptListName } from '@/features/lists/prompt-list-name';
import { listShareText } from '@/features/lists/share';
import { applySuggestion, getSuggestions } from '@/features/lists/suggestions';
import { useTheme } from '@/hooks/use-theme';

type Row =
  | { kind: 'item'; item: ItemView }
  | { kind: 'section'; id: string; name: string }
  | { kind: 'checkedHeader'; count: number };

export default function ListScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, spacing, sizes, opacity, rounded } = useTheme();
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const userId = getAccount()?.userId ?? null;

  const { data: listRows } = useLiveQueryOn(listQuery(id), [lists], [id]);
  const list = listRows[0];
  const { data: itemRows } = useLiveQueryOn(listItemsQuery(id, userId), LIST_ITEMS_QUERY_TABLES, [id, userId]);
  const { unchecked, checked } = useMemo(() => groupItems(itemRows), [itemRows]);
  const { data: categoryRows } = useLiveQueryOn(categoriesQuery(userId ?? ''), [categories, userCategoryOrder], [userId]);
  const sections = useMemo(() => groupByCategory(orderCategories(categoryRows), unchecked), [categoryRows, unchecked]);

  const [text, setText] = useState('');
  const [showChecked, setShowChecked] = useState(false);
  const [toast, setToast] = useState<{ key: string; message: string; actions: ToastAction[] } | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const keyboardVisible = useKeyboardVisible();

  const rows = useMemo<Row[]>(() => {
    // Spec 4.6, By category: sections in the user's order, empty ones hidden, items by when added.
    const out: Row[] = sections.flatMap(({ category, items }): Row[] => [
      { kind: 'section', id: category.id, name: category.name },
      ...items.map((item): Row => ({ kind: 'item', item })),
    ]);
    if (checked.length > 0) {
      out.push({ kind: 'checkedHeader', count: checked.length });
      if (showChecked) out.push(...checked.map((item): Row => ({ kind: 'item', item })));
    }
    return out;
  }, [sections, checked, showChecked]);

  const suggestions = useMemo(() => (list ? getSuggestions(list.householdId, text) : []), [list, text]);

  const add = (value: string) => {
    if (!value.trim()) return;
    const result = addItem(id, value, userId);
    setText('');
    if (result?.kind !== 'combine') return;
    // Spec 4.4: Combine without a prompt, highlight the row, and offer Undo / Keep existing.
    setHighlightedId(result.itemId);
    const amount = result.existingAmountText ? ` (${result.existingAmountText})` : '';
    setToast({
      key: result.contributionId,
      message: `Combined with ${result.existingName}${amount}`,
      actions: [
        { label: 'Undo', onPress: () => (undoAdd(result), setToast(null)) },
        { label: 'Keep existing', onPress: () => (keepExisting(result.contributionId), setToast(null)) },
      ],
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
        <Stack.Toolbar.Menu icon="ellipsis.circle" accessibilityLabel="List actions">
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
          keyExtractor={(row) => (row.kind === 'item' ? row.item.id : row.kind === 'section' ? `section-${row.id}` : 'checked-header')}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentContainerStyle={rows.length === 0 ? styles.flex : { paddingBottom: spacing.lg }}
          ListEmptyComponent={<EmptyState message="Nothing on this list yet. Add an item below." />}
          renderItem={({ item: row, index }) =>
            row.kind === 'section' ? (
              <ThemedText
                variant="footnote"
                color="inkSecondary"
                accessibilityRole="header"
                style={{ paddingHorizontal: spacing.lg, paddingTop: index === 0 ? spacing.sm : spacing.xl, paddingBottom: spacing.xs }}>
                {row.name}
              </ThemedText>
            ) : row.kind === 'item' ? (
              <ItemRow
                item={row.item}
                highlighted={row.item.id === highlightedId}
                onToggle={() => setItemChecked(row.item.id, row.item.checkedAt === null, userId)}
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
            <UndoToast key={toast.key} message={toast.message} actions={toast.actions} onDismiss={dismissToast} />
          </View>
        ) : null}

        <View
          style={{
            paddingHorizontal: spacing.lg,
            paddingTop: spacing.sm,
            paddingBottom: keyboardVisible ? spacing.sm : Math.max(insets.bottom, spacing.sm),
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: colors.border,
            backgroundColor: colors.background,
          }}>
          {suggestions.length > 0 ? (
            <ScrollView
              horizontal
              keyboardShouldPersistTaps="always"
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.sm }}>
              {suggestions.map((s) => (
                <Pressable
                  key={s.key}
                  accessibilityRole="button"
                  accessibilityLabel={`Add ${s.displayName}`}
                  onPress={() => add(applySuggestion(text, s))}
                  style={({ pressed }) => [
                    styles.chip,
                    {
                      minHeight: sizes.minTapTarget,
                      paddingHorizontal: spacing.md,
                      borderRadius: rounded.full,
                      backgroundColor: colors.surfaceMuted,
                      opacity: pressed ? opacity.pressed : 1,
                    },
                  ]}>
                  <ThemedText variant="callout">{s.displayName}</ThemedText>
                </Pressable>
              ))}
            </ScrollView>
          ) : null}
          <TextField
            value={text}
            onChangeText={setText}
            onSubmitEditing={() => add(text)}
            submitBehavior="submit"
            returnKeyType="done"
            placeholder="Add an item, like 2 lbs chicken thighs"
            accessibilityLabel="Add an item"
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardWillShow', () => setVisible(true));
    const hide = Keyboard.addListener('keyboardWillHide', () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  checkedHeader: { flexDirection: 'row', alignItems: 'center' },
  chip: { justifyContent: 'center', borderCurve: 'continuous' },
});
