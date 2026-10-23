// Registering this device for push notifications (spec 4.13). The permission is asked only from
// Settings (`requestPushPermission`), never at launch; sign-in, each foreground and a new token from
// the OS only refresh a token the user already allowed.
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { AppState, Platform } from 'react-native';

import { getAccount } from '@/features/auth/account';
import { cameToForeground } from '@/features/categories/catch-up';
import { reportError } from '@/lib/sentry';
import { supabase } from '@/lib/supabase';

import { getPushRegistration, setPushRegistration, type PushRegistration } from './stored-registration';

/** The OS permission, or `unavailable` where push can't work (web, a simulator, signed out). */
export type PushPermission = 'granted' | 'denied' | 'undetermined' | 'unavailable';

/** An unchanged token is sent again after this long, so the server's `updated_at` stays fresh. */
export const REREGISTER_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** The Android channel pushes arrive on. iOS ignores it. */
export const ANDROID_CHANNEL_ID = 'default';

function pushSupported(): boolean {
  return Platform.OS !== 'web' && Device.isDevice;
}

/** True when `token` for `userId` must be (re)sent, given the last registration. */
export function needsRegistration(last: PushRegistration | null, token: string, userId: string, now: Date): boolean {
  if (!last || last.token !== token || last.userId !== userId) return true;
  const at = Date.parse(last.at);
  return Number.isNaN(at) || now.getTime() - at > REREGISTER_AFTER_MS;
}

function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId;
}

/** The notification permission now, without asking. */
export async function getPushPermission(): Promise<PushPermission> {
  if (!pushSupported()) return 'unavailable';
  try {
    return (await Notifications.getPermissionsAsync()).status;
  } catch (err) {
    console.warn('[push] reading the permission failed', err);
    return 'unavailable';
  }
}

/**
 * Registers this device's Expo push token for the signed-in user, asking for the permission only
 * when `prompt` is true and it was never asked. Returns the permission it ended with. Never throws:
 * a failed token fetch or RPC is logged and retried on the next run.
 */
export async function registerForPush({ prompt }: { prompt: boolean }): Promise<PushPermission> {
  if (!pushSupported()) return 'unavailable';
  const account = getAccount();
  if (!account) return 'unavailable';
  let status: PushPermission = 'unavailable';
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
        name: 'Default',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    status = (await Notifications.getPermissionsAsync()).status;
    if (prompt && status === 'undetermined') status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return status;

    const id = projectId();
    if (!id) {
      console.warn('[push] no EAS projectId in the app config; not registering');
      reportError(new Error('No EAS projectId in the app config; push is off'), { area: 'push', event: 'no_project_id' });
      return status;
    }
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: id });
    const now = new Date();
    if (!needsRegistration(getPushRegistration(), token, account.userId, now)) return status;
    // Signed out (or someone else signed in) while the token was fetched: that sign-in registers.
    if (getAccount()?.userId !== account.userId) return status;
    const { error } = await supabase.rpc('register_push_token', { p_token: token, p_platform: Platform.OS });
    if (error) {
      console.warn('[push] registering the token failed', error);
      // A code means the server refused it; without one it's the network, and the next run retries.
      if (error.code) reportError(error, { area: 'push', event: 'register_failed' });
      return status;
    }
    setPushRegistration({ token, userId: account.userId, at: now.toISOString() });
  } catch (err) {
    console.warn('[push] registering for push failed', err);
  }
  return status;
}

/** Settings > Notifications: asks for the permission if it was never asked, then registers. */
export function requestPushPermission(): Promise<PushPermission> {
  return registerForPush({ prompt: true });
}

/**
 * While signed in: refreshes the registration now (sign-in or launch), on every return to the
 * foreground and whenever the OS hands out a new token. Never prompts. Returns a stop function.
 */
export function startPushRegistration(): () => void {
  if (!pushSupported()) return () => {};
  const refresh = () => void registerForPush({ prompt: false });
  refresh();
  let appState = AppState.currentState;
  const app = AppState.addEventListener('change', (next) => {
    if (cameToForeground(appState, next)) refresh();
    appState = next;
  });
  const tokens = Notifications.addPushTokenListener(refresh);
  return () => {
    app.remove();
    tokens.remove();
  };
}
