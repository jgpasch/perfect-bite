// Shared controls: each is a labelled button (or tab / checkbox) that fires when pressed and not
// when disabled, and reports its state to VoiceOver.
import { describe, expect, it, jest } from '@jest/globals';
import type { ReactElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { Button, PrimaryButton, SoftDangerButton, SurfaceButton } from '../button';
import { CheckCircle } from '../check-circle';
import { Pill } from '../pill';
import { SegmentedControl } from '../segmented-control';
import { SettingsRow, SettingsSection } from '../settings-group';

jest.mock('@/global.css', () => ({}));
// Icons render as host elements so a test can see which glyph shows.
jest.mock('@/components/icon', () => {
  const { createElement } = require('react');
  return { Icon: ({ name }: { name: string }) => createElement('Icon', { name }) };
});

function render(element: ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(element);
  });
  return tree;
}

/** Host views with this role, in order. */
const byRole = (root: ReactTestRenderer, role: string) =>
  root.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === role);
/** A tap as the responder system delivers it: ignored while disabled. */
const click = (n: ReactTestInstance) => act(() => n.props.onClick({ nativeEvent: {} }));
const icons = (root: ReactTestRenderer) => root.root.findAll((n) => (n.type as string) === 'Icon').map((n) => n.props.name);

describe.each([
  ['PrimaryButton', PrimaryButton],
  ['SurfaceButton', SurfaceButton],
  ['SoftDangerButton', SoftDangerButton],
  ['Button', Button],
] as [string, typeof SoftDangerButton][])('%s', (_, Component) => {
  it('is a button named by its label that fires on press', () => {
    const onPress = jest.fn();
    const root = render(<Component label="Save" onPress={onPress} />);
    const [button] = byRole(root, 'button');
    expect(button.props.accessibilityLabel).toBe('Save');
    expect(button.props.accessibilityState).toEqual(expect.objectContaining({ disabled: false }));
    click(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('when disabled, says so and ignores presses', () => {
    const onPress = jest.fn();
    const root = render(<Component label="Save" onPress={onPress} disabled />);
    const [button] = byRole(root, 'button');
    expect(button.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    click(button);
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('PrimaryButton and SurfaceButton icons', () => {
  it('show the leading icon only when given one', () => {
    expect(icons(render(<PrimaryButton label="Sync now" icon="arrow.triangle.2.circlepath" />))).toEqual([
      'arrow.triangle.2.circlepath',
    ]);
    expect(icons(render(<SurfaceButton label="Send code" icon="envelope" />))).toEqual(['envelope']);
    expect(icons(render(<PrimaryButton label="Done" />))).toEqual([]);
  });
});

describe('Pill', () => {
  it('reports selected and fires on press', () => {
    const onPress = jest.fn();
    const root = render(<Pill label="Produce" selected onPress={onPress} />);
    const [pill] = byRole(root, 'button');
    expect(pill.props.accessibilityLabel).toBe('Produce');
    expect(pill.props.accessibilityState).toEqual(expect.objectContaining({ selected: true, disabled: false }));
    click(pill);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('defaults to not selected, and ignores presses when disabled', () => {
    const onPress = jest.fn();
    const root = render(<Pill label="+ New" dashed disabled onPress={onPress} />);
    const [pill] = byRole(root, 'button');
    expect(pill.props.accessibilityState).toEqual(expect.objectContaining({ selected: false, disabled: true }));
    click(pill);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('merges extra accessibility state from the caller', () => {
    const root = render(<Pill label="Produce" accessibilityState={{ checked: true }} />);
    expect(byRole(root, 'button')[0].props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false, checked: true }),
    );
  });
});

describe('SegmentedControl', () => {
  const segments = [
    { value: 'aisle', label: 'By aisle', hint: 'Groups items by aisle' },
    { value: 'recipe', label: 'By recipe' },
    { value: 'newest', label: 'As added' },
  ] as const;

  it('is a tab list with one selected tab per segment', () => {
    const root = render(<SegmentedControl segments={segments} value="recipe" onChange={() => {}} />);
    expect(byRole(root, 'tablist')).toHaveLength(1);
    const tabs = byRole(root, 'tab');
    expect(tabs.map((t) => t.props.accessibilityLabel)).toEqual(['By aisle', 'By recipe', 'As added']);
    expect(tabs.map((t) => t.props.accessibilityState.selected)).toEqual([false, true, false]);
    expect(tabs[0].props.accessibilityHint).toBe('Groups items by aisle');
  });

  it('calls onChange with a different segment, and not for the selected one', () => {
    const onChange = jest.fn();
    const root = render(<SegmentedControl segments={segments} value="aisle" onChange={onChange} />);
    const tabs = byRole(root, 'tab');
    click(tabs[0]);
    expect(onChange).not.toHaveBeenCalled();
    click(tabs[2]);
    expect(onChange).toHaveBeenCalledWith('newest');
  });
});

describe('CheckCircle', () => {
  it('with onPress, is a checkbox that reports checked and fires', () => {
    const onPress = jest.fn();
    const root = render(<CheckCircle checked onPress={onPress} accessibilityLabel="Milk" />);
    const [box] = byRole(root, 'checkbox');
    expect(box.props.accessibilityLabel).toBe('Milk');
    expect(box.props.accessibilityState).toEqual(expect.objectContaining({ checked: true }));
    click(box);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('without onPress, is hidden from VoiceOver (the row is the checkbox)', () => {
    const root = render(<CheckCircle checked={false} />);
    expect(byRole(root, 'checkbox')).toHaveLength(0);
    const host = root.root.findAll((n) => typeof n.type === 'string' && n.props.importantForAccessibility);
    expect(host[0].props).toEqual(expect.objectContaining({ accessible: false, importantForAccessibility: 'no-hide-descendants' }));
  });

  it('shows the tick only when checked', () => {
    expect(icons(render(<CheckCircle checked />))).toEqual(['checkmark']);
    expect(icons(render(<CheckCircle checked={false} />))).toEqual([]);
    expect(icons(render(<CheckCircle checked={false} pending />))).toEqual([]);
  });
});

describe('SettingsSection', () => {
  it('labels its card with a header', () => {
    const root = render(
      <SettingsSection title="Shopping">
        <SettingsRow label="Aisle order" />
      </SettingsSection>,
    );
    const [header] = byRole(root, 'header');
    expect(header.props.children).toBe('Shopping');
  });
});

describe('SettingsRow', () => {
  it('with onPress, is a button with a chevron, read as label, detail and value', () => {
    const onPress = jest.fn();
    const root = render(<SettingsRow label="Siri adds to" detail="Default list" value="Groceries" onPress={onPress} />);
    const [row] = byRole(root, 'button');
    expect(row.props.accessibilityLabel).toBe('Siri adds to, Default list, Groceries');
    expect(row.props.accessibilityState?.selected).toBeUndefined();
    expect(icons(root)).toEqual(['chevron.right']);
    click(row);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('can leave the chevron off', () => {
    const root = render(<SettingsRow label="Leave household" chevron={false} onPress={() => {}} />);
    expect(icons(root)).toEqual([]);
  });

  it('prefers an explicit accessibility label and passes the hint', () => {
    const root = render(
      <SettingsRow label="Jo" accessibilityLabel="Jo, Owner" accessibilityHint="Shows actions" onPress={() => {}} />,
    );
    const [row] = byRole(root, 'button');
    expect(row.props.accessibilityLabel).toBe('Jo, Owner');
    expect(row.props.accessibilityHint).toBe('Shows actions');
  });

  it('as a picker choice, reports selected, ticks when chosen and has no chevron', () => {
    const chosen = render(<SettingsRow label="Whole row" selected onPress={() => {}} />);
    expect(byRole(chosen, 'button')[0].props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
    expect(icons(chosen)).toEqual(['checkmark']);

    const other = render(<SettingsRow label="Header only" selected={false} onPress={() => {}} />);
    expect(byRole(other, 'button')[0].props.accessibilityState).toEqual(expect.objectContaining({ selected: false }));
    expect(icons(other)).toEqual([]);
  });

  it('without onPress, is one static element read as its text', () => {
    const root = render(<SettingsRow label="Waiting to send" value="3" />);
    expect(byRole(root, 'button')).toHaveLength(0);
    const row = root.root.find((n) => typeof n.type === 'string' && n.props.accessible === true);
    expect(row.props.accessibilityLabel).toBe('Waiting to send, 3');
  });

  it('with trailing content, lets VoiceOver reach the trailing element itself', () => {
    const root = render(<SettingsRow label="Status" trailing={<SettingsRow label="inner" />} />);
    const outer = root.root.findAll((n) => typeof n.type === 'string' && n.props.accessible === false);
    expect(outer[0].props.accessibilityLabel).toBeUndefined();
  });
});
