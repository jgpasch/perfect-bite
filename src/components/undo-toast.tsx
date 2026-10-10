import { useEffect } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet } from 'react-native';
import Animated from 'react-native-reanimated';

import { ThemedText } from '@/components/themed-text';
import { Motion } from '@/constants/theme';
import { useMotion } from '@/hooks/use-motion';
import { useTheme } from '@/hooks/use-theme';

export type ToastAction = { label: string; onPress: () => void };

type Props = {
  message: string;
  /** One or two actions, e.g. Undo, or Undo · Keep existing (spec 4.4). */
  actions: ToastAction[];
  /** Called when the toast times out (spec 4.2: 5 seconds). */
  onDismiss: () => void;
};

/** A floating message with actions, e.g. "Deleted milk · Undo". Render it keyed by what it's about. */
export function UndoToast({ message, actions, onDismiss }: Props) {
  const { colors, spacing, rounded, sizes, shadows, scheme, opacity } = useTheme();
  const { entering, exiting } = useMotion();

  const actionNames = actions.map((a) => a.label).join(', ');
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(`${message}. ${actionNames} available.`);
    const timer = setTimeout(onDismiss, Motion.undoTimeoutMs);
    return () => clearTimeout(timer);
  }, [message, actionNames, onDismiss]);

  return (
    <Animated.View
      entering={entering}
      exiting={exiting}
      accessibilityLiveRegion="polite"
      style={[
        styles.toast,
        scheme === 'light' ? { ...shadows.floating, shadowColor: colors.toast } : null,
        {
          backgroundColor: colors.toast,
          borderRadius: rounded.md,
          paddingLeft: spacing.lg,
          marginHorizontal: spacing.lg,
          gap: spacing.xs,
        },
      ]}>
      <ThemedText variant="callout" color="onToast" style={styles.message} numberOfLines={2}>
        {message}
      </ThemedText>
      {actions.map((action) => (
        <Pressable
          key={action.label}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          onPress={action.onPress}
          style={({ pressed }) => ({
            minHeight: sizes.minTapTarget,
            justifyContent: 'center',
            paddingHorizontal: spacing.md,
            opacity: pressed ? opacity.pressed : 1,
          })}>
          <ThemedText variant="headline" color="onToast">
            {action.label}
          </ThemedText>
        </Pressable>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: { flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
  message: { flex: 1 },
});
