// The list's view button (spec 4.6): reads the current view and opens a menu of the three, the current one ticked.
import { describe, expect, jest, test } from '@jest/globals';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

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
    Toggle: host('SwiftToggle'),
  };
});
jest.mock('@expo/ui/swift-ui/modifiers', () => ({
  accessibilityLabel: (value: string) => ({ accessibilityLabel: value }),
  accessibilityHint: (value: string) => ({ accessibilityHint: value }),
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

  test('picking a view reports it', () => {
    const { toggles, onChange } = render('newest');
    act(() => toggles[1].props.onIsOnChange(true));
    expect(onChange).toHaveBeenCalledWith('category');
    act(() => toggles[0].props.onIsOnChange(false));
    expect(onChange).toHaveBeenLastCalledWith('newest');
  });
});
