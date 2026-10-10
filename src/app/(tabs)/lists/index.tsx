import { Host, List, Text as SwiftText } from '@expo/ui/swift-ui';
import { deleteDisabled, environment } from '@expo/ui/swift-ui/modifiers';
import { Link, router, Stack } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { PrimaryButton } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { listItems, lists } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { getAccount } from '@/features/auth/account';
import {
  deleteList,
  listsWithCountsQuery,
  moveList,
  setDefaultList,
  setListArchived,
  type ListSummary,
} from '@/features/lists/lists';
import { promptListName } from '@/features/lists/prompt-list-name';
import { useTheme } from '@/hooks/use-theme';

/** Lists home (spec 4.1). With one household there is no household UI (M7 adds sections). */
export default function ListsScreen() {
  const { spacing, scheme, colors } = useTheme();
  const { data } = useLiveQueryOn(listsWithCountsQuery(), [lists, listItems]);
  const active = useMemo(() => data.filter((l) => l.archivedAt === null), [data]);
  const archived = useMemo(() => data.filter((l) => l.archivedAt !== null), [data]);
  const [reordering, setReordering] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const create = () => promptListName(null, '', (id) => router.push({ pathname: '/list/[id]', params: { id } }));

  return (
    <Screen>
      <Stack.Toolbar placement="right">
        {active.length > 1 ? (
          <Stack.Toolbar.Button onPress={() => setReordering((r) => !r)}>
            {reordering ? 'Done' : 'Edit'}
          </Stack.Toolbar.Button>
        ) : null}
        <Stack.Toolbar.Button icon="plus" accessibilityLabel="New list" onPress={create} hidden={reordering} />
      </Stack.Toolbar>

      {reordering ? (
        // Native drag handles. SwiftUI's onMove destination is the index to insert before.
        <Host style={styles.flex} colorScheme={scheme} seedColor={colors.primary}>
          <List modifiers={[environment('editMode', 'active')]}>
            <List.ForEach
              onMove={(from, destination) => {
                const source = from[0];
                moveList(active, source, destination > source ? destination - 1 : destination);
              }}>
              {active.map((l) => (
                <SwiftText key={l.id} modifiers={[deleteDisabled()]}>{l.emoji ? `${l.emoji} ${l.name}` : l.name}</SwiftText>
              ))}
            </List.ForEach>
          </List>
        </Host>
      ) : active.length === 0 && archived.length === 0 ? (
        <EmptyState message="No lists yet." action={<PrimaryButton label="New list" onPress={create} />} />
      ) : (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: spacing.xl }}>
          {active.map((l, i) => (
            <ListRow key={l.id} list={l} last={i === active.length - 1} />
          ))}
          {archived.length > 0 ? (
            <ArchivedHeader count={archived.length} open={showArchived} onPress={() => setShowArchived((v) => !v)} />
          ) : null}
          {showArchived ? archived.map((l, i) => <ListRow key={l.id} list={l} last={i === archived.length - 1} />) : null}
        </ScrollView>
      )}
    </Screen>
  );
}

function ListRow({ list, last }: { list: ListSummary; last: boolean }) {
  const { colors, spacing, sizes, opacity } = useTheme();
  const userId = getAccount()?.userId;
  const isArchived = list.archivedAt !== null;
  const count = list.uncheckedCount;

  const confirmDelete = () =>
    Alert.alert(`Delete “${list.name}”?`, 'Its items are deleted too.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteList(list.id) },
    ]);

  return (
    <Link href={{ pathname: '/list/[id]', params: { id: list.id } }} asChild>
      <Link.Trigger>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${list.name}, ${count} ${count === 1 ? 'item' : 'items'}${isArchived ? ', archived' : ''}`}>
          {/* Layout lives on a View: Link's trigger replaces the Pressable's style. */}
          <View
            style={[
              styles.row,
              {
                minHeight: sizes.rowMin,
                paddingHorizontal: spacing.lg,
                paddingVertical: spacing.md,
                gap: spacing.md,
                borderBottomColor: colors.border,
                borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
                opacity: isArchived ? opacity.disabled : 1,
              },
            ]}>
            <ThemedText variant="body" style={styles.flex} numberOfLines={1}>
              {list.emoji ? `${list.emoji} ${list.name}` : list.name}
            </ThemedText>
            {count > 0 ? (
              <ThemedText variant="callout" color="inkSecondary">
                {count}
              </ThemedText>
            ) : null}
            <Icon name="chevron.right" color="inkSecondary" size={sizes.iconSmall} />
          </View>
        </Pressable>
      </Link.Trigger>
      <Link.Menu>
        <Link.MenuAction title="Rename" icon="pencil" onPress={() => promptListName(list.id, list.name)} />
        {userId && !isArchived ? (
          <Link.MenuAction title="Make default for Siri" icon="mic" onPress={() => setDefaultList(userId, list.id)} />
        ) : null}
        <Link.MenuAction
          title={isArchived ? 'Unarchive' : 'Archive'}
          icon="archivebox"
          onPress={() => setListArchived(list.id, !isArchived)}
        />
        <Link.MenuAction title="Delete" icon="trash" destructive onPress={confirmDelete} />
      </Link.Menu>
    </Link>
  );
}

function ArchivedHeader({ count, open, onPress }: { count: number; open: boolean; onPress: () => void }) {
  const { spacing, sizes, opacity } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={`Archived, ${count} ${count === 1 ? 'list' : 'lists'}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        { minHeight: sizes.minTapTarget, paddingHorizontal: spacing.lg, marginTop: spacing.xl, gap: spacing.sm, opacity: pressed ? opacity.pressed : 1 },
      ]}>
      <ThemedText variant="footnote" color="inkSecondary" style={styles.flex}>
        Archived ({count})
      </ThemedText>
      <Icon name={open ? 'chevron.down' : 'chevron.right'} color="inkSecondary" size={sizes.iconSmall} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
});

