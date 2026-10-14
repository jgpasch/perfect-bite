import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, AppState, Platform, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  FadeOut,
  SlideInUp,
  SlideOutUp,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FullWindowOverlay } from 'react-native-screens';
import { scheduleOnRN } from 'react-native-worklets';

import { IconTile } from '@/components/icon-tile';
import { ThemedText } from '@/components/themed-text';
import { Motion } from '@/constants/theme';
import { matchParts } from '@/domain/text-match';
import { useTheme } from '@/hooks/use-theme';
import { useT } from '@/i18n';

import { dismissNotification, useCurrentNotification, type AppNotification } from './notifications';

/** How far up a swipe has to go, or how fast, to dismiss the banner. */
const SWIPE_DISTANCE = -24;
const SWIPE_VELOCITY = -500;

/**
 * Shows in-app notifications (spec 4.11) one at a time at the top of the screen. On iOS it draws in a
 * full-window overlay, so a banner shows over sheets and modals too. Banners wait while the app is in
 * the background, and their timer starts again when it returns.
 */
export function NotificationHost() {
  const notification = useCurrentNotification();
  const active = useAppActive();
  if (!notification || !active) return null;

  const banner = <Banner key={notification.id} notification={notification} />;
  if (Platform.OS !== 'ios') {
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
        {banner}
      </View>
    );
  }
  // The overlay is its own native window layer, so gestures need their own root inside it.
  return (
    <FullWindowOverlay>
      <GestureHandlerRootView style={styles.passThrough} pointerEvents="box-none">
        {banner}
      </GestureHandlerRootView>
    </FullWindowOverlay>
  );
}

function Banner({ notification }: { notification: AppNotification }) {
  const { colors, spacing, rounded, shadows, scheme } = useTheme();
  const t = useT();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const offset = useSharedValue(0);
  const { id, title, body, emphasis, hint, onPress, tone } = notification;

  // Arrival: a haptic, and VoiceOver reads it. A replacement with the same id doesn't buzz again.
  useEffect(() => {
    void Haptics.notificationAsync(
      tone === 'success' ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning,
    );
  }, [id, tone]);
  const announcement = body ? `${title}. ${body}` : title;
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(announcement);
  }, [announcement]);

  // A replacement is a new object, so it restarts the timer.
  useEffect(() => {
    const timer = setTimeout(() => dismissNotification(id), Motion.notificationTimeoutMs);
    return () => clearTimeout(timer);
  }, [id, notification]);

  const open = () => {
    dismissNotification(id);
    onPress?.();
  };

  const tap = Gesture.Tap().runOnJS(true).onEnd(open);
  const swipe = Gesture.Pan()
    .activeOffsetY([-8, 8])
    .onUpdate((e) => {
      // Up follows the finger; down only gives a little.
      offset.set(e.translationY < 0 ? e.translationY : e.translationY / 4);
    })
    .onEnd((e) => {
      if (e.translationY < SWIPE_DISTANCE || e.velocityY < SWIPE_VELOCITY) {
        offset.set(withTiming(-200, { duration: Motion.duration }, () => scheduleOnRN(dismissNotification, id)));
      } else {
        offset.set(withSpring(0, Motion.spring));
      }
    });
  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: offset.get() }] }));

  const parts = body && emphasis ? matchParts(body, emphasis) : null;

  return (
    <GestureDetector gesture={Gesture.Exclusive(swipe, tap)}>
      <Animated.View
        entering={
          reduceMotion
            ? FadeIn.duration(Motion.duration)
            : SlideInUp.springify().damping(Motion.spring.damping).stiffness(Motion.spring.stiffness)
        }
        exiting={reduceMotion ? FadeOut.duration(Motion.duration) : SlideOutUp.duration(Motion.duration)}
        accessible
        accessibilityRole="button"
        accessibilityLabel={announcement}
        accessibilityHint={hint}
        accessibilityActions={[{ name: 'activate' }, { name: 'escape', label: t('common.dismiss') }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'activate') open();
          if (e.nativeEvent.actionName === 'escape') dismissNotification(id);
        }}
        style={[
          styles.banner,
          slide,
          scheme === 'light' ? { ...shadows.floating, shadowColor: colors.ink } : null,
          {
            top: insets.top + spacing.sm,
            left: spacing.lg,
            right: spacing.lg,
            padding: spacing.md + spacing.xxs,
            gap: spacing.md,
            borderRadius: rounded.card,
            backgroundColor: colors.surface,
          },
        ]}>
        <IconTile hue={notification.hue} name={notification.icon} />
        <View style={styles.text}>
          <ThemedText variant="headline" numberOfLines={1}>
            {title}
          </ThemedText>
          {body ? (
            <ThemedText variant="footnote" color="inkSecondary" numberOfLines={2}>
              {parts ? (
                <>
                  {parts.before}
                  <ThemedText variant="footnote" color="inkSecondary" style={styles.emphasis}>
                    {parts.match}
                  </ThemedText>
                  {parts.after}
                </>
              ) : (
                body
              )}
            </ThemedText>
          ) : null}
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

/** False while the app is in the background. A system alert or Control Center (`inactive`) doesn't count. */
function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState !== 'background');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setActive(state !== 'background'));
    return () => subscription.remove();
  }, []);
  return active;
}

const styles = StyleSheet.create({
  passThrough: { flex: 1 },
  banner: { position: 'absolute', flexDirection: 'row', alignItems: 'center', borderCurve: 'continuous' },
  text: { flex: 1 },
  emphasis: { fontWeight: '700' },
});
