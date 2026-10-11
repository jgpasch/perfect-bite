import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import type { FailedImport } from '@/db';
import { getAccount } from '@/features/auth/account';
import { useTheme } from '@/hooks/use-theme';

import {
  dismissFailedImport,
  failedImportName,
  failedImportReason,
  failedImportsTitle,
  retryFailedImport,
} from './failed-imports';

/**
 * The Recipes tab's failed imports (spec 4.10): "Couldn't import 1 recipe", which expands to a row per
 * import with its title (or host), why, **Try again** (into the default list) and **Dismiss**.
 */
export function FailedImportsCard({ rows }: { rows: FailedImport[] }) {
  const { spacing, sizes, opacity } = useTheme();
  const [open, setOpen] = useState(false);
  const title = failedImportsTitle(rows.length);

  return (
    <Card style={{ marginBottom: spacing.md }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={title}
        onPress={() => setOpen((o) => !o)}
        style={({ pressed }) => [
          styles.row,
          {
            minHeight: sizes.minTapTarget,
            paddingHorizontal: spacing.md + spacing.xxs,
            paddingVertical: spacing.sm,
            gap: spacing.sm,
            opacity: pressed ? opacity.pressed : 1,
          },
        ]}>
        <Icon name="exclamationmark.circle" color="danger" />
        <ThemedText variant="headline" style={styles.flex}>
          {title}
        </ThemedText>
        <Icon name={open ? 'chevron.down' : 'chevron.right'} color="inkSecondary" size={sizes.iconSmall} />
      </Pressable>
      {open ? rows.map((row) => <FailedImportRow key={row.id} row={row} />) : null}
    </Card>
  );
}

function FailedImportRow({ row }: { row: FailedImport }) {
  const { colors, spacing } = useTheme();
  const [trying, setTrying] = useState(false);

  const retry = async () => {
    const userId = getAccount()?.userId;
    if (!userId || trying) return;
    setTrying(true);
    // Success removes the row (and this component); a failure updates its reason.
    const result = await retryFailedImport(row.id, userId);
    if (!result?.ok) setTrying(false);
  };

  return (
    <View
      style={{
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: colors.border,
        paddingHorizontal: spacing.md + spacing.xxs,
        paddingTop: spacing.sm + spacing.xxs,
        paddingBottom: spacing.xs,
      }}>
      <ThemedText variant="body" numberOfLines={2}>
        {failedImportName(row)}
      </ThemedText>
      <ThemedText variant="footnote" color="inkSecondary">
        {failedImportReason(row.reason)}
      </ThemedText>
      <View style={[styles.row, { gap: spacing.md }]}>
        <Button label={trying ? 'Trying…' : 'Try again'} variant="plain" disabled={trying} onPress={retry} />
        <Button label="Dismiss" variant="plain" color="inkSecondary" onPress={() => dismissFailedImport(row.id)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
});
