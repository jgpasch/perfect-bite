// Shared controls: each is a labelled button (or tab / checkbox) that fires when pressed and not
// when disabled, and reports its state to VoiceOver.
import { describe, expect, it, jest } from '@jest/globals';
import type { ReactElement } from 'react';
import { StyleSheet } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { Palette, type ThemeColors } from '@/constants/theme';

import { listHeaderColors } from '../appearance';
import { Button, PrimaryButton, SoftDangerButton, SurfaceButton } from '../button';
import { CheckCircle } from '../check-circle';
import { HeaderPill } from '../header-pill';
import { Pill } from '../pill';
import { SegmentedControl } from '../segmented-control';
import { SettingsRow, SettingsSection } from '../settings-group';
import { Stepper } from '../stepper';

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

describe('SurfaceButton layout="stacked"', () => {
  const host = (root: ReactTestRenderer) => byRole(root, 'button')[0];
  const style = (root: ReactTestRenderer) => StyleSheet.flatten(host(root).props.style);

  it('is a 64 pt surfaceMuted pill, at least 44 pt tall, the glyph over a caption label in ink', () => {
    const root = render(<SurfaceButton layout="stacked" label="Plan" icon="calendar" iconTint="#123456" />);
    expect(style(root)).toEqual(
      expect.objectContaining({ width: 64, minHeight: 44, borderRadius: 999, backgroundColor: Palette.light.surfaceMuted }),
    );
    // Stacked: a column, not the inline row.
    expect(style(root).flexDirection).toBeUndefined();
    expect(style(root).height).toBeUndefined();
    expect(icons(root)).toEqual(['calendar']);
    const parts = host(root).findAll((n) => (n.type as string) === 'Icon' || (n.type as string) === 'Text');
    expect(parts.map((n) => String(n.type))).toEqual(['Icon', 'Text']);
    const label = root.root.find((n) => (n.type as string) === 'Text');
    expect(label.props.children).toBe('Plan');
    expect(StyleSheet.flatten(label.props.style)).toEqual(expect.objectContaining({ fontSize: 12, color: Palette.light.ink }));
    expect(label.props.numberOfLines).toBeUndefined();
  });

  it('keeps ink text whatever `on` says, and the inline form is unchanged', () => {
    const stacked = render(<SurfaceButton layout="stacked" on="header" label="Cook" />);
    expect(StyleSheet.flatten(stacked.root.find((n) => (n.type as string) === 'Text').props.style).color).toBe(Palette.light.ink);
    const inline = render(<SurfaceButton label="Cook" />);
    expect(style(inline)).toEqual(expect.objectContaining({ flexDirection: 'row', minHeight: 54, backgroundColor: Palette.light.onHeader }));
  });

  it('fires on press, and not while disabled', () => {
    const onPress = jest.fn();
    click(host(render(<SurfaceButton layout="stacked" label="Plan" onPress={onPress} />)));
    expect(onPress).toHaveBeenCalledTimes(1);
    const off = render(<SurfaceButton layout="stacked" label="Plan" onPress={onPress} disabled />);
    expect(host(off).props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    click(host(off));
    expect(onPress).toHaveBeenCalledTimes(1);
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

describe('HeaderPill', () => {
  const look = listHeaderColors(Palette.light as ThemeColors);
  const fill = (root: ReactTestRenderer) => StyleSheet.flatten(byRole(root, 'button')[0].props.style).backgroundColor;
  const textColor = (root: ReactTestRenderer) =>
    StyleSheet.flatten(root.root.findAll((n) => (n.type as string) === 'Text')[0].props.style).color;

  it('is a button with its label, hint and selected state, padded to a 44 pt hit area, that fires on press', () => {
    const onPress = jest.fn();
    const root = render(<HeaderPill label="Filters · 2" accessibilityLabel="Filters, 2 active" accessibilityHint="Opens the filters." onPress={onPress} />);
    const [button] = byRole(root, 'button');
    expect([button.props.accessibilityLabel, button.props.accessibilityHint]).toEqual(['Filters, 2 active', 'Opens the filters.']);
    expect(button.props.accessibilityState).toEqual(expect.objectContaining({ selected: false }));
    expect(button.props.hitSlop).toBe(6);
    click(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('reads its label without an accessibility label', () => {
    const root = render(<HeaderPill label="Filters" onPress={() => {}} />);
    expect(byRole(root, 'button')[0].props.accessibilityLabel).toBe('Filters');
  });

  it('is the view button’s white wash with white text, and white with header-green text when selected', () => {
    const off = render(<HeaderPill label="Filters" onPress={() => {}} />);
    expect([fill(off), textColor(off)]).toEqual([look.viewButton.fill, Palette.light.onHeader]);
    const on = render(<HeaderPill label="Filters · 1" selected onPress={() => {}} />);
    expect([fill(on), textColor(on)]).toEqual([Palette.light.onHeader, Palette.light.header]);
    expect(byRole(on, 'button')[0].props.accessibilityState).toEqual(expect.objectContaining({ selected: true }));
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

// Spanish layout pass: a label longer than its control (Spanish, the largest Dynamic Type) wraps
// inside it, centred, rather than overflowing or truncating. The type size never changes.
describe('long labels wrap', () => {
  const LONG = 'Agregar a una lista de compras muy larga';
  /** The flattened style of the host Text showing `text`. */
  const textStyle = (root: ReactTestRenderer, text: string) => {
    const [node] = root.root.findAll((n) => (n.type as string) === 'Text' && n.props.children === text);
    return StyleSheet.flatten(node.props.style);
  };

  it.each([
    ['PrimaryButton', PrimaryButton],
    ['SurfaceButton', SurfaceButton],
    ['SoftDangerButton', SoftDangerButton],
    ['Button', Button],
  ] as [string, typeof SoftDangerButton][])('%s', (_, Component) => {
    const style = textStyle(render(<Component label={LONG} onPress={() => {}} />), LONG);
    expect(style).toEqual(expect.objectContaining({ flexShrink: 1, textAlign: 'center' }));
    expect(style.fontSize).toBe(17);
  });

  it('Pill, selected or not, without limiting its lines', () => {
    for (const selected of [false, true]) {
      const root = render(<Pill label={LONG} selected={selected} onPress={() => {}} />);
      const style = textStyle(root, LONG);
      expect(style).toEqual(expect.objectContaining({ flexShrink: 1, textAlign: 'center' }));
      const [node] = root.root.findAll((n) => (n.type as string) === 'Text' && n.props.children === LONG);
      expect(node.props.numberOfLines).toBeUndefined();
    }
  });

  it('SegmentedControl, in its default and custom looks', () => {
    const segments = [
      { value: 'ingredients', label: 'Ingredientes' },
      { value: 'method', label: 'Preparación · 12' },
    ] as const;
    const look = { track: '#000', text: '#111', selected: '#222', selectedText: '#333' };
    for (const custom of [undefined, look]) {
      const root = render(<SegmentedControl segments={segments} value="method" onChange={() => {}} look={custom} />);
      expect(textStyle(root, 'Ingredientes').textAlign).toBe('center');
      expect(textStyle(root, 'Preparación · 12')).toEqual(expect.objectContaining({ textAlign: 'center', fontWeight: '700' }));
    }
  });
});

describe('Stepper', () => {
  const stepper = (value: number, onChange = jest.fn(), buttonSize?: number) =>
    render(
      <Stepper
        value={value}
        min={1}
        max={100}
        onChange={onChange}
        label={`For ${value}`}
        accessibilityLabel="Servings"
        buttonSize={buttonSize}
      />,
    );
  const button = (root: ReactTestRenderer, label: string) => byRole(root, 'button').find((b) => b.props.accessibilityLabel === label)!;

  it('shows the value between − and +, and VoiceOver reads it as one adjustable control', () => {
    const root = stepper(4);
    expect(icons(root)).toEqual(['minus', 'plus']);
    expect(root.root.findAll((n) => (n.type as string) === 'Text').map((n) => n.props.children)).toEqual(['For 4']);
    const [control] = byRole(root, 'adjustable');
    expect(control.props.accessibilityLabel).toBe('Servings');
    expect(control.props.accessibilityValue).toEqual({ text: 'For 4' });
    expect(byRole(root, 'button').map((b) => b.props.accessibilityLabel)).toEqual(['Fewer', 'More']);
  });

  it('hideValue leaves the value out from between the buttons, but VoiceOver still reads it', () => {
    const root = render(
      <Stepper value={6} min={1} max={100} onChange={() => {}} label="For 6" accessibilityLabel="Servings" hideValue />,
    );
    expect(icons(root)).toEqual(['minus', 'plus']);
    expect(root.root.findAll((n) => (n.type as string) === 'Text')).toEqual([]);
    expect(byRole(root, 'adjustable')[0].props.accessibilityValue).toEqual({ text: 'For 6' });
  });

  it('− and + step by one', () => {
    const onChange = jest.fn();
    const root = stepper(4, onChange);
    click(button(root, 'Fewer'));
    click(button(root, 'More'));
    expect(onChange.mock.calls).toEqual([[3], [5]]);
  });

  it('VoiceOver increment and decrement step too', () => {
    const onChange = jest.fn();
    const root = stepper(4, onChange);
    const [control] = byRole(root, 'adjustable');
    act(() => control.props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }));
    act(() => control.props.onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } }));
    act(() => control.props.onAccessibilityAction({ nativeEvent: { actionName: 'activate' } }));
    expect(onChange.mock.calls).toEqual([[5], [3]]);
  });

  it('at the minimum, − is disabled and does nothing', () => {
    const onChange = jest.fn();
    const root = stepper(1, onChange);
    expect(button(root, 'Fewer').props.accessibilityState).toEqual({ disabled: true });
    expect(button(root, 'More').props.accessibilityState).toEqual({ disabled: false });
    click(button(root, 'Fewer'));
    act(() => byRole(root, 'adjustable')[0].props.onAccessibilityAction({ nativeEvent: { actionName: 'decrement' } }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('at the maximum, + is disabled and does nothing', () => {
    const onChange = jest.fn();
    const root = stepper(100, onChange);
    expect(button(root, 'More').props.accessibilityState).toEqual({ disabled: true });
    click(button(root, 'More'));
    act(() => byRole(root, 'adjustable')[0].props.onAccessibilityAction({ nativeEvent: { actionName: 'increment' } }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('buttons are 34 pt with their hit area brought to 44, or the size given', () => {
    const style = (b: ReactTestInstance) => Object.assign({}, ...[b.props.style].flat(Infinity).filter(Boolean));
    const small = button(stepper(4), 'More');
    expect([style(small).width, style(small).height, small.props.hitSlop]).toEqual([34, 34, 5]);
    const big = button(stepper(4, jest.fn(), 40), 'More');
    expect([style(big).width, big.props.hitSlop]).toEqual([40, 2]);
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
