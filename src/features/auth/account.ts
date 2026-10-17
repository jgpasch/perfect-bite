// Session state (spec 4.8). One module-level store so the root layout gate and screens all
// see the same state.
import type { Session } from '@supabase/supabase-js';
import { useSyncExternalStore } from 'react';

import { unregisterPush } from '@/features/push/stored-registration';
import { getGoogleIdToken, signOutOfGoogle } from '@/lib/google-sign-in';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

export type Account = { userId: string; email?: string };

export type AccountState =
  | { status: 'loading' }
  | { status: 'unconfigured' }
  | { status: 'signedOut' }
  | { status: 'ready'; account: Account };

let state: AccountState = isSupabaseConfigured ? { status: 'loading' } : { status: 'unconfigured' };
const listeners = new Set<() => void>();

function setState(next: AccountState) {
  state = next;
  listeners.forEach((l) => l());
}

export function getAccountState(): AccountState {
  return state;
}

export function useAccountState(): AccountState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

/** The signed-in account, or null. */
export function getAccount(): Account | null {
  return state.status === 'ready' ? state.account : null;
}

function load(session: Session | null, beforeReady?: (userId: string) => void) {
  if (!session) return setState({ status: 'signedOut' });
  if (state.status !== 'ready' || state.account.userId !== session.user.id) beforeReady?.(session.user.id);
  setState({ status: 'ready', account: { userId: session.user.id, email: session.user.email } });
}

let started = false;

/**
 * Subscribes to Supabase auth once. Safe to call repeatedly. `beforeReady` runs each time a user
 * is about to become the signed-in account (the root layout wipes another user's data there).
 */
export function startAccount(options: { beforeReady?: (userId: string) => void } = {}) {
  if (started || !isSupabaseConfigured) return;
  started = true;
  supabase.auth.onAuthStateChange((event, session) => {
    // INITIAL_SESSION fires on subscribe with the stored session (or null).
    if (event === 'TOKEN_REFRESHED') return;
    // Don't await Supabase calls inside the callback (supabase-js deadlock caveat).
    setTimeout(() => load(session, options.beforeReady), 0);
  });
}

// --- Sign-in ------------------------------------------------------------------------------

/** Google sign-in (spec 4.8). Resolves without signing in if the user cancels the picker. */
export async function signInWithGoogle(): Promise<void> {
  const token = await getGoogleIdToken();
  if (!token) return;
  const { error } = await supabase.auth.signInWithIdToken({ provider: 'google', token });
  if (error) throw error;
}

/**
 * Dev-only email sign-in with a 6-digit code (local Supabase delivers it to the mail viewer,
 * http://127.0.0.1:55324). Shown only in dev builds, next to Google.
 */
export async function sendEmailCode(email: string): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
  if (error) throw error;
}

// Dev builds only: this email skips the code step and signs in with a fixed password, creating
// the user on first use. `__DEV__` is false in release builds, so this path is stripped there.
const DEV_PASSWORD_EMAIL = 'jgpasch@gmail.com';
const DEV_PASSWORD = 'perfect-bite-dev';

export function isDevPasswordEmail(email: string): boolean {
  return __DEV__ && email.trim().toLowerCase() === DEV_PASSWORD_EMAIL;
}

export async function devPasswordSignIn(email: string): Promise<void> {
  if (!isDevPasswordEmail(email)) throw new Error('Dev password sign-in is not available.');
  const signIn = await supabase.auth.signInWithPassword({ email: DEV_PASSWORD_EMAIL, password: DEV_PASSWORD });
  if (!signIn.error) return;
  const signUp = await supabase.auth.signUp({ email: DEV_PASSWORD_EMAIL, password: DEV_PASSWORD });
  // "Already registered" means the user exists without this password: report the sign-in error.
  if (signUp.error) throw signUp.error.code === 'user_already_exists' ? signIn.error : signUp.error;
}

export async function verifyEmailCode(email: string, token: string): Promise<void> {
  const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' });
  if (error) throw error;
}

/** Signs out of Supabase and Google, after removing this device's push token (best effort, spec 4.13). */
export async function signOut(): Promise<void> {
  await unregisterPush();
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  await signOutOfGoogle().catch(() => {});
}

/**
 * Signs out of this device only, after the account was deleted (spec 4.8): the server session is
 * already gone, so the server's answer is ignored and this never throws.
 */
export async function signOutLocally(): Promise<void> {
  await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
  await signOutOfGoogle().catch(() => {});
}
