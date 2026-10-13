// The in-app banner (spec 4.11): one at a time, a haptic and a VoiceOver announcement on arrival,
// gone after its timeout, tap opens, escape dismisses, and it waits while the app is in the background.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as Haptics from 'expo-haptics';
import { AccessibilityInfo, AppState, type AppStateStatus } from 'react-native';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';

import { Motion } from '@/constants/theme';

import { NotificationHost } from '../notification-host';
import { clearNotifications, currentNotification, notify, type AppNotification } from '../notifications';

jest.mock('@/global.css', () => ({}));
jest.mock('@/components/icon', () => ({ Icon: () => null }));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(() => Promise.resolve()),
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
}));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }) }));
jest.mock('react-native-screens', () => {
  const { createElement } = require('react');
  return { FullWindowOverlay: ({ children }: { children: unknown }) => createElement('FullWindowOverlay', null, children) };
});
jest.mock('react-native-worklets', () => ({ scheduleOnRN: (fn: (...a: unknown[]) => void, ...args: unknown[]) => fn(...args) }));
jest.mock('react-native-reanimated', () => {
  const { View } = require('react-native');
  const builder: object = new Proxy({}, { get: () => () => builder });
  return {
    __esModule: true,
    default: { View },
    FadeIn: builder,
    FadeOut: builder,
    SlideInUp: builder,
    SlideOutUp: builder,
    useReducedMotion: () => false,
    useAnimatedStyle: (fn: () => object) => fn(),
    useSharedValue: (value: unknown) => {
      const shared = { value, get: () => shared.value, set: (v: unknown) => void (shared.value = v) };
      return shared;
    },
    withSpring: (value: unknown) => value,
    // Finishes at once, so a swipe-away dismisses straight away.
    withTiming: (value: unknown, _config: unknown, done?: (finished: boolean) => void) => {
      done?.(true);
      return value;
    },
  };
});
// Gestures: each builder records its callbacks so a test can play a tap or a swipe.
type Callbacks = Record<string, (event?: unknown) => void>;
const mockGestures: { tap?: Callbacks; pan?: Callbacks } = {};
jest.mock('react-native-gesture-handler', () => {
  const { createElement, Fragment } = require('react');
  const chain = (store: Record<string, unknown>) => {
    const self: object = new Proxy(
      {},
      {
        get: (_, key: string) => (arg: unknown) => {
          if (typeof arg === 'function') store[key] = arg;
          return self;
        },
      },
    );
    return self;
  };
  return {
    Gesture: {
      Tap: () => chain((mockGestures.tap = {} as Callbacks)),
      Pan: () => chain((mockGestures.pan = {} as Callbacks)),
      Exclusive: () => ({}),
    },
    GestureDetector: ({ children }: { children: unknown }) => createElement(Fragment, null, children),
    GestureHandlerRootView: ({ children }: { children: unknown }) => createElement(Fragment, null, children),
  };
});

let tree: ReactTestRenderer | null = null;
let announce: jest.SpiedFunction<typeof AccessibilityInfo.announceForAccessibility>;
let appStateListener: ((state: AppStateStatus) => void) | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
    appStateListener = listener as (state: AppStateStatus) => void;
    return { remove: () => (appStateListener = undefined) } as ReturnType<typeof AppState.addEventListener>;
  });
  jest.mocked(Haptics.notificationAsync).mockClear();
  act(() => {
    tree = create(<NotificationHost />);
  });
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  act(() => clearNotifications());
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const base: AppNotification = {
  id: 'import-1',
  kind: 'recipeImport',
  icon: 'checkmark',
  hue: 'green',
  tone: 'success',
  title: 'Recipe imported',
  body: 'Weeknight dal is ready',
  emphasis: 'Weeknight dal',
  hint: 'Opens the recipe',
};

const post = (n: Partial<AppNotification> = {}) => act(() => notify({ ...base, ...n }));
const banner = (): ReactTestInstance | undefined =>
  tree!.root.findAll((n) => typeof n.type === 'string' && n.props.accessibilityRole === 'button')[0];
const action = (name: string) => act(() => banner()!.props.onAccessibilityAction({ nativeEvent: { actionName: name } }));

describe('NotificationHost', () => {
  it('shows nothing with nothing queued', () => {
    expect(tree!.toJSON()).toBeNull();
  });

  it('shows the first notification as a button read as title and body, with a hint and Dismiss', () => {
    post();
    const b = banner()!;
    expect(b.props.accessibilityLabel).toBe('Recipe imported. Weeknight dal is ready');
    expect(b.props.accessibilityHint).toBe('Opens the recipe');
    expect(b.props.accessibilityActions).toEqual([{ name: 'activate' }, { name: 'escape', label: 'Dismiss' }]);
    expect(announce).toHaveBeenCalledWith('Recipe imported. Weeknight dal is ready');
  });

  it('on iOS draws in a full-window overlay, over sheets', () => {
    post();
    expect(tree!.root.findAll((n) => (n.type as string) === 'FullWindowOverlay')).toHaveLength(1);
  });

  it('reads a title-only notification as just the title', () => {
    post({ body: undefined, emphasis: undefined });
    expect(banner()!.props.accessibilityLabel).toBe('Recipe imported');
  });

  it('buzzes success or warning by tone', () => {
    post();
    expect(Haptics.notificationAsync).toHaveBeenLastCalledWith('success');
    act(() => clearNotifications());
    post({ id: 'import-2', tone: 'warning' });
    expect(Haptics.notificationAsync).toHaveBeenLastCalledWith('warning');
  });

  it('dismisses itself after its timeout and shows the next one', () => {
    post();
    post({ id: 'import-2', title: 'Second' });
    act(() => jest.advanceTimersByTime(Motion.notificationTimeoutMs - 1));
    expect(banner()!.props.accessibilityLabel).toContain('Recipe imported');
    act(() => jest.advanceTimersByTime(1));
    expect(banner()!.props.accessibilityLabel).toContain('Second');
    act(() => jest.advanceTimersByTime(Motion.notificationTimeoutMs));
    expect(banner()).toBeUndefined();
  });

  it('a replacement with the same id restarts the timer without buzzing again', () => {
    post();
    act(() => jest.advanceTimersByTime(Motion.notificationTimeoutMs - 1000));
    post({ title: 'Recipe updated' });
    expect(Haptics.notificationAsync).toHaveBeenCalledTimes(1);
    expect(banner()!.props.accessibilityLabel).toContain('Recipe updated');
    act(() => jest.advanceTimersByTime(Motion.notificationTimeoutMs - 1));
    expect(banner()).toBeDefined();
    act(() => jest.advanceTimersByTime(1));
    expect(banner()).toBeUndefined();
  });

  it('VoiceOver activate opens it and dismisses it', () => {
    const onPress = jest.fn();
    post({ onPress });
    action('activate');
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(currentNotification()).toBeNull();
  });

  it('VoiceOver escape dismisses without opening', () => {
    const onPress = jest.fn();
    post({ onPress });
    action('escape');
    expect(onPress).not.toHaveBeenCalled();
    expect(currentNotification()).toBeNull();
  });

  it('a tap opens it', () => {
    const onPress = jest.fn();
    post({ onPress });
    act(() => mockGestures.tap!.onEnd());
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(currentNotification()).toBeNull();
  });

  it('a swipe up dismisses it; a short drag springs back', () => {
    const onPress = jest.fn();
    post({ onPress });
    act(() => mockGestures.pan!.onEnd({ translationY: -10, velocityY: -100 }));
    expect(currentNotification()).not.toBeNull();
    act(() => mockGestures.pan!.onEnd({ translationY: -40, velocityY: 0 }));
    expect(currentNotification()).toBeNull();
    expect(onPress).not.toHaveBeenCalled();
  });

  it('a fast flick up dismisses it too', () => {
    post();
    act(() => mockGestures.pan!.onEnd({ translationY: -5, velocityY: -800 }));
    expect(currentNotification()).toBeNull();
  });

  it('waits while the app is in the background, and starts its timer again on return', () => {
    post();
    act(() => jest.advanceTimersByTime(Motion.notificationTimeoutMs - 1000));
    act(() => appStateListener!('background'));
    expect(banner()).toBeUndefined();
    act(() => jest.advanceTimersByTime(Motion.notificationTimeoutMs * 2));
    expect(currentNotification()).not.toBeNull();
    act(() => appStateListener!('active'));
    expect(banner()).toBeDefined();
    act(() => jest.advanceTimersByTime(Motion.notificationTimeoutMs - 1));
    expect(currentNotification()).not.toBeNull();
    act(() => jest.advanceTimersByTime(1));
    expect(currentNotification()).toBeNull();
  });

  it('stays up while only inactive (Control Center, a system alert)', () => {
    post();
    act(() => appStateListener!('inactive'));
    expect(banner()).toBeDefined();
  });
});
