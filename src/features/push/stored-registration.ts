// The push token this device last registered (spec 4.13), and dropping it on sign-out. Kept apart
// from `registration.ts` so `auth/account.ts` can call `unregisterPush` without an import cycle.
import { clearDeviceSetting, getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { supabase } from '@/lib/supabase';

/** Device setting holding the last registration. Not kept by the sign-out wipe. */
export const PUSH_REGISTRATION_KEY = 'push.registration';

/** How long sign-out waits for `unregister_push_token` before signing out anyway. */
export const UNREGISTER_TIMEOUT_MS = 2000;

/** The last token sent with `register_push_token`: for whom, and when (ISO). */
export type PushRegistration = { token: string; userId: string; at: string };

/** The stored registration, or null if there is none or it's unreadable. */
export function getPushRegistration(): PushRegistration | null {
  const value = getDeviceSetting<unknown>(PUSH_REGISTRATION_KEY, null);
  if (!value || typeof value !== 'object') return null;
  const { token, userId, at } = value as Record<string, unknown>;
  if (typeof token !== 'string' || typeof userId !== 'string' || typeof at !== 'string') return null;
  return { token, userId, at };
}

export function setPushRegistration(registration: PushRegistration): void {
  setDeviceSetting(PUSH_REGISTRATION_KEY, registration);
}

export function clearPushRegistration(): void {
  clearDeviceSetting(PUSH_REGISTRATION_KEY);
}

/**
 * Before sign-out: removes this device's token from the server, so the next pushes don't reach a
 * signed-out device, then forgets it. Best effort: gives up after `timeoutMs`, and never throws.
 */
export async function unregisterPush(timeoutMs = UNREGISTER_TIMEOUT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const registration = getPushRegistration();
    if (registration) {
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      });
      const call = Promise.resolve(supabase.rpc('unregister_push_token', { p_token: registration.token })).then(
        ({ error }) => {
          if (error) console.warn('[push] unregistering the token failed', error);
        },
        (err: unknown) => console.warn('[push] unregistering the token failed', err),
      );
      await Promise.race([call, timeout]);
    }
  } catch (err) {
    console.warn('[push] unregistering the token failed', err);
  } finally {
    clearTimeout(timer);
    try {
      clearPushRegistration();
    } catch (err) {
      console.warn('[push] forgetting the token failed', err);
    }
  }
}
