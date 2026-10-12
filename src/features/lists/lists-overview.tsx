import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { householdColor } from '@/domain/aisle-color';
import { householdHeaderLabel, newListTileIsCompact, pairs, type ListsOverview } from '@/features/lists/list-view';
import { useTheme } from '@/hooks/use-theme';

/**
 * The Lists home's tiles (spec 4.1, board 01). One household: its tiles right under the title, with no
 * household UI. More: a section per household (colour bar, name, tiles), all open.
 */
export function ListsOverviewGrid<L extends { id: string }>({
  overview,
  renderTile,
  onNewList,
}: {
  overview: ListsOverview<L>;
  renderTile: (list: L) => ReactNode;
  onNewList: (householdId: string | undefined) => void;
}) {
  const { spacing } = useTheme();
  const cells = (lists: L[], householdId: string | undefined) => [
    ...lists.map(renderTile),
    <NewListTile key="new" compact={newListTileIsCompact(lists.length)} onPress={() => onNewList(householdId)} />,
  ];

  if (overview.kind === 'single') {
    return (
      <View style={{ paddingTop: spacing.xs }}>
        <TileGrid cells={cells(overview.lists, overview.householdId ?? undefined)} />
      </View>
    );
  }
  return overview.sections.map((section, i) => (
    // About 28 pt from one section's tiles to the next header.
    <View key={section.householdId} style={{ marginTop: i === 0 ? spacing.xs : spacing.xl + spacing.xs }}>
      <HouseholdHeader householdId={section.householdId} name={section.name} />
      <TileGrid cells={cells(section.lists, section.householdId)} />
    </View>
  ));
}

/** A household's colour bar and name. Members aren't stored on the device, so there are no avatars here. */
function HouseholdHeader({ householdId, name }: { householdId: string; name: string }) {
  const { aisles, spacing, sizes, rounded } = useTheme();
  return (
    <View
      accessible
      accessibilityRole="header"
      accessibilityLabel={householdHeaderLabel(name)}
      style={[styles.row, { gap: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: spacing.md }]}>
      <View
        style={{
          width: sizes.householdBarWidth,
          height: sizes.householdBar,
          borderRadius: rounded.full,
          backgroundColor: aisles[householdColor(householdId)].dot,
        }}
      />
      <ThemedText variant="householdName" numberOfLines={1} style={styles.flex}>
        {name}
      </ThemedText>
    </View>
  );
}

/** Two columns of tiles with a 12 pt gap; an odd last tile keeps its column width. */
export function TileGrid({ cells }: { cells: ReactNode[] }) {
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

/** The dashed tile that ends each household's grid; short when it starts a row on its own. */
function NewListTile({ compact, onPress }: { compact: boolean; onPress: () => void }) {
  const { colors, spacing, sizes, rounded, opacity } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="New list"
      onPress={onPress}
      style={({ pressed }) => [
        styles.newTile,
        {
          // The short tile puts the + beside the label, as there's no room above it.
          flexDirection: compact ? 'row' : 'column',
          minHeight: compact ? sizes.tileCompact : sizes.tile,
          borderRadius: rounded.tile,
          borderWidth: sizes.checkBorder,
          borderColor: colors.controlBorder,
          gap: spacing.xs + spacing.xxs,
          padding: compact ? spacing.md : spacing.lg,
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

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  stretch: { alignItems: 'stretch' },
  newTile: { flex: 1, alignItems: 'center', justifyContent: 'center', borderStyle: 'dashed' },
});
