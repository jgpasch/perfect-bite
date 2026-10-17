// The tab bar (spec 4.1): the tabs in a pill, a hidden tab left out, a badge, and the round + apart on the right.
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { BottomTabBarProps } from 'expo-router/tabs';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { TabBar } from '../tab-bar';

jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }) }));

let tree: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

const routes = [
  { key: 'lists-1', name: 'lists', title: 'List' },
  { key: 'recipes-1', name: 'recipes', title: 'Recipes', badge: 2 },
  { key: 'plan-1', name: 'plan', title: 'Plan', hidden: true },
  { key: 'settings-1', name: 'settings', title: 'Settings' },
];

function render(index = 0) {
  const navigation = { emit: jest.fn(() => ({ defaultPrevented: false })), navigate: jest.fn() };
  const onAdd = jest.fn();
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
    tree = create(<TabBar {...props} onAdd={onAdd} addLabel="Add" />);
  });
  return { navigation, onAdd };
}

const tabs = () => tree!.root.findAll((n) => typeof n.type !== 'string' && n.props.accessibilityRole === 'tab' && 'onPress' in n.props);
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
});
