import { useEffect } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet } from 'react-native';
import Animated from 'react-native-reanimated';

import { toastAnnouncement } from '@/components/appearance';
import { ThemedText } from '@/components/themed-text';
import { Motion } from '@/constants/theme';
import { matchParts } from '@/domain/text-match';
import { useMotion } from '@/hooks/use-motion';
import { useTheme } from '@/hooks/use-theme';

export type ToastAction = { label: string; onPress: () => void };

type Props = {
  message: string;
  /** Part of the message to set in bold, e.g. the item's name. */
  emphasis?: string;
  /** One or two actions, e.g. Undo (spec 4.4), or Undo · Adjust. */
  actions: ToastAction[];
  /** Called when the toast times out (spec 4.2: 5 seconds). */
  onDismiss: () => void;
};

/** A dark pill with white action pills, e.g. "Deleted milk · Undo". Render it keyed by what it's about. */
export function Toast({ message, emphasis, actions, onDismiss }: Props) {
  const { colors, spacing, rounded, sizes, shadows, scheme, opacity } = useTheme();
  const { entering, exiting } = useMotion();
  const parts = emphasis ? matchParts(message, emphasis) : null;

  const announcement = toastAnnouncement(
    message,
    actions.map((a) => a.label),
  );
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(announcement);
    const timer = setTimeout(onDismiss, Motion.undoTimeoutMs);
    return () => clearTimeout(timer);
  }, [announcement, onDismiss]);

  return (
    <Animated.View
      entering={entering}
      exiting={exiting}
      accessibilityLiveRegion="polite"
      style={[
        styles.toast,
        scheme === 'light' ? { ...shadows.floating, shadowColor: colors.toast } : null,
        {
          minHeight: sizes.bar,
          backgroundColor: colors.toast,
          borderRadius: rounded.full,
          paddingLeft: spacing.lg + spacing.xs,
          paddingRight: (sizes.bar - sizes.barButton) / 2,
          paddingVertical: (sizes.bar - sizes.barButton) / 2,
          marginHorizontal: spacing.lg,
          gap: spacing.sm,
        },
      ]}>
      <ThemedText variant="amount" color="onToast" style={styles.message} numberOfLines={2}>
        {parts ? (
          <>
            {parts.before}
            <ThemedText variant="amount" color="onToast" style={styles.actionLabel}>
              {parts.match}
            </ThemedText>
            {parts.after}
          </>
        ) : (
          message
        )}
      </ThemedText>
      {actions.map((action) => (
        <Pressable
          key={action.label}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={action.onPress}
          hitSlop={(sizes.minTapTarget - sizes.barButton) / 2}
          style={({ pressed }) => [
            styles.action,
            {
              minHeight: sizes.barButton,
              paddingHorizontal: spacing.lg,
              borderRadius: rounded.full,
              backgroundColor: colors.surface,
              opacity: pressed ? opacity.pressed : 1,
            },
          ]}>
          <ThemedText variant="amount" style={styles.actionLabel}>
            {action.label}
          </ThemedText>
        </Pressable>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: { flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
  message: { flex: 1, fontWeight: '400' },
  action: { justifyContent: 'center', borderCurve: 'continuous' },
  actionLabel: { fontWeight: '700' },
});
