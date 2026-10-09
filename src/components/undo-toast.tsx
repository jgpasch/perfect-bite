import { useEffect } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet } from 'react-native';
import Animated from 'react-native-reanimated';

import { ThemedText } from '@/components/themed-text';
import { Motion } from '@/constants/theme';
import { useMotion } from '@/hooks/use-motion';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  message: string;
  actionLabel?: string;
  onAction: () => void;
  /** Called when the toast times out (spec 4.2: 5 seconds). */
  onDismiss: () => void;
};

/** A floating message with one action, e.g. "Deleted milk · Undo". Render it keyed by what it's about. */
export function UndoToast({ message, actionLabel = 'Undo', onAction, onDismiss }: Props) {
  const { colors, spacing, rounded, sizes, shadows, scheme, opacity } = useTheme();
  const { entering, exiting } = useMotion();

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(`${message}. ${actionLabel} available.`);
    const timer = setTimeout(onDismiss, Motion.undoTimeoutMs);
    return () => clearTimeout(timer);
  }, [message, actionLabel, onDismiss]);

  return (
    <Animated.View
      entering={entering}
      exiting={exiting}
      accessibilityLiveRegion="polite"
      style={[
        styles.toast,
        scheme === 'light' ? { ...shadows.floating, shadowColor: colors.ink } : null,
        {
          backgroundColor: colors.ink,
          borderRadius: rounded.md,
          paddingLeft: spacing.lg,
          marginHorizontal: spacing.lg,
          gap: spacing.md,
        },
      ]}>
      <ThemedText variant="callout" color="background" style={styles.message} numberOfLines={2}>
        {message}
      </ThemedText>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={actionLabel}
        onPress={onAction}
        style={({ pressed }) => ({
          minHeight: sizes.minTapTarget,
          justifyContent: 'center',
          paddingHorizontal: spacing.lg,
          opacity: pressed ? opacity.pressed : 1,
        })}>
        <ThemedText variant="headline" color="background">
          {actionLabel}
        </ThemedText>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: { flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
  message: { flex: 1 },
});
