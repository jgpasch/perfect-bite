// Push registration (spec 4.13): the permission is asked only on request, a token is sent only
// when it or the user changed (or a week went by), and sign-out drops it even when the server fails.
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AppState, Platform, type AppStateStatus } from 'react-native';

import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { resetDb } from '@/test/db';
import { resetSupabase, respondToRpc, rpcCalls, rpcCallsFor, supabase } from '@/test/fake-supabase';

import {
  ANDROID_CHANNEL_ID,
  getPushPermission,
  needsRegistration,
  registerForPush,
  REREGISTER_AFTER_MS,
  requestPushPermission,
  startPushRegistration,
} from '../registration';
import { getPushRegistration, PUSH_REGISTRATION_KEY, unregisterPush } from '../stored-registration';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));

let mockAccount: { userId: string } | null = null;
jest.mock('@/features/auth/account', () => ({ getAccount: () => mockAccount }));

const mockDevice = { isDevice: true };
jest.mock('expo-device', () => ({
  get isDevice() {
    return mockDevice.isDevice;
  },
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { eas: { projectId: 'project-1' } } } },
}));

type Status = 'granted' | 'denied' | 'undetermined';
type FakeNotifications = {
  getPermissionsAsync: jest.Mock<() => Promise<{ status: Status }>>;
  requestPermissionsAsync: jest.Mock<() => Promise<{ status: Status }>>;
  getExpoPushTokenAsync: jest.Mock<(options: { projectId: string }) => Promise<{ type: 'expo'; data: string }>>;
  setNotificationChannelAsync: jest.Mock<(id: string, channel: unknown) => Promise<null>>;
  addPushTokenListener: jest.Mock<(listener: () => void) => { remove: () => void }>;
};
jest.mock('expo-notifications', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  addPushTokenListener: jest.fn(),
  AndroidImportance: { DEFAULT: 5 },
}));
const mockNotifications = jest.requireMock<FakeNotifications>('expo-notifications');

const ALEX = 'u-alex';
const SAM = 'u-sam';
const TOKEN = 'ExponentPushToken[abc123]';
const NEW_TOKEN = 'ExponentPushToken[def456]';
const DAY = 24 * 60 * 60 * 1000;

const realOS = Platform.OS;
function setOS(os: typeof Platform.OS) {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

function stored(token: string, userId: string, at: Date) {
  setDeviceSetting(PUSH_REGISTRATION_KEY, { token, userId, at: at.toISOString() });
}

beforeEach(() => {
  resetDb();
  resetSupabase();
  setOS(realOS);
  mockAccount = { userId: ALEX };
  mockDevice.isDevice = true;
  mockNotifications.getPermissionsAsync.mockReset().mockResolvedValue({ status: 'granted' });
  mockNotifications.requestPermissionsAsync.mockReset().mockResolvedValue({ status: 'granted' });
  mockNotifications.getExpoPushTokenAsync.mockReset().mockResolvedValue({ type: 'expo', data: TOKEN });
  mockNotifications.setNotificationChannelAsync.mockReset().mockResolvedValue(null);
  mockNotifications.addPushTokenListener.mockReset().mockReturnValue({ remove: jest.fn() });
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('needsRegistration', () => {
  const now = new Date('2026-10-17T12:00:00Z');
  const at = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it('is true with nothing stored, a new token or a new user', () => {
    expect(needsRegistration(null, TOKEN, ALEX, now)).toBe(true);
    expect(needsRegistration({ token: TOKEN, userId: ALEX, at: at(0) }, NEW_TOKEN, ALEX, now)).toBe(true);
    expect(needsRegistration({ token: TOKEN, userId: ALEX, at: at(0) }, TOKEN, SAM, now)).toBe(true);
  });

  it('is false for the same token and user within 7 days, true after', () => {
    expect(needsRegistration({ token: TOKEN, userId: ALEX, at: at(DAY) }, TOKEN, ALEX, now)).toBe(false);
    expect(needsRegistration({ token: TOKEN, userId: ALEX, at: at(REREGISTER_AFTER_MS) }, TOKEN, ALEX, now)).toBe(false);
    expect(needsRegistration({ token: TOKEN, userId: ALEX, at: at(REREGISTER_AFTER_MS + 1) }, TOKEN, ALEX, now)).toBe(true);
  });

  it('is true when the stored time is unreadable', () => {
    expect(needsRegistration({ token: TOKEN, userId: ALEX, at: 'not a date' }, TOKEN, ALEX, now)).toBe(true);
  });
});

describe('registerForPush', () => {
  it('registers a granted token with the EAS projectId and stores it', async () => {
    const before = Date.now();
    await expect(registerForPush({ prompt: false })).resolves.toBe('granted');
    expect(mockNotifications.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'project-1' });
    expect(rpcCalls).toEqual([{ fn: 'register_push_token', args: { p_token: TOKEN, p_platform: 'ios' } }]);
    const registration = getPushRegistration();
    expect(registration).toMatchObject({ token: TOKEN, userId: ALEX });
    expect(Date.parse(registration!.at)).toBeGreaterThanOrEqual(before);
  });

  it("doesn't prompt when prompt is false, and registers nothing while undetermined", async () => {
    mockNotifications.getPermissionsAsync.mockResolvedValue({ status: 'undetermined' });
    await expect(registerForPush({ prompt: false })).resolves.toBe('undetermined');
    expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockNotifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
  });

  it('prompts when asked and undetermined, then registers if allowed', async () => {
    mockNotifications.getPermissionsAsync.mockResolvedValue({ status: 'undetermined' });
    await expect(requestPushPermission()).resolves.toBe('granted');
    expect(mockNotifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(rpcCallsFor('register_push_token')).toHaveLength(1);
  });

  it('a prompt the user declines registers nothing', async () => {
    mockNotifications.getPermissionsAsync.mockResolvedValue({ status: 'undetermined' });
    mockNotifications.requestPermissionsAsync.mockResolvedValue({ status: 'denied' });
    await expect(requestPushPermission()).resolves.toBe('denied');
    expect(mockNotifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
    expect(getPushRegistration()).toBeNull();
  });

  it("a denied permission registers nothing and isn't asked again, even with prompt", async () => {
    mockNotifications.getPermissionsAsync.mockResolvedValue({ status: 'denied' });
    await expect(registerForPush({ prompt: true })).resolves.toBe('denied');
    expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockNotifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
  });

  it("doesn't re-send an unchanged token", async () => {
    const at = new Date(Date.now() - DAY);
    stored(TOKEN, ALEX, at);
    await expect(registerForPush({ prompt: false })).resolves.toBe('granted');
    expect(rpcCalls).toEqual([]);
    expect(getPushRegistration()).toEqual({ token: TOKEN, userId: ALEX, at: at.toISOString() });
  });

  it('re-sends an unchanged token more than 7 days old', async () => {
    stored(TOKEN, ALEX, new Date(Date.now() - 8 * DAY));
    await registerForPush({ prompt: false });
    expect(rpcCallsFor('register_push_token')).toHaveLength(1);
    expect(Date.now() - Date.parse(getPushRegistration()!.at)).toBeLessThan(DAY);
  });

  it('sends the token for a new user', async () => {
    stored(TOKEN, SAM, new Date());
    await registerForPush({ prompt: false });
    expect(rpcCalls).toEqual([{ fn: 'register_push_token', args: { p_token: TOKEN, p_platform: 'ios' } }]);
    expect(getPushRegistration()).toMatchObject({ token: TOKEN, userId: ALEX });
  });

  it('sends a new token for the same user', async () => {
    stored(TOKEN, ALEX, new Date());
    mockNotifications.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: NEW_TOKEN });
    await registerForPush({ prompt: false });
    expect(rpcCalls).toEqual([{ fn: 'register_push_token', args: { p_token: NEW_TOKEN, p_platform: 'ios' } }]);
    expect(getPushRegistration()?.token).toBe(NEW_TOKEN);
  });

  it("doesn't store a registration the server refused, so the next run tries again", async () => {
    respondToRpc('register_push_token', { error: { message: 'invalid token' } });
    await expect(registerForPush({ prompt: false })).resolves.toBe('granted');
    expect(getPushRegistration()).toBeNull();
    await registerForPush({ prompt: false });
    expect(rpcCallsFor('register_push_token')).toHaveLength(2);
    expect(getPushRegistration()?.token).toBe(TOKEN);
  });

  it('never throws when the token fetch fails', async () => {
    mockNotifications.getExpoPushTokenAsync.mockRejectedValue(new Error('no APNs entitlement'));
    await expect(registerForPush({ prompt: false })).resolves.toBe('granted');
    expect(rpcCalls).toEqual([]);
  });

  it("doesn't register when the user signed out while the token was fetched", async () => {
    mockNotifications.getExpoPushTokenAsync.mockImplementation(async () => {
      mockAccount = null;
      return { type: 'expo', data: TOKEN };
    });
    await registerForPush({ prompt: false });
    expect(rpcCalls).toEqual([]);
    expect(getPushRegistration()).toBeNull();
  });

  it('returns early when signed out, on a simulator and on web', async () => {
    mockAccount = null;
    await expect(registerForPush({ prompt: true })).resolves.toBe('unavailable');
    mockAccount = { userId: ALEX };
    mockDevice.isDevice = false;
    await expect(registerForPush({ prompt: true })).resolves.toBe('unavailable');
    mockDevice.isDevice = true;
    setOS('web');
    await expect(registerForPush({ prompt: true })).resolves.toBe('unavailable');
    expect(mockNotifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
  });

  it('on Android, creates the default channel before asking for a token', async () => {
    setOS('android');
    const order: string[] = [];
    mockNotifications.setNotificationChannelAsync.mockImplementation(async () => {
      order.push('channel');
      return null;
    });
    mockNotifications.getExpoPushTokenAsync.mockImplementation(async () => {
      order.push('token');
      return { type: 'expo', data: TOKEN };
    });
    await registerForPush({ prompt: false });
    expect(order).toEqual(['channel', 'token']);
    expect(mockNotifications.setNotificationChannelAsync).toHaveBeenCalledWith(ANDROID_CHANNEL_ID, { name: 'Default', importance: 5 });
    expect(rpcCalls).toEqual([{ fn: 'register_push_token', args: { p_token: TOKEN, p_platform: 'android' } }]);
  });

  it("doesn't create an Android channel on iOS", async () => {
    await registerForPush({ prompt: false });
    expect(mockNotifications.setNotificationChannelAsync).not.toHaveBeenCalled();
  });
});

describe('getPushPermission', () => {
  it('reads the permission without asking', async () => {
    mockNotifications.getPermissionsAsync.mockResolvedValue({ status: 'undetermined' });
    await expect(getPushPermission()).resolves.toBe('undetermined');
    expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('is unavailable on a simulator, or when reading it fails', async () => {
    mockDevice.isDevice = false;
    await expect(getPushPermission()).resolves.toBe('unavailable');
    mockDevice.isDevice = true;
    mockNotifications.getPermissionsAsync.mockRejectedValue(new Error('boom'));
    await expect(getPushPermission()).resolves.toBe('unavailable');
  });
});

describe('startPushRegistration', () => {
  let onChange: ((next: AppStateStatus) => void) | undefined;
  let onToken: (() => void) | undefined;
  const appRemove = jest.fn();
  const tokenRemove = jest.fn();

  beforeEach(() => {
    onChange = undefined;
    onToken = undefined;
    appRemove.mockClear();
    tokenRemove.mockClear();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      onChange = listener as (next: AppStateStatus) => void;
      return { remove: appRemove } as ReturnType<typeof AppState.addEventListener>;
    });
    mockNotifications.addPushTokenListener.mockImplementation((listener) => {
      onToken = listener;
      return { remove: tokenRemove };
    });
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('refreshes on start, on each return to the foreground and on a new token, never prompting', async () => {
    mockNotifications.getPermissionsAsync.mockResolvedValue({ status: 'undetermined' });
    const stop = startPushRegistration();
    await flush();
    expect(mockNotifications.getPermissionsAsync).toHaveBeenCalledTimes(1);

    onChange!('background');
    onChange!('active');
    await flush();
    expect(mockNotifications.getPermissionsAsync).toHaveBeenCalledTimes(2);

    onChange!('active'); // already active: not a return to the foreground
    await flush();
    expect(mockNotifications.getPermissionsAsync).toHaveBeenCalledTimes(2);

    onToken!();
    await flush();
    expect(mockNotifications.getPermissionsAsync).toHaveBeenCalledTimes(3);
    expect(mockNotifications.requestPermissionsAsync).not.toHaveBeenCalled();

    stop();
    expect(appRemove).toHaveBeenCalledTimes(1);
    expect(tokenRemove).toHaveBeenCalledTimes(1);
  });

  it('a new token from the OS is registered', async () => {
    stored(TOKEN, ALEX, new Date());
    startPushRegistration();
    await flush();
    expect(rpcCalls).toEqual([]);
    mockNotifications.getExpoPushTokenAsync.mockResolvedValue({ type: 'expo', data: NEW_TOKEN });
    onToken!();
    await flush();
    expect(rpcCalls).toEqual([{ fn: 'register_push_token', args: { p_token: NEW_TOKEN, p_platform: 'ios' } }]);
  });

  it('does nothing on a simulator', () => {
    mockDevice.isDevice = false;
    const stop = startPushRegistration();
    expect(mockNotifications.addPushTokenListener).not.toHaveBeenCalled();
    expect(mockNotifications.getPermissionsAsync).not.toHaveBeenCalled();
    stop();
  });
});

describe('unregisterPush', () => {
  it('unregisters the stored token and forgets it', async () => {
    stored(TOKEN, ALEX, new Date());
    await unregisterPush();
    expect(rpcCalls).toEqual([{ fn: 'unregister_push_token', args: { p_token: TOKEN } }]);
    expect(getDeviceSetting(PUSH_REGISTRATION_KEY, null)).toBeNull();
  });

  it('clears the stored registration even when the RPC fails', async () => {
    stored(TOKEN, ALEX, new Date());
    respondToRpc('unregister_push_token', { error: { message: 'network' } });
    await expect(unregisterPush()).resolves.toBeUndefined();
    expect(getPushRegistration()).toBeNull();
  });

  it('clears it when the RPC rejects', async () => {
    stored(TOKEN, ALEX, new Date());
    supabase.rpc.mockRejectedValueOnce(new Error('offline'));
    await expect(unregisterPush()).resolves.toBeUndefined();
    expect(getPushRegistration()).toBeNull();
  });

  it('gives up on an RPC that never answers', async () => {
    stored(TOKEN, ALEX, new Date());
    supabase.rpc.mockReturnValueOnce(new Promise(() => {}) as never);
    const started = Date.now();
    await unregisterPush(20);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(getPushRegistration()).toBeNull();
  });

  it('calls nothing when no token was registered', async () => {
    await unregisterPush();
    expect(rpcCalls).toEqual([]);
  });

  it('ignores an unreadable stored value', async () => {
    setDeviceSetting(PUSH_REGISTRATION_KEY, { token: 42 });
    expect(getPushRegistration()).toBeNull();
    await unregisterPush();
    expect(rpcCalls).toEqual([]);
    expect(getDeviceSetting(PUSH_REGISTRATION_KEY, null)).toBeNull();
  });
});
