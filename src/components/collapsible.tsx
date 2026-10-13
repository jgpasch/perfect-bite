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
  type SharedValue,
} from 'react-native-reanimated';

import { Motion } from '@/constants/theme';
import { useMotion } from '@/hooks/use-motion';

type Props = {
  open: boolean;
  /** The fold's progress from `useFold`, to move something else in step with it. */
  progress?: SharedValue<number>;
  children: ReactNode;
};

/** A fold's progress, 0 folded to 1 open: a spring, or a short timing under Reduce Motion. */
export function useFold(open: boolean) {
  const { reduceMotion } = useMotion();
  const progress = useSharedValue(open ? 1 : 0);
  useEffect(() => {
    const target = open ? 1 : 0;
    progress.value = reduceMotion
      ? withTiming(target, { duration: Motion.duration, reduceMotion: ReduceMotion.Never })
      : withSpring(target, Motion.fold);
  }, [open, progress, reduceMotion]);
  return progress;
}

/**
 * Content that folds away: its height springs between 0 and the content's own, while the content
 * fades and settles in from just above. The cards below glide with it. Under Reduce Motion the height snaps and
 * the content only fades. The content mounts on first open and stays mounted, so folding it animates too.
 */
export function Collapsible({ open, progress: shared, children }: Props) {
  const { reduceMotion } = useMotion();
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);

  const measured = useSharedValue<number | null>(null);
  // Once measured, the content is laid out apart from the clip, so folding doesn't squeeze it, and a re-layout
  // while folded (a row added) still measures its full height.
  const [laidOut, setLaidOut] = useState(false);
  const own = useFold(open);
  const progress = shared ?? own;

  const clip = useAnimatedStyle(() => {
    const p = progress.value;
    // Until it's measured, an open section takes its content's height and a folded one none. After that the
    // height is always a number, even fully open: switching between a number and 'auto' (or undefined) makes
    // the fold snap at its ends and flicker. Rows added or removed while open change the measured height, so
    // the card follows them a frame later.
    if (measured.value === null) return p === 1 ? {} : { height: 0 };
    const shut = reduceMotion ? (open ? 1 : 0) : p;
    return { height: measured.value * shut };
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
        <Animated.View
          style={[laidOut ? styles.apart : null, content]}
          onLayout={(e) => {
            measured.value = e.nativeEvent.layout.height;
            setLaidOut(true);
          }}>
          {/* The rows arrive with the fold, not each with its own insertion animation. */}
          <LayoutAnimationConfig skipEntering>{children}</LayoutAnimationConfig>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  apart: { position: 'absolute', top: 0, left: 0, right: 0 },
});
