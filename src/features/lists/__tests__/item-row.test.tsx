// The list item row (spec 4.2, 4.5): tap the check to toggle, tap the row to edit, long-press to select,
// swipe right to check and left to delete; in Select mode a tap anywhere selects.
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as Haptics from 'expo-haptics';
import { StyleSheet } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { ItemRow } from '../item-row';
import type { ItemView } from '../items';

jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(), selectionAsync: jest.fn(), ImpactFeedbackStyle: { Light: 'light' } }));
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const builder: object = new Proxy({}, { get: () => () => builder });
  return {
    __esModule: true,
    default: { View, createAnimatedComponent: (c: unknown) => c },
    FadeIn: builder,
    FadeInDown: builder,
    FadeOut: builder,
    LinearTransition: builder,
    useReducedMotion: () => false,
  };
});
// The swipeable as a host element, so a test can "swipe" by calling its onSwipeableOpen.
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const { createElement, forwardRef, useImperativeHandle } = require('react');
  const Swipeable = forwardRef(function Swipeable(
    { children, ...props }: { children?: unknown },
    ref: unknown,
  ) {
    useImperativeHandle(ref, () => ({ close: () => {} }));
    return createElement('Swipeable', props, children);
  });
  return { __esModule: true, default: Swipeable, SwipeDirection: { LEFT: 'left', RIGHT: 'right' } };
});

const item = (over: Partial<ItemView> = {}): ItemView => ({
  id: 'i1',
  ingredientName: 'limes',
  categoryId: 'produce',
  displayName: 'limes',
  note: null,
  checkedAt: null,
  createdAt: new Date(0),
  amounts: [],
  usualUnit: null,
  amountText: '3',
  contributions: [],
  ...over,
});

const handlers = () => ({ onToggle: jest.fn(), onDelete: jest.fn(), onEdit: jest.fn(), onSelect: jest.fn() });
let h = handlers();
beforeEach(() => {
  h = handlers();
});

function render(props: Partial<Parameters<typeof ItemRow>[0]> = {}): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<ItemRow item={item()} background="#fff" {...h} {...props} />);
  });
  return tree;
}

/** Host elements only, so each Pressable is found once. */
const hosts = (tree: ReactTestRenderer, pred: (n: ReactTestInstance) => boolean) =>
  tree.root.findAll((n) => typeof n.type === 'string' && pred(n));
const byLabel = (tree: ReactTestRenderer, label: string) => {
  const found = hosts(tree, (n) => n.props.accessibilityLabel === label);
  expect(found).toHaveLength(1);
  return found[0];
};
/** The Pressable itself (its host element doesn't carry onLongPress). */
const pressable = (tree: ReactTestRenderer, label: string) =>
  tree.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === label && 'onPress' in n.props);
const text = (tree: ReactTestRenderer) => JSON.stringify(tree.toJSON());
const swipeable = (tree: ReactTestRenderer) => tree.root.findByType('Swipeable' as never);

describe('ItemRow', () => {
  test('shows the name in sentence case and the amount; VoiceOver reads both', () => {
    const tree = render();
    expect(text(tree)).toContain('"Limes"');
    expect(text(tree)).toContain('"3"');
    byLabel(tree, 'Limes, 3');
  });

  test('a note and a hint go on a second line, joined', () => {
    const tree = render({ item: item({ note: 'ripe' }), hint: 'Also in Tacos' });
    expect(text(tree)).toContain('ripe · Also in Tacos');
    byLabel(tree, 'Limes, 3, ripe, Also in Tacos');
  });

  test('amountText overrides the item total (By recipe shows one recipe\'s share)', () => {
    const tree = render({ amountText: '1' });
    expect(text(tree)).not.toContain('"3"');
    byLabel(tree, 'Limes, 1');
  });

  test('tapping the check toggles it; tapping the row opens its details', () => {
    const tree = render();
    act(() => byLabel(tree, 'Check off Limes').props.onClick());
    expect(h.onToggle).toHaveBeenCalledTimes(1);
    act(() => byLabel(tree, 'Limes, 3').props.onClick());
    expect(h.onEdit).toHaveBeenCalledTimes(1);
    expect(h.onDelete).not.toHaveBeenCalled();
  });

  test('a checked row is struck through, and its check says so', () => {
    const tree = render({ item: item({ checkedAt: new Date() }) });
    const check = byLabel(tree, 'Check off Limes');
    expect(check.props.accessibilityState).toEqual({ checked: true });
    const name = hosts(tree, (n) => n.type === ('Text' as never) && n.props.children === 'Limes')[0];
    expect(StyleSheet.flatten(name.props.style)).toMatchObject({ textDecorationLine: 'line-through' });
  });

  test('swiping right toggles the check, swiping left deletes', () => {
    const tree = render();
    act(() => swipeable(tree).props.onSwipeableOpen('right'));
    expect(h.onToggle).toHaveBeenCalledTimes(1);
    expect(h.onDelete).not.toHaveBeenCalled();
    act(() => swipeable(tree).props.onSwipeableOpen('left'));
    expect(h.onDelete).toHaveBeenCalledTimes(1);
    expect(h.onToggle).toHaveBeenCalledTimes(1);
  });

  test('a tap or swipe to check plays no haptic of its own: the screen\'s onToggle plays the tick (spec 4.1)', () => {
    jest.mocked(Haptics.selectionAsync).mockClear();
    jest.mocked(Haptics.impactAsync).mockClear();
    const tree = render();
    act(() => byLabel(tree, 'Check off Limes').props.onClick());
    act(() => swipeable(tree).props.onSwipeableOpen('right'));
    expect(h.onToggle).toHaveBeenCalledTimes(2);
    expect(Haptics.selectionAsync).not.toHaveBeenCalled();
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
  });

  test('long-press starts selecting with this item', () => {
    const tree = render();
    act(() => pressable(tree, 'Limes, 3').props.onLongPress());
    expect(h.onSelect).toHaveBeenCalledTimes(1);
  });

  test('VoiceOver actions edit, delete, toggle and select', () => {
    const tree = render();
    const row = byLabel(tree, 'Limes, 3');
    expect(row.props.accessibilityActions.map((a: { label: string }) => a.label)).toEqual([
      'Edit',
      'Delete',
      'Check off',
      'Select',
    ]);
    for (const actionName of ['edit', 'delete', 'toggle', 'select']) {
      act(() => row.props.onAccessibilityAction({ nativeEvent: { actionName } }));
    }
    expect(h.onEdit).toHaveBeenCalledTimes(1);
    expect(h.onDelete).toHaveBeenCalledTimes(1);
    expect(h.onToggle).toHaveBeenCalledTimes(1);
    expect(h.onSelect).toHaveBeenCalledTimes(1);
  });

  test('a checked row offers Uncheck; without onSelect there is no Select action or long-press', () => {
    const tree = render({ item: item({ checkedAt: new Date() }), onSelect: undefined });
    const row = byLabel(tree, 'Limes, 3');
    expect(row.props.accessibilityActions.map((a: { label: string }) => a.label)).toEqual(['Edit', 'Delete', 'Uncheck']);
    expect(pressable(tree, 'Limes, 3').props.onLongPress).toBeUndefined();
  });

  test('Select mode: the whole row is a checkbox showing the selection, and swiping is off', () => {
    const tree = render({ selected: true });
    const row = byLabel(tree, 'Limes, 3');
    expect(row.props.accessibilityRole).toBe('checkbox');
    expect(row.props.accessibilityState).toEqual({ checked: true });
    expect(swipeable(tree).props.enabled).toBe(false);
    act(() => row.props.onClick());
    expect(h.onToggle).toHaveBeenCalledTimes(1);
    expect(h.onEdit).not.toHaveBeenCalled();
    // The check itself isn't a separate button while selecting.
    expect(hosts(tree, (n) => n.props.accessibilityLabel === 'Check off Limes')).toHaveLength(0);
  });

  test('an unselected row in Select mode reads unchecked even when the item is checked', () => {
    const tree = render({ selected: false, item: item({ checkedAt: new Date() }) });
    expect(byLabel(tree, 'Limes, 3').props.accessibilityState).toEqual({ checked: false });
  });

  test('Sorting…: the label shows while unchecked and VoiceOver reads it instead of the aisle', () => {
    const tree = render({ sorting: true, aisle: { name: 'Produce' } });
    expect(text(tree)).toContain('Sorting…');
    expect(hosts(tree, (n) => typeof n.props.accessibilityLabel === 'string' && n.props.accessibilityLabel.startsWith('Limes, 3, '))[0]
      .props.accessibilityLabel).not.toContain('Produce');
  });

  test('a checked row no longer says Sorting…', () => {
    const tree = render({ sorting: true, item: item({ checkedAt: new Date() }) });
    expect(text(tree)).not.toContain('Sorting…');
  });

  test('As added reads the aisle name', () => {
    const tree = render({ aisle: { name: 'Produce' } });
    byLabel(tree, 'Limes, 3, Produce');
  });

  test('add mode: a match says "already on list" in place of the amount and highlights the typed part', () => {
    const tree = render({ alreadyOnList: { typed: 'lim' } });
    byLabel(tree, 'Limes, 3, already on list');
    expect(text(tree)).toContain('already on list');
    expect(text(tree)).not.toContain('"3"');
    expect(text(tree)).toContain('"Lim"');
  });
});
