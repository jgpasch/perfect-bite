import { useEffect, useState, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  interpolate,
  LayoutAnimationConfig,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { Motion } from '@/constants/theme';
import { useMotion } from '@/hooks/use-motion';

type Props = {
  open: boolean;
  /** The height left while folded, e.g. the padding that centres a section header in its card. */
  closedHeight?: number;
  children: ReactNode;
};

/**
 * Content that folds away: its height springs between `closedHeight` and the content's own, while the content
 * fades and settles in from just above. The cards below glide with it. Under Reduce Motion the height snaps and
 * the content only fades. The content mounts on first open and stays mounted, so folding it animates too.
 */
export function Collapsible({ open, closedHeight = 0, children }: Props) {
  const { reduceMotion } = useMotion();
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);

  const measured = useSharedValue<number | null>(null);
  const progress = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    const target = open ? 1 : 0;
    progress.value = reduceMotion
      ? withTiming(target, { duration: Motion.duration, reduceMotion: ReduceMotion.Never })
      : withSpring(target, Motion.fold);
  }, [open, progress, reduceMotion]);

  const clip = useAnimatedStyle(() => {
    const p = progress.value;
    // Fully open, the height is the content's own, so rows added or removed in place keep their own animations.
    if (p === 1 || measured.value === null) return { height: p === 1 ? undefined : closedHeight };
    const shut = reduceMotion ? (open ? 1 : 0) : p;
    return { height: closedHeight + (measured.value - closedHeight) * shut };
  });
  const content = useAnimatedStyle(() => {
    const p = progress.value;
    return {
      opacity: interpolate(p, [0.15, 1], [0, 1], 'clamp'),
      transform: reduceMotion ? [] : [{ translateY: -8 * (1 - p) }],
    };
  });

  return (
    <Animated.View
      style={[styles.clip, clip]}
      pointerEvents={open ? 'auto' : 'none'}
      accessibilityElementsHidden={!open}
      importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}>
      {mounted ? (
        <Animated.View style={content} onLayout={(e) => (measured.value = e.nativeEvent.layout.height)}>
          {/* The rows arrive with the fold, not each with its own insertion animation. */}
          <LayoutAnimationConfig skipEntering>{children}</LayoutAnimationConfig>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
});
