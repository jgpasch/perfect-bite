// A section header's swipes (spec 4.6): right checks all, left removes. Checking's haptic is the check-off
// tick its `onCheck` plays (spec 4.1), so the header doesn't add its own; removing plays a light impact.
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as Haptics from 'expo-haptics';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { SectionHeader } from '../section-header';

jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(), selectionAsync: jest.fn(), ImpactFeedbackStyle: { Light: 'light' } }));
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: { View, createAnimatedComponent: (c: unknown) => c },
    useAnimatedStyle: (fn: () => object) => fn(),
    useSharedValue: (value: unknown) => ({ value }),
    withSpring: (value: unknown) => value,
    useReducedMotion: () => false,
  };
});
// The swipeable as a host element, so a test can "swipe" by calling its onSwipeableOpen.
const mockClose = jest.fn();
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const { createElement, forwardRef, useImperativeHandle } = require('react');
  const Swipeable = forwardRef(function Swipeable({ children, ...props }: { children?: unknown }, ref: unknown) {
    useImperativeHandle(ref, () => ({ close: mockClose }));
    return createElement('Swipeable', props, children);
  });
  return { __esModule: true, default: Swipeable, SwipeDirection: { LEFT: 'left', RIGHT: 'right' } };
});

const onCheck = jest.fn();
const onRemove = jest.fn();
beforeEach(() => {
  onCheck.mockClear();
  onRemove.mockClear();
  mockClose.mockClear();
  jest.mocked(Haptics.impactAsync).mockClear();
  jest.mocked(Haptics.selectionAsync).mockClear();
});

function render(props: Partial<Parameters<typeof SectionHeader>[0]> = {}): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<SectionHeader title="Tacos" count={2} onSwipeCheck={onCheck} onSwipeRemove={onRemove} {...props} />);
  });
  return tree;
}
const swipe = (tree: ReactTestRenderer, direction: 'left' | 'right') =>
  act(() => tree.root.findByType('Swipeable' as never).props.onSwipeableOpen(direction));

describe('SectionHeader swipes', () => {
  test('a swipe right checks all, springs back and plays no haptic of its own', () => {
    const tree = render();
    swipe(tree, 'right');
    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(onRemove).not.toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
    expect(Haptics.selectionAsync).not.toHaveBeenCalled();
  });

  test('a swipe left removes, springs back and plays a light impact', () => {
    const tree = render();
    swipe(tree, 'left');
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onCheck).not.toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).toHaveBeenCalledWith('light');
  });

  test('with neither handler the header doesn\'t swipe', () => {
    const tree = render({ onSwipeCheck: undefined, onSwipeRemove: undefined });
    expect(tree.root.findAllByType('Swipeable' as never)).toHaveLength(0);
  });
});
