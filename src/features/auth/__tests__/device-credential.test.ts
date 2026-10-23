// The device credential (spec 6.12): registered after sign-in, renewed under 30 days, revoked on
// sign-out (online) and always removed from the Keychain, the installation id kept throughout.
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AppState, type AppStateStatus } from 'react-native';

import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { resetDb } from '@/test/db';
import { resetSupabase, rpcCallsFor, respondToRpc, supabase } from '@/test/fake-supabase';

import appJson from '../../../../app.json';
import shareTargetConfig from '../../../../targets/share-recipe/expo-target.config.js';
import { signOut } from '../account';
import {
  CREDENTIAL_KEY,
  ensureDeviceCredential,
  getInstallationId,
  INSTALLATION_ID_KEY,
  KEYCHAIN_ACCESS_GROUP,
  KEYCHAIN_SERVICE,
  needsRegistration,
  readDeviceCredential,
  registerDeviceCredential,
  RENEW_WITHIN_MS,
  revokeDeviceCredential,
  startDeviceCredential,
  type DeviceCredential,
} from '../device-credential';
import { KEPT_DEVICE_SETTINGS, wipeLocalData } from '../local-wipe';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('expo-file-system', () => require('@/test/fake-file-system'));
jest.mock('@/lib/google-sign-in', () => ({ getGoogleIdToken: jest.fn(), signOutOfGoogle: async () => {} }));

type StoreOptions = { keychainService?: string; accessGroup?: string; keychainAccessible?: number };
const mockKeychain = new Map<string, string>();
const mockStoreCalls: { op: string; key: string; options: StoreOptions }[] = [];
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 3,
  WHEN_UNLOCKED: 5,
  getItemAsync: jest.fn(async (key: string, options: StoreOptions) => {
    mockStoreCalls.push({ op: 'get', key, options });
    return mockKeychain.get(key) ?? null;
  }),
  setItemAsync: jest.fn(async (key: string, value: string, options: StoreOptions) => {
    mockStoreCalls.push({ op: 'set', key, options });
    mockKeychain.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string, options: StoreOptions) => {
    mockStoreCalls.push({ op: 'delete', key, options });
    mockKeychain.delete(key);
  }),
}));

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const INSTALL = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-23T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const in_ = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

const invoke = supabase.functions.invoke as jest.Mock<(...args: unknown[]) => Promise<unknown>>;

/** `register-device-credential` answers each call with the next token, valid 90 days. */
function serverIssues(...tokens: string[]) {
  for (const token of tokens) invoke.mockResolvedValueOnce({ data: { token, expiresAt: in_(90 * DAY) }, error: null });
}

function stored(): DeviceCredential | null {
  const json = mockKeychain.get(CREDENTIAL_KEY);
  return json ? (JSON.parse(json) as DeviceCredential) : null;
}

function store(credential: DeviceCredential) {
  mockKeychain.set(CREDENTIAL_KEY, JSON.stringify(credential));
}

const registerCalls = () => invoke.mock.calls.filter(([fn]) => fn === 'register-device-credential');

beforeEach(() => {
  resetDb();
  resetSupabase();
  mockKeychain.clear();
  mockStoreCalls.length = 0;
  setDeviceSetting(INSTALLATION_ID_KEY, INSTALL);
  (supabase.auth.signOut as jest.Mock<(...args: unknown[]) => Promise<unknown>>).mockResolvedValue({ error: null });
});

describe('the Keychain item', () => {
  it('is written, read and deleted in the shared access group, after first unlock, this device only', async () => {
    serverIssues('tok-a');
    await registerDeviceCredential(ALICE);
    await readDeviceCredential();
    await revokeDeviceCredential(10);
    expect(mockStoreCalls.map((c) => c.op)).toEqual(['set', 'get', 'delete']);
    for (const call of mockStoreCalls) {
      expect(call.key).toBe('share.credential');
      expect(call.options).toEqual({
        keychainService: 'com.jgp.perfectbite.device-credential',
        accessGroup: '4537GH756L.com.jgp.perfectbite.shared',
        keychainAccessible: 3,
      });
    }
    expect(KEYCHAIN_SERVICE).toBe('com.jgp.perfectbite.device-credential');
  });

  it('reads an unreadable or incomplete item as none', async () => {
    mockKeychain.set(CREDENTIAL_KEY, 'not json');
    expect(await readDeviceCredential()).toBeNull();
    mockKeychain.set(CREDENTIAL_KEY, JSON.stringify({ token: 't', userId: ALICE }));
    expect(await readDeviceCredential()).toBeNull();
  });
});

describe('getInstallationId', () => {
  it('is made once and then kept', () => {
    resetDb();
    expect(getDeviceSetting(INSTALLATION_ID_KEY, null)).toBeNull();
    const id = getInstallationId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(getInstallationId()).toBe(id);
    expect(getDeviceSetting(INSTALLATION_ID_KEY, null)).toBe(id);
  });

  it('survives the sign-out wipe', () => {
    expect(KEPT_DEVICE_SETTINGS).toContain(INSTALLATION_ID_KEY);
    wipeLocalData();
    expect(getInstallationId()).toBe(INSTALL);
  });
});

describe('needsRegistration', () => {
  const fresh: DeviceCredential = { token: 't', userId: ALICE, installationId: INSTALL, expiresAt: in_(60 * DAY) };

  it('is false for this user and install with 30 days or more left', () => {
    expect(needsRegistration(fresh, ALICE, INSTALL, NOW)).toBe(false);
    expect(needsRegistration({ ...fresh, expiresAt: in_(RENEW_WITHIN_MS) }, ALICE, INSTALL, NOW)).toBe(false);
  });

  it('is true with none, under 30 days left, expired, another user or install, or a bad expiry', () => {
    expect(needsRegistration(null, ALICE, INSTALL, NOW)).toBe(true);
    expect(needsRegistration({ ...fresh, expiresAt: in_(RENEW_WITHIN_MS - 1) }, ALICE, INSTALL, NOW)).toBe(true);
    expect(needsRegistration({ ...fresh, expiresAt: in_(-DAY) }, ALICE, INSTALL, NOW)).toBe(true);
    expect(needsRegistration(fresh, BOB, INSTALL, NOW)).toBe(true);
    expect(needsRegistration(fresh, ALICE, '44444444-4444-4444-8444-444444444444', NOW)).toBe(true);
    expect(needsRegistration({ ...fresh, expiresAt: 'soon' }, ALICE, INSTALL, NOW)).toBe(true);
  });
});

describe('register', () => {
  it('after sign-in, registers this install and stores the answer for the user', async () => {
    serverIssues('tok-a');
    expect(await ensureDeviceCredential(ALICE, NOW)).toBe(true);
    expect(registerCalls()).toEqual([['register-device-credential', { body: { installationId: INSTALL } }]]);
    expect(stored()).toEqual({ token: 'tok-a', userId: ALICE, installationId: INSTALL, expiresAt: in_(90 * DAY) });
  });

  it('does nothing with a credential that has 30 days or more left', async () => {
    store({ token: 'tok-a', userId: ALICE, installationId: INSTALL, expiresAt: in_(45 * DAY) });
    expect(await ensureDeviceCredential(ALICE, NOW)).toBe(false);
    expect(registerCalls()).toEqual([]);
    expect(stored()?.token).toBe('tok-a');
  });

  it('keeps nothing, and retries next time, when the function fails or answers oddly', async () => {
    invoke.mockResolvedValueOnce({ data: null, error: { name: 'FunctionsFetchError' } });
    expect(await ensureDeviceCredential(ALICE, NOW)).toBe(false);
    expect(stored()).toBeNull();
    invoke.mockResolvedValueOnce({ data: { token: 42 }, error: null });
    expect(await ensureDeviceCredential(ALICE, NOW)).toBe(false);
    expect(stored()).toBeNull();
    invoke.mockRejectedValueOnce(new Error('network'));
    expect(await ensureDeviceCredential(ALICE, NOW)).toBe(false);
    serverIssues('tok-a');
    expect(await ensureDeviceCredential(ALICE, NOW)).toBe(true);
    expect(registerCalls()).toHaveLength(4);
    expect(stored()?.token).toBe('tok-a');
  });

  it('runs one registration at a time', async () => {
    serverIssues('tok-a', 'tok-b');
    const [first, second] = await Promise.all([ensureDeviceCredential(ALICE, NOW), ensureDeviceCredential(ALICE, NOW)]);
    expect([first, second]).toEqual([true, true]);
    expect(registerCalls()).toHaveLength(1);
    expect(stored()?.token).toBe('tok-a');
  });
});

describe('renew', () => {
  it('registers again on a foreground once under 30 days remain', async () => {
    store({ token: 'tok-old', userId: ALICE, installationId: INSTALL, expiresAt: new Date(Date.now() + 29 * DAY).toISOString() });
    serverIssues('tok-new');
    let onChange: ((next: AppStateStatus) => void) | undefined;
    const remove = jest.fn();
    const listen = jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler) => {
      onChange = handler as (next: AppStateStatus) => void;
      return { remove };
    });
    Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
    // Launch with 29 days left: renews at once; the fresh one then needs nothing on a foreground.
    const stop = startDeviceCredential(ALICE);
    await new Promise((r) => setTimeout(r, 0));
    expect(registerCalls()).toHaveLength(1);
    expect(stored()).toMatchObject({ token: 'tok-new', userId: ALICE, installationId: INSTALL });

    onChange!('background');
    onChange!('active');
    await new Promise((r) => setTimeout(r, 0));
    expect(registerCalls()).toHaveLength(1);

    // Time passes: under 30 days again, and the next foreground renews.
    store({ ...stored()!, expiresAt: new Date(Date.now() + 10 * DAY).toISOString() });
    serverIssues('tok-newer');
    onChange!('background');
    onChange!('active');
    await new Promise((r) => setTimeout(r, 0));
    expect(registerCalls()).toHaveLength(2);
    expect(stored()?.token).toBe('tok-newer');

    stop();
    expect(remove).toHaveBeenCalledTimes(1);
    listen.mockRestore();
  });
});

describe('sign-out', () => {
  beforeEach(() => store({ token: 'tok-a', userId: ALICE, installationId: INSTALL, expiresAt: in_(60 * DAY) }));

  it('online: revokes this install on the server, then deletes the Keychain item', async () => {
    respondToRpc('revoke_my_device_credential', { data: null, error: null });
    await signOut();
    expect(rpcCallsFor('revoke_my_device_credential').map((c) => c.args)).toEqual([{ p_installation_id: INSTALL }]);
    expect(stored()).toBeNull();
    expect(getDeviceSetting(INSTALLATION_ID_KEY, null)).toBe(INSTALL);
    expect(supabase.auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('offline: the revoke fails, and the Keychain item is deleted anyway', async () => {
    supabase.rpc.mockImplementation(async (fn: unknown) => {
      if (fn === 'revoke_my_device_credential') throw new TypeError('Network request failed');
      return { data: null, error: null };
    });
    await signOut();
    expect(stored()).toBeNull();
    expect(supabase.auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('a server error or no answer within the timeout still deletes the Keychain item', async () => {
    respondToRpc('revoke_my_device_credential', { data: null, error: { message: 'boom' } });
    await revokeDeviceCredential(10);
    expect(stored()).toBeNull();

    store({ token: 'tok-a', userId: ALICE, installationId: INSTALL, expiresAt: in_(60 * DAY) });
    supabase.rpc.mockImplementation(() => new Promise(() => {}));
    await revokeDeviceCredential(10);
    expect(stored()).toBeNull();
  });

  it("doesn't store a registration that answers after the sign-out", async () => {
    mockKeychain.clear();
    let answer: (value: unknown) => void = () => {};
    invoke.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const pending = ensureDeviceCredential(ALICE, NOW);
    await new Promise((r) => setTimeout(r, 0));
    await revokeDeviceCredential(10);
    answer({ data: { token: 'tok-late', expiresAt: in_(90 * DAY) }, error: null });
    expect(await pending).toBe(false);
    expect(stored()).toBeNull();
  });
});

describe('account switch', () => {
  it('the new user registers under the same installation id', async () => {
    serverIssues('tok-a', 'tok-b');
    await ensureDeviceCredential(ALICE, NOW);
    expect(stored()).toMatchObject({ token: 'tok-a', userId: ALICE, installationId: INSTALL });

    await signOut();
    wipeLocalData();
    expect(stored()).toBeNull();

    await ensureDeviceCredential(BOB, NOW);
    expect(registerCalls().map(([, options]) => options)).toEqual([
      { body: { installationId: INSTALL } },
      { body: { installationId: INSTALL } },
    ]);
    expect(stored()).toEqual({ token: 'tok-b', userId: BOB, installationId: INSTALL, expiresAt: in_(90 * DAY) });
  });

  it("a credential left for another user (no sign-out) is replaced, not reused", async () => {
    store({ token: 'tok-a', userId: ALICE, installationId: INSTALL, expiresAt: in_(80 * DAY) });
    serverIssues('tok-b');
    expect(await ensureDeviceCredential(BOB, NOW)).toBe(true);
    expect(stored()).toMatchObject({ token: 'tok-b', userId: BOB, installationId: INSTALL });
  });
});

describe('entitlements', () => {
  const GROUP = '$(AppIdentifierPrefix)com.jgp.perfectbite.shared';
  type Entitlements = Record<string, unknown>;
  const ios = appJson.expo.ios as { appleTeamId: string; entitlements: Entitlements };
  const extensions = appJson.expo.extra.eas.build.experimental.ios.appExtensions as {
    targetName: string;
    entitlements: Entitlements;
  }[];

  it('the app, the share target and its EAS entry share the Keychain access group', () => {
    expect(ios.entitlements['keychain-access-groups']).toEqual([GROUP]);
    const target = (shareTargetConfig as (config: unknown) => { entitlements: Entitlements })(appJson.expo);
    expect(target.entitlements['keychain-access-groups']).toEqual([GROUP]);
    expect(extensions.find((e) => e.targetName === 'ShareRecipe')?.entitlements['keychain-access-groups']).toEqual([GROUP]);
  });

  it('the runtime access group is the same group with the team prefix', () => {
    expect(KEYCHAIN_ACCESS_GROUP).toBe(`${ios.appleTeamId}.com.jgp.perfectbite.shared`);
  });
});
