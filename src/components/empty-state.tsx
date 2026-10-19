import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  /** One short sentence. */
  message: string;
  /** Optional single action, e.g. a Button. */
  action?: ReactNode;
  /** A glyph in a `primarySoft` tile over the title (the empty list, board C). */
  icon?: IconName;
  /** A headline over the message. */
  title?: string;
  /** Actions stacked and centred under the message, 8 pt apart. */
  actions?: ReactNode[];
};

export function EmptyState({ message, action, icon, title, actions }: Props) {
  const { colors, spacing, sizes, rounded } = useTheme();
  if (icon || title || actions) {
    // Board C: glyph tile, title, message, then the actions, about 40% down the space rather than centred.
    // Grows with the scroll view's content rather than filling it, so large Dynamic Type still scrolls.
    return (
      <View style={[styles.grow, { paddingHorizontal: spacing.xxl, paddingVertical: spacing.xl }]}>
        <View style={styles.above} />
        <View style={styles.block}>
          {icon ? (
            <View
              testID="empty-state-icon"
              style={[
                styles.tile,
                { width: sizes.emptyIcon, height: sizes.emptyIcon, borderRadius: rounded.card, backgroundColor: colors.primarySoft },
              ]}>
              <Icon name={icon} color="onPrimarySoft" size={sizes.emptyIcon / 2} />
            </View>
          ) : null}
          {title ? (
            <ThemedText
              variant="title"
              accessibilityRole="header"
              style={[styles.centred, icon ? { marginTop: spacing.lg + spacing.xs } : null]}>
              {title}
            </ThemedText>
          ) : null}
          <ThemedText
            variant="callout"
            color="inkSecondary"
            style={[styles.centred, title || icon ? { marginTop: spacing.sm } : null]}>
            {message}
          </ThemedText>
          {actions && actions.length > 0 ? (
            <View style={[styles.actions, { marginTop: spacing.xl, gap: spacing.sm }]}>{actions}</View>
          ) : null}
        </View>
        <View style={styles.below} />
      </View>
    );
  }
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
  grow: { flexGrow: 1 },
  // 2 : 3 of the free space above and below puts the block about 40% down.
  above: { flexGrow: 2 },
  below: { flexGrow: 3 },
  block: { alignItems: 'center' },
  tile: { alignItems: 'center', justifyContent: 'center', borderCurve: 'continuous' },
  centred: { textAlign: 'center' },
  actions: { alignItems: 'center' },
});
