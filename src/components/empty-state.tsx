import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  /** One short sentence. */
  message: string;
  /** Optional single action, e.g. a Button. */
  action?: ReactNode;
};

export function EmptyState({ message, action }: Props) {
  const { spacing } = useTheme();
  return (
    <View style={[styles.container, { gap: spacing.xl, padding: spacing.xl }]}>
      <ThemedText variant="callout" color="inkSecondary" style={styles.message}>
        {message}
      </ThemedText>
      {action ? <View style={styles.action}>{action}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  message: { textAlign: 'center' },
  action: { alignSelf: 'stretch' },
});
