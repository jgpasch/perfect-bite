// The bottom add bar (spec 4.2): + adds, return adds and keeps the keyboard up, an empty field
// can't add and return hides the keyboard instead.
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Keyboard, TextInput } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { AddBar } from '../add-bar';

jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 34, left: 0, right: 0 }) }));

afterEach(() => {
  jest.restoreAllMocks();
});

function render(value: string, extra: { onFocusChange?: (focused: boolean) => void; accessory?: React.ReactNode } = {}) {
  const onSubmit = jest.fn();
  const onChangeText = jest.fn();
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      <AddBar
        value={value}
        onChangeText={onChangeText}
        onSubmit={onSubmit}
        placeholder="Add an item"
        accessibilityLabel="Add item"
        {...extra}
      />,
    );
  });
  const input = tree.root.findByType(TextInput);
  const add = tree.root.find((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'button');
  return { tree, input, add, onSubmit, onChangeText };
}

const click = (n: ReactTestInstance) => act(() => n.props.onClick({ nativeEvent: {} }));

describe('AddBar', () => {
  it('labels the field and the + button', () => {
    const { input, add } = render('');
    expect(input.props.accessibilityLabel).toBe('Add item');
    expect(input.props.placeholder).toBe('Add an item');
    expect(add.props.accessibilityLabel).toBe('Add');
  });

  it('passes typing through', () => {
    const { input, onChangeText } = render('');
    act(() => input.props.onChangeText('milk'));
    expect(onChangeText).toHaveBeenCalledWith('milk');
  });

  it('with text, + and return both submit', () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss');
    const { input, add, onSubmit } = render('milk');
    expect(add.props.accessibilityState).toEqual(expect.objectContaining({ disabled: false }));
    click(add);
    act(() => input.props.onSubmitEditing());
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('with %j, + is disabled and return hides the keyboard', (value) => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
    const { input, add, onSubmit } = render(value);
    expect(add.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    click(add);
    act(() => input.props.onSubmitEditing());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('reports focus and blur', () => {
    const onFocusChange = jest.fn();
    const { input } = render('', { onFocusChange });
    act(() => input.props.onFocus());
    act(() => input.props.onBlur());
    expect(onFocusChange.mock.calls).toEqual([[true], [false]]);
  });

  it('keeps autocorrect and auto-capitalisation off (names are stored as typed)', () => {
    const { input } = render('');
    expect(input.props).toEqual(expect.objectContaining({ autoCorrect: false, autoCapitalize: 'none', spellCheck: false }));
  });
});
