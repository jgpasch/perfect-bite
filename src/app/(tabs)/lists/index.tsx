import { Host, List, Section, Text as SwiftText } from '@expo/ui/swift-ui';
import { deleteDisabled, environment } from '@expo/ui/swift-ui/modifiers';
import { Link, router, Stack } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { listTileColors, siriMarkColors } from '@/components/appearance';
import { PrimaryButton } from '@/components/button';
import { EmptyState } from '@/components/empty-state';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Screen } from '@/components/themed-view';
import { households, listItems, lists, userSettings } from '@/db';
import { useLiveQueryOn } from '@/db/live-query';
import { listHue } from '@/domain/aisle-color';
import { getAccount } from '@/features/auth/account';
import { householdsQuery } from '@/features/households/households';
import { listsOverview, tileAccessibilityLabel, tileCount } from '@/features/lists/list-view';
import {
  deleteList,
  getDefaultListId,
  listsWithCountsQuery,
  moveList,
  setDefaultList,
  setListArchived,
  type ListSummary,
} from '@/features/lists/lists';
import { ListsOverviewGrid, TileGrid } from '@/features/lists/lists-overview';
import { promptListName } from '@/features/lists/prompt-list-name';
import { useTheme } from '@/hooks/use-theme';

/**
 * Lists home (spec 4.1, board 01): a two-column grid of list tiles. With more than one household,
 * a section per household, each always open.
 */
export default function ListsScreen() {
  const { spacing, scheme, colors } = useTheme();
  // userSettings: so the Siri tile follows "Make default for Siri".
  const { data } = useLiveQueryOn(listsWithCountsQuery(), [lists, listItems, households, userSettings]);
  // Live, so joining or leaving a household switches between one and several without a restart.
  const { data: householdRows } = useLiveQueryOn(householdsQuery(), [households]);
  const active = useMemo(() => data.filter((l) => l.archivedAt === null), [data]);
  const archived = useMemo(() => data.filter((l) => l.archivedAt !== null), [data]);
  // Oldest first, so the first is the one new lists default to.
  const overview = useMemo(() => listsOverview(householdRows, active, householdRows[0]?.id ?? null), [householdRows, active]);
  const userId = getAccount()?.userId;
  // Re-read whenever the lists or settings change (`data` is a new array then).
  const defaultListId = useMemo(() => (userId && data.length > 0 ? getDefaultListId(userId) : null), [userId, data]);
  const [reordering, setReordering] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const create = (householdId?: string) =>
    promptListName(null, '', (id) => router.push({ pathname: '/list/[id]', params: { id } }), householdId);

  // SwiftUI's onMove destination is the index to insert before.
  const reorderRows = (group: ListSummary[]) => (
    <List.ForEach
      onMove={(from, destination) => {
        const source = from[0];
        moveList(group, source, destination > source ? destination - 1 : destination);
      }}>
      {group.map((l) => (
        <SwiftText key={l.id} modifiers={[deleteDisabled()]}>{l.emoji ? `${l.emoji} ${l.name}` : l.name}</SwiftText>
      ))}
    </List.ForEach>
  );

  return (
    <Screen>
      <Stack.Toolbar placement="right">
        {active.length > 1 ? (
          <Stack.Toolbar.Button onPress={() => setReordering((r) => !r)}>
            {reordering ? 'Done' : 'Edit'}
          </Stack.Toolbar.Button>
        ) : null}
        {overview.kind === 'multi' ? (
          // Several households: ask which one gets the new list.
          <Stack.Toolbar.Menu icon="plus" accessibilityLabel="New list" title="New list in" hidden={reordering}>
            {overview.sections.map((s) => (
              <Stack.Toolbar.MenuAction key={s.householdId} icon="circle.fill" onPress={() => create(s.householdId)}>
                {s.name}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
        ) : (
          <Stack.Toolbar.Button
            icon="plus"
            accessibilityLabel="New list"
            onPress={() => create(overview.householdId ?? undefined)}
            hidden={reordering}
          />
        )}
      </Stack.Toolbar>

      {reordering ? (
        // Native drag handles. With several households each is its own section, so a list can't be
        // dragged into another household.
        <Host style={styles.flex} colorScheme={scheme} seedColor={colors.primary}>
          <List modifiers={[environment('editMode', 'active')]}>
            {overview.kind === 'multi'
              ? overview.sections
                  .filter((s) => s.lists.length > 0)
                  .map((s) => (
                    <Section key={s.householdId} title={s.name}>
                      {reorderRows(s.lists)}
                    </Section>
                  ))
              : reorderRows(active)}
          </List>
        </Host>
      ) : overview.kind === 'single' && active.length === 0 && archived.length === 0 ? (
        <EmptyState
          message="No lists yet."
          action={<PrimaryButton label="New list" onPress={() => create(overview.householdId ?? undefined)} />}
        />
      ) : (
        <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: spacing.xl }}>
          <ListsOverviewGrid
            overview={overview}
            renderTile={(l) => <ListTile key={l.id} list={l} isDefault={l.id === defaultListId} />}
            onNewList={create}
          />
          {archived.length > 0 ? (
            <ArchivedHeader count={archived.length} open={showArchived} onPress={() => setShowArchived((v) => !v)} />
          ) : null}
          {showArchived ? <TileGrid cells={archived.map((l) => <ListTile key={l.id} list={l} isDefault={false} />)} /> : null}
        </ScrollView>
      )}
    </Screen>
  );
}

function ListTile({ list, isDefault }: { list: ListSummary; isDefault: boolean }) {
  const { colors, aisles, spacing, sizes, rounded, opacity } = useTheme();
  const userId = getAccount()?.userId;
  const isArchived = list.archivedAt !== null;
  const count = list.uncheckedCount;
  // Colour is decoration: the VoiceOver label below doesn't mention it.
  const look = listTileColors(isDefault, listHue(list.color), colors, aisles);
  const headline = tileCount(count);
  const siri = siriMarkColors(colors, opacity.tint, look.mark);

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
                backgroundColor: look.fill,
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
                  <Icon name="mic.fill" color={look.mark} size={sizes.iconSmall} />
                  <ThemedText variant="caption" color={look.mark}>
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
  tile: { flex: 1, justifyContent: 'space-between', borderCurve: 'continuous' },
  tileName: { fontWeight: '600' },
});

