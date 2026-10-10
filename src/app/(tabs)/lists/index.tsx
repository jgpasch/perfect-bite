import { Host, List, Text as SwiftText } from '@expo/ui/swift-ui';
import { deleteDisabled, environment } from '@expo/ui/swift-ui/modifiers';
import { Link, router, Stack } from 'expo-router';
import { useMemo, useState, type ReactNode } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { listTileColors, siriMarkColors } from '@/components/appearance';
import { PrimaryButton } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { households, listItems, lists, userSettings } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { getAccount } from '@/features/auth/account';
import { groupListsByHousehold, pairs, tileAccessibilityLabel, tileCount } from '@/features/lists/list-view';
import {
  deleteList,
  getDefaultListId,
  listsWithCountsQuery,
  moveList,
  setDefaultList,
  setListArchived,
  type ListSummary,
} from '@/features/lists/lists';
import { promptListName } from '@/features/lists/prompt-list-name';
import { useTheme } from '@/hooks/use-theme';

/** Lists home (spec 4.1, board 01): a two-column grid of list tiles under each household's name. */
export default function ListsScreen() {
  const { spacing, scheme, colors } = useTheme();
  // userSettings: so the Siri tile follows "Make default for Siri".
  const { data } = useLiveQueryOn(listsWithCountsQuery(), [lists, listItems, households, userSettings]);
  const active = useMemo(() => data.filter((l) => l.archivedAt === null), [data]);
  const archived = useMemo(() => data.filter((l) => l.archivedAt !== null), [data]);
  const groups = useMemo(() => groupListsByHousehold(active), [active]);
  const userId = getAccount()?.userId;
  // Re-read whenever the lists or settings change (`data` is a new array then).
  const defaultListId = useMemo(() => (userId && data.length > 0 ? getDefaultListId(userId) : null), [userId, data]);
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
          {groups.map((group, i) => (
            <View key={group.householdId}>
              <HouseholdLabel name={group.name} first={i === 0} />
              <TileGrid
                cells={[
                  ...group.lists.map((l) => <ListTile key={l.id} list={l} isDefault={l.id === defaultListId} />),
                  <NewListTile key="new" onPress={create} />,
                ]}
              />
            </View>
          ))}
          {archived.length > 0 ? (
            <ArchivedHeader count={archived.length} open={showArchived} onPress={() => setShowArchived((v) => !v)} />
          ) : null}
          {showArchived ? <TileGrid cells={archived.map((l) => <ListTile key={l.id} list={l} isDefault={false} />)} /> : null}
        </ScrollView>
      )}
    </Screen>
  );
}

/** The household's name above its tiles. */
function HouseholdLabel({ name, first }: { name: string; first: boolean }) {
  const { spacing } = useTheme();
  return (
    <ThemedText
      variant="sectionLabel"
      color="inkSecondary"
      accessibilityRole="header"
      style={{ paddingHorizontal: spacing.lg + spacing.xs, paddingTop: first ? spacing.xs : spacing.xl, paddingBottom: spacing.sm }}>
      {name}
    </ThemedText>
  );
}

/** Two columns of tiles with a 12 pt gap; an odd last tile keeps its column width. */
function TileGrid({ cells }: { cells: ReactNode[] }) {
  const { spacing } = useTheme();
  return (
    <View style={{ gap: spacing.md, paddingHorizontal: spacing.lg }}>
      {pairs(cells).map((row, i) => (
        <View key={i} style={[styles.row, styles.stretch, { gap: spacing.md }]}>
          {row.map((cell, j) => (
            <View key={j} style={styles.flex}>
              {cell}
            </View>
          ))}
          {row.length === 1 ? <View style={styles.flex} /> : null}
        </View>
      ))}
    </View>
  );
}

/** The dashed tile that ends each household's grid. */
function NewListTile({ onPress }: { onPress: () => void }) {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New list"
      onPress={onPress}
      style={({ pressed }) => [
        styles.newTile,
        {
          minHeight: sizes.tile,
          borderRadius: rounded.tile,
          borderWidth: sizes.checkBorder,
          borderColor: colors.controlBorder,
          gap: spacing.xs + spacing.xxs,
          padding: spacing.lg,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <Icon name="plus" color="inkSecondary" weight="semibold" size={sizes.iconLarge} />
      <ThemedText variant="amount" color="inkSecondary">
        New list
      </ThemedText>
    </Pressable>
  );
}

function ListTile({ list, isDefault }: { list: ListSummary; isDefault: boolean }) {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  const userId = getAccount()?.userId;
  const isArchived = list.archivedAt !== null;
  const count = list.uncheckedCount;
  const look = listTileColors(isDefault);
  const headline = tileCount(count);
  const siri = siriMarkColors(colors, opacity.tint);

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
          accessibilityLabel={tileAccessibilityLabel(list.name, count, { isDefault, archived: isArchived })}>
          {/* Layout lives on a View: Link's trigger replaces the Pressable's style. */}
          <View
            style={[
              styles.tile,
              {
                minHeight: sizes.tile,
                padding: spacing.lg,
                gap: spacing.sm,
                borderRadius: rounded.tile,
                backgroundColor: colors[look.fill],
                opacity: isArchived ? opacity.disabled : 1,
              },
            ]}>
            <View style={[styles.row, { gap: spacing.sm }]}>
              <ThemedText variant="title" style={styles.flex}>
                {list.emoji ?? ''}
              </ThemedText>
              {isDefault ? (
                <View
                  style={[
                    styles.row,
                    {
                      gap: spacing.xs,
                      paddingVertical: spacing.xxs,
                      paddingHorizontal: spacing.sm,
                      borderRadius: rounded.badge,
                      backgroundColor: siri.fill,
                    },
                  ]}>
                  <Icon name="mic.fill" color={look.text} size={sizes.iconSmall} />
                  <ThemedText variant="caption" color={look.text}>
                    Siri
                  </ThemedText>
                </View>
              ) : null}
            </View>
            <View>
              {headline.kind === 'count' ? (
                <ThemedText variant="tileCount" color={look.text}>
                  {headline.text}
                </ThemedText>
              ) : (
                <ThemedText variant="amount" color={look.secondary}>
                  {headline.text}
                </ThemedText>
              )}
              <ThemedText variant="callout" color={look.text} style={styles.tileName} numberOfLines={2}>
                {list.name}
              </ThemedText>
            </View>
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
        { minHeight: sizes.minTapTarget, paddingHorizontal: spacing.lg + spacing.xs, marginTop: spacing.xl, gap: spacing.sm, opacity: pressed ? opacity.pressed : 1 },
      ]}>
      <ThemedText variant="sectionLabel" color="inkSecondary" style={styles.flex}>
        Archived ({count})
      </ThemedText>
      <Icon name={open ? 'chevron.down' : 'chevron.right'} color="inkSecondary" size={sizes.iconSmall} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  stretch: { alignItems: 'stretch' },
  tile: { flex: 1, justifyContent: 'space-between', borderCurve: 'continuous' },
  tileName: { fontWeight: '600' },
  newTile: { flex: 1, alignItems: 'center', justifyContent: 'center', borderStyle: 'dashed' },
});

