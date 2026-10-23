import { useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { avatarColors, listHeaderColors } from '@/components/appearance';
import { ThemedText } from '@/components/themed-text';
import { Motion } from '@/constants/theme';
import { memberHue } from '@/domain/aisle-color';
import { avatarInitial } from '@/features/households/households';
import { nameOf, type MemberNames } from '@/features/households/member-names';
import { useTheme } from '@/hooks/use-theme';

import { addingPillText } from './presence';

const DOTS = [0, 1, 2] as const;
const DIM = 0.35;

/**
 * "Alex is adding" (spec 4.1, board 2 D): under "9 to get · By aisle" on the green, a 32 pt
 * `HEADER_WASH` pill with the first adder's 24 pt avatar, the text in `onHeader` and three pulsing
 * dots (still under Reduce Motion). Fades in and out over `motion.presenceFadeMs`. A static text
 * element for VoiceOver, never announced. Nothing while no one else is adding. In add mode it's hidden and
 * add mode's compact title says it instead.
 */
export function AddingPill({
  userIds,
  names,
  currentUserId,
  hidden = false,
  style,
}: {
  /** The other members adding, in order. */
  userIds: readonly string[];
  names: MemberNames;
  currentUserId: string | null;
  /** In add mode, when the header is collapsed. */
  hidden?: boolean;
  /** Its margins in the header. */
  style?: StyleProp<ViewStyle>;
}) {
  const { colors, aisles, spacing, sizes, rounded } = useTheme();
  const text = addingPillText(userIds, names, currentUserId);
  if (!text || hidden) return null;
  const look = listHeaderColors(colors).presencePill;
  const first = userIds[0];
  const avatar = avatarColors(memberHue(first), colors, aisles);
  return (
    <Animated.View
      entering={FadeIn.duration(Motion.presenceFadeMs)}
      exiting={FadeOut.duration(Motion.presenceFadeMs)}
      testID="adding-pill"
      accessible
      accessibilityRole="text"
      accessibilityLabel={text}
      style={[
        styles.pill,
        {
          minHeight: sizes.viewButton,
          borderRadius: rounded.full,
          backgroundColor: look.fill,
          gap: spacing.sm,
          paddingLeft: (sizes.viewButton - sizes.presenceAvatar) / 2,
          paddingRight: spacing.md,
        },
        style,
      ]}>
      <View
        testID={`adding-avatar-${first}`}
        style={[
          styles.center,
          { width: sizes.presenceAvatar, height: sizes.presenceAvatar, borderRadius: rounded.full, backgroundColor: avatar.fill },
        ]}>
        <ThemedText variant="caption" maxFontSizeMultiplier={1.3} style={{ color: avatar.text }}>
          {avatarInitial(nameOf(names, first, currentUserId))}
        </ThemedText>
      </View>
      <ThemedText variant="amount" numberOfLines={1} style={[styles.shrink, { color: look.text }]}>
        {text}
      </ThemedText>
      <AddingDots color={look.text} />
    </Animated.View>
  );
}

/** The pill's three pulsing dots, also beside "Alex is adding" in add mode's compact title. */
export function AddingDots({ color }: { color: string }) {
  const { spacing, sizes } = useTheme();
  return (
    <View style={[styles.dots, { gap: spacing.xxs }]}>
      {DOTS.map((i) => (
        <PulseDot key={i} index={i} color={color} size={sizes.presenceDot} />
      ))}
    </View>
  );
}

/** One of the three dots: dims and brightens in turn, a third of a pulse after the one before. Still under Reduce Motion. */
function PulseDot({ index, color, size }: { index: number; color: string; size: number }) {
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (reduceMotion) {
      opacity.value = 1;
      return;
    }
    const half = Motion.presencePulseMs / 2;
    opacity.value = withDelay(
      (index * Motion.presencePulseMs) / DOTS.length,
      withRepeat(withSequence(withTiming(DIM, { duration: half }), withTiming(1, { duration: half })), -1),
    );
  }, [index, opacity, reduceMotion]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      testID="adding-dot"
      style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }, style]}
    />
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start' },
  center: { alignItems: 'center', justifyContent: 'center' },
  shrink: { flexShrink: 1 },
  dots: { flexDirection: 'row', alignItems: 'center' },
});
