import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

/** A titled, rounded group of rows (iOS Settings style). */
export function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  const { colors, spacing, rounded } = useTheme();
  return (
    <View style={{ gap: spacing.sm }}>
      <ThemedText variant="footnote" color="inkSecondary" accessibilityRole="header" style={{ paddingHorizontal: spacing.lg }}>
        {title}
      </ThemedText>
      <View style={[styles.group, { borderRadius: rounded.md, backgroundColor: colors.surface }]}>{children}</View>
    </View>
  );
}

/** A label on the left and a read-only value on the right. */
export function SettingsRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  const { colors, spacing, sizes } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}, ${value}`}
      style={[
        styles.row,
        {
          minHeight: sizes.minTapTarget,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
          gap: spacing.md,
          borderBottomColor: colors.border,
          borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        },
      ]}>
      <ThemedText variant="body">{label}</ThemedText>
      <ThemedText variant="body" color="inkSecondary" style={styles.value}>
        {value}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  group: { overflow: 'hidden', borderCurve: 'continuous' },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  value: { flex: 1, textAlign: 'right' },
});
