// The tab bar (spec 4.1): the tabs in a pill, a hidden tab left out, a badge, and the round + apart on the right.
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { StyleSheet } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { Sizes, Spacing } from '@/constants/theme';

import { TabBar } from '../tab-bar';

jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }) }));
// The + hint's fade and ripple.
let mockReduceMotion = false;
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const value = (v: unknown) => v;
  return {
    __esModule: true,
    default: { View },
    FadeIn: {},
    FadeOut: {},
    Easing: { out: value, quad: value },
    cancelAnimation: () => {},
    useAnimatedStyle: (style: () => object) => style(),
    useReducedMotion: () => mockReduceMotion,
    useSharedValue: (v: unknown) => ({ value: v }),
    withDelay: (_: number, v: unknown) => v,
    withRepeat: value,
    withTiming: value,
  };
});
// SwiftUI views as host elements.
jest.mock('@expo/ui/swift-ui', () => {
  const { createElement } = require('react');
  const host = (type: string) =>
    function Host({ children, ...props }: { children?: unknown }) {
      return createElement(type, props, children);
    };
  return {
    Button: host('SwiftButton'),
    ContextMenu: Object.assign(host('SwiftContextMenu'), {
      Items: host('SwiftContextMenuItems'),
      Trigger: host('SwiftContextMenuTrigger'),
    }),
    Host: host('SwiftHost'),
    RNHostView: host('RNHostView'),
  };
});

let tree: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  mockReduceMotion = false;
});

const routes = [
  { key: 'lists-1', name: 'lists', title: 'List' },
  { key: 'recipes-1', name: 'recipes', title: 'Recipes', badge: 2 },
  { key: 'plan-1', name: 'plan', title: 'Plan', hidden: true },
  { key: 'settings-1', name: 'settings', title: 'Settings' },
];

function render(index = 0, addHint?: string | null) {
  const navigation = { emit: jest.fn(() => ({ defaultPrevented: false })), navigate: jest.fn() };
  const onAdd = jest.fn();
  const onAddLongPress = jest.fn();
  const onAddMore = jest.fn();
  const addMenu = [
    { key: 'item', label: 'Add item', icon: 'plus' as const, onPress: jest.fn() },
    { key: 'recipe', label: 'Add recipe', icon: 'book' as const, onPress: jest.fn() },
  ];
  const props = {
    state: { index, routes: routes.map(({ key, name }) => ({ key, name, params: undefined })) },
    descriptors: Object.fromEntries(
      routes.map((r) => [
        r.key,
        { options: { title: r.title, tabBarBadge: r.badge, tabBarItemStyle: r.hidden ? { display: 'none' } : undefined } },
      ]),
    ),
    navigation,
  } as unknown as BottomTabBarProps;
  act(() => {
    tree = create(
      <TabBar
        {...props}
        onAdd={onAdd}
        addLabel="Add"
        onAddLongPress={onAddLongPress}
        addMenu={addMenu}
        addMoreLabel="More ways to add"
        onAddMore={onAddMore}
        addHint={addHint}
      />,
    );
  });
  return { navigation, onAdd, onAddLongPress, onAddMore, addMenu };
}

const tabs = () => tree!.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'tab' && 'onPress' in n.props);
const hint = () => tree!.root.findAll((n) => typeof n.type === 'string' && n.props.testID === 'tab-add-hint');
const add = () => tree!.root.find((n) => typeof n.type !== 'string' && n.props.accessibilityLabel === 'Add' && 'onPress' in n.props);

describe('TabBar', () => {
  it('shows the tabs in order, a hidden one left out, the focused one selected and the badge read out', () => {
    render();
    expect(tabs().map((n) => n.props.accessibilityLabel)).toEqual(['List', 'Recipes, 2', 'Settings']);
    expect(tabs().map((n) => n.props.accessibilityState.selected)).toEqual([true, false, false]);
  });

  it('a tap on another tab navigates to it; on the focused one it only emits tabPress', () => {
    const { navigation } = render();
    act(() => tabs()[1].props.onPress());
    expect(navigation.navigate).toHaveBeenCalledWith('recipes', undefined);
    act(() => tabs()[0].props.onPress());
    expect(navigation.navigate).toHaveBeenCalledTimes(1);
    expect(navigation.emit).toHaveBeenCalledWith({ type: 'tabPress', target: 'lists-1', canPreventDefault: true });
  });

  it('the + is a button of its own', () => {
    const { onAdd } = render();
    const plus: ReactTestInstance = add();
    expect(plus.props.accessibilityRole).toBe('button');
    act(() => plus.props.onPress());
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('a long-press on + calls its handler (the haptic) and not onAdd', () => {
    const { onAdd, onAddLongPress } = render();
    act(() => add().props.onLongPress());
    expect(onAddLongPress).toHaveBeenCalledTimes(1);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('the + is the trigger of a native context menu holding the items, in order, with their icons', () => {
    const { addMenu, onAdd } = render();
    const menu = tree!.root.findByType('SwiftContextMenu' as never);
    const trigger = menu.findByType('SwiftContextMenuTrigger' as never);
    expect(trigger.findAll((n) => n === add())).toHaveLength(1);
    const items = menu.findByType('SwiftContextMenuItems' as never).findAllByType('SwiftButton' as never);
    expect(items.map((n) => [n.props.label, n.props.systemImage])).toEqual([
      ['Add item', 'plus'],
      ['Add recipe', 'book'],
    ]);
    act(() => items[1].props.onPress());
    expect(addMenu[1].onPress).toHaveBeenCalledTimes(1);
    expect(addMenu[0].onPress).not.toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('VoiceOver gets "More ways to add" as a custom action on +', () => {
    const { onAddMore, onAdd } = render();
    expect(add().props.accessibilityActions).toEqual([{ name: 'more', label: 'More ways to add' }]);
    act(() => add().props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } }));
    expect(onAddMore).not.toHaveBeenCalled();
    act(() => add().props.onAccessibilityAction({ nativeEvent: { actionName: 'more' } }));
    expect(onAddMore).toHaveBeenCalledTimes(1);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('no + hint unless given one', () => {
    render();
    expect(hint()).toHaveLength(0);
    act(() => tree!.unmount());
    render(0, null);
    expect(hint()).toHaveLength(0);
  });

  it('the + hint: a pill left of +, level with it, a ghost of the menu above, and nothing takes touches', () => {
    render(0, 'Press and hold');
    const [pill] = hint();
    expect(pill.findAll((n) => n.type === ('Text' as never)).map((n) => n.props.children)).toContain('Press and hold');
    // Past its own component, the row that lines it up with +.
    const row = StyleSheet.flatten(pill.parent!.parent!.props.style);
    expect(row).toEqual(
      expect.objectContaining({ right: Spacing.lg + Sizes.tabBar + Spacing.md, bottom: 34, height: Sizes.tabBar }),
    );
    const layer = tree!.root.find((n) => typeof n.type === 'string' && n.props.pointerEvents === 'none');
    const labels = layer.findAll((n) => n.type === ('Text' as never)).map((n) => n.props.children);
    expect(labels).toEqual(['Add item', 'Add recipe', 'Press and hold']);
  });

  it('the + hint: two rings ripple out from +, or one holds still under Reduce Motion', () => {
    const rings = () =>
      tree!.root.findAll(
        (n) => typeof n.type === 'string' && StyleSheet.flatten(n.props.style)?.borderWidth === Sizes.focusRing,
      );
    render(0, 'Press and hold');
    expect(rings()).toHaveLength(2);
    act(() => tree!.unmount());
    mockReduceMotion = true;
    render(0, 'Press and hold');
    expect(rings()).toHaveLength(1);
  });
});
