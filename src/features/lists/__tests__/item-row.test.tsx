// The list item row (spec 4.2, 4.5): tap the check to toggle, tap the row to edit, long-press to select,
// swipe right to check and left to delete; in Select mode a tap anywhere selects.
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as Haptics from 'expo-haptics';
import { StyleSheet } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { growIn } from '@/hooks/use-motion';
import { initI18n } from '@/i18n';

import { ItemRow } from '../item-row';
import type { ItemView } from '../items';

jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(), selectionAsync: jest.fn(), ImpactFeedbackStyle: { Light: 'light' } }));
// Reduce Motion, as a test sets it.
const mockMotion = { reduced: false };
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
    useReducedMotion: () => mockMotion.reduced,
    useSharedValue: (value: unknown) => ({ value }),
    useAnimatedStyle: (fn: () => object) => fn(),
    withTiming: (to: unknown) => to,
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
  familyKey: 'limes',
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
// The name's matched part, set in `onPrimarySoft` (the "already on list" label is the amount, not the name).
const highlighted = (tree: ReactTestRenderer) =>
  tree.root
    .findAll((n) => typeof n.type !== 'string' && n.props.variant === 'headline' && n.props.color === 'onPrimarySoft')
    .map((n) => n.props.children);
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

  test('a new row (spec 4.1): NEW after the name, no name line, and VoiceOver says "new"', () => {
    const tree = render({ item: item({ note: 'ripe' }), hint: 'from Chicken tacos', isNew: true });
    const badges = tree.root.findAll((n) => n.props.label === 'NEW' && typeof n.type !== 'string');
    expect(badges).toHaveLength(1);
    expect(badges[0].props.tone ?? 'positive').toBe('positive');
    // Its second line is only its own.
    expect(text(tree)).toContain('"ripe · from Chicken tacos"');
    byLabel(tree, 'Limes, new, 3, ripe, from Chicken tacos');
    // After the name.
    const json = text(tree);
    expect(json.indexOf('"Limes"')).toBeLessThan(json.indexOf('"NEW"'));
  });

  test('in Spanish the badge reads NUEVO and VoiceOver "nuevo"', () => {
    initI18n('es');
    try {
      const tree = render({ isNew: true });
      expect(text(tree)).toContain('"NUEVO"');
      byLabel(tree, 'Limes, nuevo, 3');
    } finally {
      initI18n('en');
    }
  });

  test('an item with a photo (spec 4.4): a photo glyph after the name, and VoiceOver says "has a photo"', () => {
    const tree = render({ item: item({ photoPath: 'h1/i1/p.jpg' }) });
    const glyph = hosts(tree, (n) => n.props.testID === 'photo-glyph');
    expect(glyph).toHaveLength(1);
    expect(glyph[0].props.accessible).toBe(false);
    byLabel(tree, 'Limes, has a photo, 3');
  });

  test('a photo glyph and a NEW badge both show, the glyph first', () => {
    const tree = render({ item: item({ photoPath: 'h1/i1/p.jpg' }), isNew: true });
    const json = text(tree);
    expect(json.indexOf('"Limes"')).toBeLessThan(json.indexOf('photo-glyph'));
    expect(json.indexOf('photo-glyph')).toBeLessThan(json.indexOf('"NEW"'));
    byLabel(tree, 'Limes, new, has a photo, 3');
  });

  test('no photo, a null one, or one in Spanish', () => {
    expect(hosts(render(), (n) => n.props.testID === 'photo-glyph')).toHaveLength(0);
    expect(hosts(render({ item: item({ photoPath: null }) }), (n) => n.props.testID === 'photo-glyph')).toHaveLength(0);
    initI18n('es');
    try {
      byLabel(render({ item: item({ photoPath: 'h1/i1/p.jpg' }) }), 'Limes, tiene una foto, 3');
    } finally {
      initI18n('en');
    }
  });

  test('a row with no news has no badge and its own second line only', () => {
    const tree = render({ hint: 'from Chicken tacos' });
    expect(text(tree)).not.toContain('NEW');
    expect(text(tree)).toContain('"from Chicken tacos"');
    byLabel(tree, 'Limes, 3, from Chicken tacos');
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

  test('As added: the drag owns the long-press, so holding still neither selects nor opens', () => {
    jest.mocked(Haptics.impactAsync).mockClear();
    const tree = render({ reorderable: true });
    act(() => pressable(tree, 'Limes, 3').props.onLongPress());
    expect(h.onSelect).not.toHaveBeenCalled();
    expect(h.onEdit).not.toHaveBeenCalled();
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
    // VoiceOver's Select is still there.
    act(() => byLabel(tree, 'Limes, 3').props.onAccessibilityAction({ nativeEvent: { actionName: 'select' } }));
    expect(h.onSelect).toHaveBeenCalledTimes(1);
  });

  test('As added: VoiceOver Move up / Move down come after the others and do their move', () => {
    const up = jest.fn();
    const down = jest.fn();
    const tree = render({
      reorderable: true,
      moves: [
        { name: 'moveUp', label: 'Move up', onPress: up },
        { name: 'moveDown', label: 'Move down', onPress: down },
      ],
    });
    const row = byLabel(tree, 'Limes, 3');
    expect(row.props.accessibilityActions).toEqual([
      { name: 'edit', label: 'Edit' },
      { name: 'delete', label: 'Delete' },
      { name: 'toggle', label: 'Check off' },
      { name: 'select', label: 'Select' },
      { name: 'moveUp', label: 'Move up' },
      { name: 'moveDown', label: 'Move down' },
    ]);
    act(() => row.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveDown' } }));
    expect(down).toHaveBeenCalledTimes(1);
    expect(up).not.toHaveBeenCalled();
    act(() => row.props.onAccessibilityAction({ nativeEvent: { actionName: 'moveUp' } }));
    expect(up).toHaveBeenCalledTimes(1);
    expect(h.onEdit).not.toHaveBeenCalled();
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

  test('add mode: a match says "already on list" in place of the amount and highlights the matched word', () => {
    const tree = render({ alreadyOnList: { query: 'lime' } });
    byLabel(tree, 'Limes, 3, already on list');
    expect(text(tree)).toContain('already on list');
    expect(text(tree)).not.toContain('"3"');
    expect(highlighted(tree)).toEqual(['Limes']);
  });

  test('add mode: a match whose words the name lacks still says "already on list", with no highlight', () => {
    const tree = render({ alreadyOnList: { query: 'key lime' } });
    byLabel(tree, 'Limes, 3, already on list');
    expect(text(tree)).toContain('"Limes"');
    expect(highlighted(tree)).toEqual([]);
  });
});

describe('an arrival and its NEW badge (spec 4.1)', () => {
  beforeEach(() => {
    mockMotion.reduced = false;
  });

  /** The row's outer animated view, which carries its entering animation. */
  const outer = (tree: ReactTestRenderer) => tree.root.findAll((n) => typeof n.type === 'string' && 'entering' in n.props)[0];
  const badge = (tree: ReactTestRenderer) => hosts(tree, (n) => n.props.testID === 'new-badge');

  test('a new row grows into place, clipped while it opens', () => {
    const tree = render({ grow: true, isNew: true });
    expect(outer(tree).props.entering).toBe(growIn);
    expect(StyleSheet.flatten(outer(tree).props.style)).toEqual({ overflow: 'hidden' });
  });

  test('under Reduce Motion it appears without growing', () => {
    mockMotion.reduced = true;
    const tree = render({ grow: true, isNew: true });
    expect(outer(tree).props.entering).toBeDefined();
    expect(outer(tree).props.entering).not.toBe(growIn);
  });

  test("a Combine into a row already there doesn't grow", () => {
    const tree = render({ grow: false, isNew: true });
    expect(outer(tree).props.entering).not.toBe(growIn);
    expect(outer(tree).props.style).toBeUndefined();
  });

  test('no flash and no name tag: the row keeps its own tint, and only the badge says it is new', () => {
    const tree = render({ grow: true, isNew: true, look: { tint: '#DDEFE2' } as never });
    expect(hosts(tree, (n) => n.props.testID === 'arrival-flash' || n.props.testID === 'arrival-tag')).toHaveLength(0);
    expect(hosts(tree, (n) => StyleSheet.flatten(n.props.style)?.backgroundColor === '#FFF7E6')).toHaveLength(0);
    expect(hosts(tree, (n) => StyleSheet.flatten(n.props.style)?.backgroundColor === '#DDEFE2').length).toBeGreaterThan(0);
    expect(badge(tree)).toHaveLength(1);
    byLabel(tree, 'Limes, new, 3');
  });

  test('the badge fades out as it goes, or just goes under Reduce Motion', () => {
    const faded = render({ isNew: true });
    expect(badge(faded)[0].props.exiting).toBeDefined();
    mockMotion.reduced = true;
    const still = render({ isNew: true });
    expect(badge(still)[0].props.exiting).toBeUndefined();
  });

  test('once the badge goes, VoiceOver no longer says "new"', () => {
    const tree = render({ isNew: true });
    act(() => tree.update(<ItemRow item={item()} background="#fff" {...h} isNew={false} />));
    expect(badge(tree)).toHaveLength(0);
    byLabel(tree, 'Limes, 3');
  });

  test('not new: no badge, the usual entering', () => {
    const tree = render();
    expect(badge(tree)).toHaveLength(0);
    expect(outer(tree).props.entering).not.toBe(growIn);
  });

  test("a new row's view and its layouts go to the list, so it can tell when the row is in sight", () => {
    const newRef = jest.fn();
    const onNewLayout = jest.fn();
    const tree = render({ isNew: true, newRef, onNewLayout });
    expect(newRef).toHaveBeenCalled();
    const laidOut = hosts(tree, (n) => n.props.onLayout === onNewLayout);
    expect(laidOut).toHaveLength(1);
    act(() => laidOut[0].props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 50 } } }));
    expect(onNewLayout).toHaveBeenCalledTimes(1);
  });
});
