import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/icon';
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

/** A tappable row that opens another screen: a label on the left and a chevron on the right. */
export function SettingsLinkRow({ label, onPress, last }: { label: string; onPress: () => void; last?: boolean }) {
  const { colors, spacing, sizes, opacity } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: sizes.minTapTarget,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
          gap: spacing.md,
          borderBottomColor: colors.border,
          borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
          opacity: pressed ? opacity.pressed : 1,
        },
      ]}>
      <ThemedText variant="body" numberOfLines={1} style={styles.label}>
        {label}
      </ThemedText>
      <Icon name="chevron.right" color="inkSecondary" size={sizes.iconSmall} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  label: { flex: 1 },
  group: { overflow: 'hidden', borderCurve: 'continuous' },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  value: { flex: 1, textAlign: 'right' },
});
