// The undo toast (spec 4.2, 4.4): announces itself, times out after 5 s, and its action pills fire.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AccessibilityInfo, Text } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { Motion } from '@/constants/theme';

import { Toast, type ToastAction } from '../toast';

jest.mock('@/global.css', () => ({}));
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const builder: object = new Proxy({}, { get: () => () => builder });
  return {
    __esModule: true,
    default: { View },
    FadeIn: builder,
    FadeInDown: builder,
    FadeOut: builder,
    LinearTransition: builder,
    useReducedMotion: () => false,
  };
});

let tree: ReactTestRenderer | null = null;
let announce: jest.SpiedFunction<typeof AccessibilityInfo.announceForAccessibility>;

beforeEach(() => {
  jest.useFakeTimers();
  announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  announce.mockRestore();
  jest.useRealTimers();
});

function render(props: { message: string; emphasis?: string; actions?: ToastAction[]; onDismiss: () => void }) {
  act(() => {
    tree = create(<Toast actions={[]} {...props} />);
  });
  return tree!;
}

const buttons = (root: ReactTestRenderer) =>
  root.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'button');
const click = (n: ReactTestInstance) => act(() => n.props.onClick({ nativeEvent: {} }));
/** Every string in the rendered host tree, joined. */
function textOf(root: ReactTestRenderer): string {
  const walk = (node: unknown): string => {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(walk).join('');
    if (node && typeof node === 'object' && 'children' in node) return walk((node as { children: unknown }).children);
    return '';
  };
  return walk(root.toJSON());
}

describe('Toast', () => {
  it('dismisses itself after the undo timeout, not before', () => {
    const onDismiss = jest.fn();
    render({ message: 'Deleted milk', onDismiss });
    act(() => jest.advanceTimersByTime(Motion.undoTimeoutMs - 1));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('cancels the timeout when it goes away early', () => {
    const onDismiss = jest.fn();
    render({ message: 'Deleted milk', onDismiss });
    act(() => tree?.unmount());
    tree = null;
    act(() => jest.advanceTimersByTime(Motion.undoTimeoutMs * 2));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('starts the timer again when its message changes', () => {
    const onDismiss = jest.fn();
    render({ message: 'Deleted milk', onDismiss });
    act(() => jest.advanceTimersByTime(Motion.undoTimeoutMs - 1000));
    act(() => tree!.update(<Toast message="Deleted eggs" actions={[]} onDismiss={onDismiss} />));
    act(() => jest.advanceTimersByTime(Motion.undoTimeoutMs - 1));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('keeps its timer through a re-render with the same message and handler', () => {
    const onDismiss = jest.fn();
    render({ message: 'Deleted milk', onDismiss });
    act(() => jest.advanceTimersByTime(Motion.undoTimeoutMs - 1000));
    act(() => tree!.update(<Toast message="Deleted milk" actions={[]} onDismiss={onDismiss} />));
    act(() => jest.advanceTimersByTime(1000));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('announces the message and its actions to VoiceOver once', () => {
    render({ message: 'Deleted milk', actions: [{ label: 'Undo', onPress: () => {} }], onDismiss: () => {} });
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Deleted milk. Undo available.');
  });

  it('announces a plain notice as just the message', () => {
    render({ message: 'Saved', onDismiss: () => {} });
    expect(announce).toHaveBeenCalledWith('Saved');
  });

  it('shows each action as a labelled button that fires its handler', () => {
    const undo = jest.fn();
    const adjust = jest.fn();
    const root = render({
      message: 'Added milk',
      actions: [
        { label: 'Undo', onPress: undo },
        { label: 'Adjust', onPress: adjust },
      ],
      onDismiss: () => {},
    });
    const [first, second] = buttons(root);
    expect([first.props.accessibilityLabel, second.props.accessibilityLabel]).toEqual(['Undo', 'Adjust']);
    click(second);
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(undo).not.toHaveBeenCalled();
    click(first);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('has no buttons for a plain notice, and is a polite live region', () => {
    const root = render({ message: 'Saved', onDismiss: () => {} });
    expect(buttons(root)).toHaveLength(0);
    expect(root.root.findAll((n) => n.props.accessibilityLiveRegion === 'polite').length).toBeGreaterThan(0);
  });

  it('sets the emphasis in its own bold run, keeping the whole message', () => {
    const root = render({ message: 'Deleted Milk', emphasis: 'milk', onDismiss: () => {} });
    expect(textOf(root)).toBe('Deleted Milk');
    const bold = root.root
      .findAllByType(Text)
      .find((t) => t.props.children === 'Milk' && JSON.stringify(t.props.style).includes('"fontWeight":"700"'));
    expect(bold).toBeDefined();
  });
});
