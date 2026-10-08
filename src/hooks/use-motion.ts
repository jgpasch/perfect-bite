import { FadeIn, FadeInDown, FadeOut, LinearTransition, useReducedMotion } from 'react-native-reanimated';

import { Motion } from '@/constants/theme';

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
