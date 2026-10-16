import {
  FadeIn,
  FadeInDown,
  FadeOut,
  LinearTransition,
  useReducedMotion,
  withTiming,
  type EntryAnimationsValues,
  type LayoutAnimation,
} from 'react-native-reanimated';

import { Motion } from '@/constants/theme';

const GROW_MS = Motion.duration;

/**
 * A row growing into place (spec 4.1, an arrival): its height opens from nothing while it fades in, so
 * the rows below make room. Not under Reduce Motion (`useMotion`'s `entering` then).
 */
export function growIn(values: EntryAnimationsValues): LayoutAnimation {
  'worklet';
  return {
    initialValues: { height: 0, opacity: 0 },
    animations: {
      height: withTiming(values.targetHeight, { duration: GROW_MS }),
      opacity: withTiming(1, { duration: GROW_MS }),
    },
  };
}

/**
 * Short physical springs for row insertions; cross-fades under Reduce Motion.
 */
export function useMotion() {
  const reduceMotion = useReducedMotion();
  const { damping, stiffness, mass } = Motion.spring;

  if (reduceMotion) {
    return {
      reduceMotion,
      entering: FadeIn.duration(Motion.duration),
      exiting: FadeOut.duration(Motion.duration),
      layout: undefined,
    };
  }

  return {
    reduceMotion,
    entering: FadeInDown.springify().damping(damping).stiffness(stiffness).mass(mass),
    exiting: FadeOut.duration(Motion.duration),
    layout: LinearTransition.springify().damping(damping).stiffness(stiffness).mass(mass),
  };
}
