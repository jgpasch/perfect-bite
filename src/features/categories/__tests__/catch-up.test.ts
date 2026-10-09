import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import type { NetworkState } from 'expo-network';
import { AppState, type AppStateStatus } from 'react-native';

import { cameOnline, cameToForeground, isOnline, startCatchUpTriggers } from '../catch-up';

// jest.mock is hoisted above the imports; the factory reads this lazily.
const mockNetwork: { listener: ((s: NetworkState) => void) | null; remove: jest.Mock } = {
  listener: null,
  remove: jest.fn(),
};
jest.mock('expo-network', () => ({
  addNetworkStateListener: (listener: (s: NetworkState) => void) => {
    mockNetwork.listener = listener;
    return { remove: mockNetwork.remove };
  },
}));

const mockApp: { listener: ((s: AppStateStatus) => void) | null; remove: jest.Mock } = {
  listener: null,
  remove: jest.fn(),
};
// The preset's AppState mock has no real `currentState`; give it one.
const setCurrentState = (state: AppStateStatus) =>
  Object.defineProperty(AppState, 'currentState', { value: state, configurable: true, writable: true });
jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
  mockApp.listener = listener as (s: AppStateStatus) => void;
  return { remove: mockApp.remove };
});

const net = (isConnected?: boolean, isInternetReachable?: boolean): NetworkState => ({ isConnected, isInternetReachable });

describe('isOnline', () => {
  test('connected and reachable, or reachability unknown, is online', () => {
    expect(isOnline(net(true, true))).toBe(true);
    expect(isOnline(net(true, undefined))).toBe(true);
  });

  test('not connected, connected but unreachable, or nothing known is offline', () => {
    expect(isOnline(net(false, false))).toBe(false);
    expect(isOnline(net(false, undefined))).toBe(false);
    expect(isOnline(net(true, false))).toBe(false);
    expect(isOnline(net())).toBe(false);
  });
});

describe('cameOnline', () => {
  test('only offline → online is a reconnect', () => {
    expect(cameOnline(false, true)).toBe(true);
    expect(cameOnline(true, true)).toBe(false);
    expect(cameOnline(true, false)).toBe(false);
    expect(cameOnline(false, false)).toBe(false);
  });

  test('the first state seen is not a reconnect', () => {
    expect(cameOnline(null, true)).toBe(false);
    expect(cameOnline(null, false)).toBe(false);
  });
});

describe('cameToForeground', () => {
  test('background or inactive → active is a return to the foreground', () => {
    expect(cameToForeground('background', 'active')).toBe(true);
    expect(cameToForeground('inactive', 'active')).toBe(true);
  });

  test('anything else is not', () => {
    expect(cameToForeground('active', 'active')).toBe(false);
    expect(cameToForeground('active', 'background')).toBe(false);
    expect(cameToForeground('active', 'inactive')).toBe(false);
  });
});

describe('startCatchUpTriggers', () => {
  let onCatchUp: jest.Mock<() => void>;
  let stop: () => void;

  beforeEach(() => {
    setCurrentState('active');
    mockApp.remove.mockClear();
    mockNetwork.remove.mockClear();
    onCatchUp = jest.fn();
    stop = startCatchUpTriggers(onCatchUp);
  });

  test('starting does not trigger a catch-up by itself', () => {
    expect(onCatchUp).not.toHaveBeenCalled();
  });

  test('each return to the foreground triggers one catch-up', () => {
    mockApp.listener!('background');
    expect(onCatchUp).not.toHaveBeenCalled();
    mockApp.listener!('active');
    expect(onCatchUp).toHaveBeenCalledTimes(1);
    mockApp.listener!('active');
    expect(onCatchUp).toHaveBeenCalledTimes(1);
    mockApp.listener!('inactive');
    mockApp.listener!('active');
    expect(onCatchUp).toHaveBeenCalledTimes(2);
  });

  test('a launch in the background counts the first activation', () => {
    stop();
    setCurrentState('background');
    const late = jest.fn();
    startCatchUpTriggers(late);
    mockApp.listener!('active');
    expect(late).toHaveBeenCalledTimes(1);
  });

  test('the first network state is not a reconnect, even when online', () => {
    mockNetwork.listener!(net(true, true));
    expect(onCatchUp).not.toHaveBeenCalled();
  });

  test('offline → online triggers once; staying online does not', () => {
    mockNetwork.listener!(net(false, false));
    mockNetwork.listener!(net(true, undefined));
    expect(onCatchUp).toHaveBeenCalledTimes(1);
    mockNetwork.listener!(net(true, true));
    expect(onCatchUp).toHaveBeenCalledTimes(1);
  });

  test('connected but unreachable is still offline; becoming reachable is the reconnect', () => {
    mockNetwork.listener!(net(true, true));
    mockNetwork.listener!(net(true, false));
    expect(onCatchUp).not.toHaveBeenCalled();
    mockNetwork.listener!(net(true, true));
    expect(onCatchUp).toHaveBeenCalledTimes(1);
  });

  test('the cleanup removes both listeners', () => {
    stop();
    expect(mockApp.remove).toHaveBeenCalledTimes(1);
    expect(mockNetwork.remove).toHaveBeenCalledTimes(1);
  });
});
