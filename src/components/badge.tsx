import { StyleSheet, View } from 'react-native';

import { badgeColors, type BadgeTone } from '@/components/appearance';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

/** A small label: positive ("On Groceries", "Synced"), Owner, pending ("Syncing…") or danger ("Sync error"). */
export function Badge({ label, tone = 'positive' }: { label: string; tone?: BadgeTone }) {
  const { colors, aisles, spacing, rounded } = useTheme();
  const look = badgeColors(tone, colors, aisles);
  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: look.fill, borderRadius: rounded.badge, paddingVertical: spacing.xs, paddingHorizontal: spacing.sm },
      ]}>
      <ThemedText variant="caption" style={{ color: look.text }}>
        {label}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { alignSelf: 'flex-start', borderCurve: 'continuous' },
});
