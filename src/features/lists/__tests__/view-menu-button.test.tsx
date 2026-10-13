// The list's view button (spec 4.6): reads the current view and opens a menu of the three, the current one ticked.
import { describe, expect, jest, test } from '@jest/globals';
import { StyleSheet } from 'react-native';
import { act, create, type ReactTestRenderer,type ReactTestRendererJSON } from 'react-test-renderer';

import { ViewMenuButton } from '../view-menu-button';

jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
// SwiftUI views as host elements; modifiers as plain records.
jest.mock('@expo/ui/swift-ui', () => {
  const { createElement } = require('react');
  const host = (type: string) =>
    function Host({ children, ...props }: { children?: unknown }) {
      return createElement(type, props, children);
    };
  return {
    Host: host('SwiftHost'),
    Menu: ({ label, children, ...props }: { label?: unknown; children?: unknown }) =>
      createElement('SwiftMenu', props, label, children),
    RNHostView: host('RNHostView'),
    Section: host('SwiftSection'),
    Button: host('SwiftButton'),
    Toggle: host('SwiftToggle'),
  };
});
jest.mock('@expo/ui/swift-ui/modifiers', () => ({
  accessibilityLabel: (value: string) => ({ accessibilityLabel: value }),
  accessibilityHint: (value: string) => ({ accessibilityHint: value }),
  disabled: (value: boolean) => ({ disabled: value }),
}));

function render(value: 'newest' | 'category' | 'recipe') {
  const onChange = jest.fn();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(<ViewMenuButton value={value} onChange={onChange} />);
  });
  const toggles = tree.root.findAll((n) => n.type === ('SwiftToggle' as never));
  return { tree, onChange, toggles };
}

describe('ViewMenuButton', () => {
  test('the pill reads the current view, and VoiceOver hears "View: …" with a hint', () => {
    const { tree } = render('category');
    expect(JSON.stringify(tree.toJSON())).toContain('"By aisle"');
    const menu = tree.root.find((n) => n.type === ('SwiftMenu' as never));
    expect(menu.props.modifiers).toEqual([
      { accessibilityLabel: 'View: By aisle' },
      { accessibilityHint: 'Changes how the list is grouped' },
    ]);
  });

  test('the menu lists the three views in order, the current one ticked', () => {
    const { toggles } = render('recipe');
    expect(toggles.map((t) => [t.props.label, t.props.isOn])).toEqual([
      ['As added', false],
      ['By aisle', false],
      ['By recipe', true],
    ]);
  });

  test('the pill lays out at its own height, centred in the row, with a 44 pt tap area', () => {
    const { tree } = render('newest');
    const first = (node: ReactTestRendererJSON) => node.children![0] as ReactTestRendererJSON;
    // View > Host > Menu > RNHostView > face (the 44 pt tap area) > pill.
    const root = tree.toJSON() as ReactTestRendererJSON;
    const label = first(first(first(root)));
    expect(label.type).toBe('RNHostView');
    const outer = StyleSheet.flatten(root.props.style);
    // Not pinned to the row's top, so the row's `alignItems: 'center'` lines it up with "N to get".
    expect(outer.alignSelf).toBeUndefined();
    expect(outer.marginVertical).toBe(-6);
    const face = first(label);
    const faceStyle = StyleSheet.flatten(face.props.style);
    expect(faceStyle.paddingVertical).toBe(6);
    expect(faceStyle.minHeight).toBeUndefined();
    const pill = StyleSheet.flatten(first(face).props.style);
    expect(pill.minHeight).toBe(32);
    expect(pill.height).toBeUndefined();
    // Tap area: the pill plus the padding on both sides; layout: that minus the margin taken back.
    expect(pill.minHeight + 2 * faceStyle.paddingVertical).toBe(44);
    expect(pill.minHeight + 2 * faceStyle.paddingVertical + 2 * outer.marginVertical).toBe(32);
  });

  test('picking a view reports it', () => {
    const { toggles, onChange } = render('newest');
    act(() => toggles[1].props.onIsOnChange(true));
    expect(onChange).toHaveBeenCalledWith('category');
    act(() => toggles[0].props.onIsOnChange(false));
    expect(onChange).toHaveBeenLastCalledWith('newest');
  });

  test('with fold actions, Collapse all and Expand all follow the views in their own group', () => {
    const fold = { canCollapse: true, canExpand: false, onCollapseAll: jest.fn(), onExpandAll: jest.fn() };
    let tree!: ReactTestRenderer;
    act(() => {
      tree = create(<ViewMenuButton value="category" onChange={() => {}} fold={fold} />);
    });
    const buttons = tree.root.find((n) => n.type === ('SwiftSection' as never)).findAll((n) => n.type === ('SwiftButton' as never));
    expect(buttons.map((b) => [b.props.label, b.props.modifiers])).toEqual([
      ['Collapse all', [{ disabled: false }]],
      ['Expand all', [{ disabled: true }]],
    ]);
    act(() => buttons[0].props.onPress());
    expect(fold.onCollapseAll).toHaveBeenCalled();
  });

  test('without them, no second group', () => {
    const { tree } = render('newest');
    expect(tree.root.findAll((n) => n.type === ('SwiftSection' as never))).toHaveLength(0);
  });
});
