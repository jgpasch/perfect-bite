// A section header's swipes (spec 4.6): right checks all, left removes. Checking's haptic is the check-off
// tick its `onCheck` plays (spec 4.1), so the header doesn't add its own; removing plays a light impact.
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as Haptics from 'expo-haptics';
import { StyleSheet, Text, View } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { Spacing } from '@/constants/theme';

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
jest.mock('@/hooks/use-motion', () => ({ useMotion: () => ({ reduceMotion: true }) }));
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

// Room between the title-and-count group and a trailing control (spec 4.5), and what gives way at large text sizes.
describe('SectionHeader with a count and a trailing control', () => {
  const stepper = <View testID="stepper" />;
  const flat = (node: ReactTestInstance) => StyleSheet.flatten(node.props.style) ?? {};
  const hostViews = (tree: ReactTestRenderer) => tree.root.findAll((n) => (n.type as unknown) === 'View');
  const texts = (node: ReactTestInstance, value: string | number) =>
    node.findAll((n) => n.type === Text && n.props.children === value);
  // The nearest host View above `node`.
  const hostAbove = (node: ReactTestInstance) => {
    let at = node.parent;
    while (at && (at.type as unknown) !== 'View') at = at.parent;
    return at!;
  };
  // The host View holding the trailing control, and the row it sits in.
  const trailingSlot = (tree: ReactTestRenderer) => {
    const slot = hostAbove(hostViews(tree).find((v) => v.props.testID === 'stepper')!);
    return { slot, row: hostAbove(slot) };
  };
  const plain = { onSwipeCheck: undefined, onSwipeRemove: undefined };

  test.each([
    ['plain', {}],
    ['folding', { onToggle: () => {}, collapsed: false }],
  ])('a %s header puts md between the title and count and the trailing control', (_, extra) => {
    const tree = render({ title: 'Ingredients', count: 9, trailing: stepper, ...plain, ...extra });
    const { row } = trailingSlot(tree);
    expect(flat(row).gap).toBe(Spacing.md);
    // The trailing control comes last, straight after the part holding the title and the count.
    const kids = row.children.filter((c): c is ReactTestInstance => typeof c !== 'string');
    expect(kids).toHaveLength(2);
    expect(kids[1].findAll((n) => n.props.testID === 'stepper').length).toBeGreaterThan(0);
    const group = kids[0];
    expect(texts(group, 'Ingredients')).toHaveLength(1);
    expect(texts(group, 9)).toHaveLength(1);
  });

  test('at the largest text size the title wraps and the stepper stays whole', () => {
    const title = 'Ingredients for a very large batch';
    const tree = render({ title, count: 9, trailing: stepper, ...plain });
    const [titleText] = texts(tree.root, title);
    expect(flat(titleText)).toMatchObject({ flex: 1, flexShrink: 1 });
    expect(titleText.props.numberOfLines).toBeUndefined();
    expect(flat(texts(tree.root, 9)[0]).flexShrink).toBe(0);
    expect(flat(trailingSlot(tree).slot).flexShrink).toBe(0);
    // The title's group can shrink below its content's width, so the title wraps instead of pushing the stepper out.
    const group = hostViews(tree).find((v) => flat(v).minWidth === 0)!;
    expect(flat(group).flex).toBe(1);
    expect(texts(group, title)).toHaveLength(1);
    expect(group.findAll((n) => n.props.testID === 'stepper')).toHaveLength(0);
  });

  test('a hidden count leaves the title alone in the group, still md from the trailing control', () => {
    const tree = render({ title: 'Method', count: 4, hideCount: true, trailing: stepper, ...plain });
    expect(texts(tree.root, 4)).toHaveLength(0);
    expect(flat(trailingSlot(tree).row).gap).toBe(Spacing.md);
  });

  test('without a trailing control the count still shows and nothing is held for one', () => {
    const tree = render({ title: 'Produce', count: 3, ...plain });
    expect(texts(tree.root, 3)).toHaveLength(1);
    expect(hostViews(tree).filter((v) => flat(v).flexShrink === 0)).toHaveLength(0);
  });
});
