// The device credential (spec 6.12, 4.9): a token the share extension sends to `share-ingest` in
// a background upload, since it can't use the app's Supabase session. The app registers it after
// sign-in and renews it on foreground; it lives in a Keychain access group shared with the
// extension. iOS only: the share extension is the only reader.
//
// The extension reads the item as expo-secure-store writes it: a generic password with
// `kSecAttrService` `KEYCHAIN_SERVICE + ":no-auth"`, `kSecAttrAccount` the UTF-8 of
// `CREDENTIAL_KEY`, in `KEYCHAIN_ACCESS_GROUP`; its value is the JSON of `DeviceCredential`.
import * as SecureStore from 'expo-secure-store';
import { AppState, Platform } from 'react-native';
import { v4 as uuidv4 } from 'uuid';

import { cameToForeground } from '@/features/categories/catch-up';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { supabase } from '@/lib/supabase';

/**
 * The shared access group: the team id (`appleTeamId` in app.json, which is the
 * `$(AppIdentifierPrefix)` of the `keychain-access-groups` entitlements) plus the group name.
 */
export const KEYCHAIN_ACCESS_GROUP = '4537GH756L.com.jgp.perfectbite.shared';
export const KEYCHAIN_SERVICE = 'com.jgp.perfectbite.device-credential';
export const CREDENTIAL_KEY = 'share.credential';

/** Device setting holding this install's id: made once, kept by the sign-out wipe. */
export const INSTALLATION_ID_KEY = 'device.installationId';

/** Renew when less than this is left (the server issues 90 days). */
export const RENEW_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;

/** How long sign-out waits for `revoke_my_device_credential` before going on. */
export const REVOKE_TIMEOUT_MS = 2000;

export type DeviceCredential = { token: string; userId: string; installationId: string; expiresAt: string };

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: KEYCHAIN_SERVICE,
  accessGroup: KEYCHAIN_ACCESS_GROUP,
  // Never in a backup or device migration; readable by a background upload while locked.
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

const supported = () => Platform.OS === 'ios';

/** This install's id, made on first use. It lives in SQLite, so a reinstall gets a new one. */
export function getInstallationId(): string {
  const stored = getDeviceSetting<string | null>(INSTALLATION_ID_KEY, null);
  if (stored) return stored;
  const id = uuidv4();
  setDeviceSetting(INSTALLATION_ID_KEY, id);
  return id;
}

/** The stored credential, or null if there is none or it's unreadable. Never throws. */
export async function readDeviceCredential(): Promise<DeviceCredential | null> {
  try {
    const json = await SecureStore.getItemAsync(CREDENTIAL_KEY, OPTIONS);
    if (!json) return null;
    const value = JSON.parse(json) as Record<string, unknown>;
    const { token, userId, installationId, expiresAt } = value ?? {};
    if (
      typeof token !== 'string' ||
      typeof userId !== 'string' ||
      typeof installationId !== 'string' ||
      typeof expiresAt !== 'string'
    ) {
      return null;
    }
    return { token, userId, installationId, expiresAt };
  } catch (err) {
    console.warn('[credential] reading the device credential failed', err);
    return null;
  }
}

/**
 * Whether `userId` needs a new credential: none stored, one for another user or install, or one
 * with under 30 days left (or an unreadable expiry).
 */
export function needsRegistration(
  credential: DeviceCredential | null,
  userId: string,
  installationId: string,
  now: Date,
): boolean {
  if (!credential || credential.userId !== userId || credential.installationId !== installationId) return true;
  const expires = Date.parse(credential.expiresAt);
  return !Number.isFinite(expires) || expires - now.getTime() < RENEW_WITHIN_MS;
}

// Bumped by every sign-out, so a registration that answers afterwards isn't stored.
let generation = 0;
let inFlight: Promise<boolean> | null = null;

/**
 * Calls `register-device-credential` for this install and stores the answer for `userId`. Returns
 * whether a credential was stored. Never throws: a failure is retried on the next foreground.
 */
export async function registerDeviceCredential(userId: string): Promise<boolean> {
  const started = generation;
  try {
    const installationId = getInstallationId();
    const { data, error } = await supabase.functions.invoke('register-device-credential', { body: { installationId } });
    if (error) {
      console.warn('[credential] registering the device failed', error);
      return false;
    }
    const { token, expiresAt } = (data ?? {}) as Record<string, unknown>;
    if (typeof token !== 'string' || typeof expiresAt !== 'string') {
      console.warn('[credential] register-device-credential: unexpected response');
      return false;
    }
    if (started !== generation) return false;
    const credential: DeviceCredential = { token, userId, installationId, expiresAt };
    await SecureStore.setItemAsync(CREDENTIAL_KEY, JSON.stringify(credential), OPTIONS);
    return true;
  } catch (err) {
    console.warn('[credential] registering the device failed', err);
    return false;
  }
}

/**
 * Registers if `userId` has no usable credential on this install (after sign-in, an account
 * switch, or under 30 days left). One registration at a time. Never throws.
 */
export function ensureDeviceCredential(userId: string, now: Date = new Date()): Promise<boolean> {
  if (!supported()) return Promise.resolve(false);
  if (inFlight) return inFlight;
  const run = (async () => {
    const credential = await readDeviceCredential();
    if (!needsRegistration(credential, userId, getInstallationId(), now)) return false;
    return registerDeviceCredential(userId);
  })().finally(() => {
    inFlight = null;
  });
  inFlight = run;
  return run;
}

/** Deletes the Keychain item. Never throws. */
export async function forgetDeviceCredential(): Promise<void> {
  generation += 1;
  inFlight = null;
  if (!supported()) return;
  try {
    await SecureStore.deleteItemAsync(CREDENTIAL_KEY, OPTIONS);
  } catch (err) {
    console.warn('[credential] deleting the device credential failed', err);
  }
}

/**
 * Before sign-out: revokes this install's credential on the server (best effort: offline it stays
 * valid until it expires, and the next sign-in replaces it), then always deletes the Keychain item.
 * Gives up on the server after `timeoutMs`; never throws.
 */
export async function revokeDeviceCredential(timeoutMs = REVOKE_TIMEOUT_MS): Promise<void> {
  if (!supported()) return;
  generation += 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const installationId = getDeviceSetting<string | null>(INSTALLATION_ID_KEY, null);
    if (installationId) {
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      const call = Promise.resolve(
        supabase.rpc('revoke_my_device_credential', { p_installation_id: installationId }),
      ).then(
        ({ error }) => {
          if (error) console.warn('[credential] revoking the device credential failed', error);
        },
        (err: unknown) => console.warn('[credential] revoking the device credential failed', err),
      );
      await Promise.race([call, timeout]);
    }
  } catch (err) {
    console.warn('[credential] revoking the device credential failed', err);
  } finally {
    clearTimeout(timer);
    await forgetDeviceCredential();
  }
}

/** While signed in: registers if needed now, and on every return to the foreground. Returns a stop function. */
export function startDeviceCredential(userId: string): () => void {
  if (!supported()) return () => {};
  const refresh = () => void ensureDeviceCredential(userId);
  refresh();
  let appState = AppState.currentState;
  const app = AppState.addEventListener('change', (next) => {
    if (cameToForeground(appState, next)) refresh();
    appState = next;
  });
  return () => app.remove();
}
