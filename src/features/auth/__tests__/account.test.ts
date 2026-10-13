import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import type * as AccountModule from '../account';
import type * as GoogleSignIn from '@/lib/google-sign-in';
import type * as FakeSupabase from '@/test/fake-supabase';

jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
// The native Google SDK isn't available under Jest.
jest.mock('@/lib/google-sign-in', () => ({ getGoogleIdToken: jest.fn(), signOutOfGoogle: jest.fn(async () => {}) }));

type AuthResult = { data: unknown; error: unknown };
type AuthFn = (...args: any[]) => Promise<AuthResult>;
/** Auth calls the shared fake doesn't script; added onto its `auth` per test. */
type ExtraAuth = {
  signInWithIdToken: jest.Mock<AuthFn>;
  signInWithPassword: jest.Mock<AuthFn>;
  signUp: jest.Mock<AuthFn>;
};

let mod: typeof AccountModule;
let fake: typeof FakeSupabase;
let google: jest.Mocked<typeof GoogleSignIn>;
let auth: typeof FakeSupabase.supabase.auth & ExtraAuth;

const ok = async (): Promise<AuthResult> => ({ data: null, error: null });
const fail = (message: string, code?: string) => async (): Promise<AuthResult> => ({ data: null, error: { message, code } });

beforeEach(() => {
  // account.ts keeps `state` and `started` at module level: load fresh copies.
  jest.resetModules();
  fake = require('@/test/fake-supabase');
  google = require('@/lib/google-sign-in');
  mod = require('../account');
  fake.resetSupabase();
  auth = Object.assign(fake.supabase.auth, {
    signInWithIdToken: jest.fn<AuthFn>(ok),
    signInWithPassword: jest.fn<AuthFn>(ok),
    signUp: jest.fn<AuthFn>(ok),
  });
});

/** Lets the `setTimeout(…, 0)` in the auth listener fire. */
async function flush() {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
}

it('starts loading, then signed out when there is no stored session', async () => {
  expect(mod.getAccountState()).toEqual({ status: 'loading' });
  mod.startAccount();
  fake.emitAuthEvent('INITIAL_SESSION', null);
  await flush();
  expect(mod.getAccountState()).toEqual({ status: 'signedOut' });
});

it('becomes ready on sign-in and signed out on sign-out', async () => {
  mod.startAccount();
  fake.emitAuthEvent('SIGNED_IN', fake.makeSession('u1', 'alex@example.com'));
  await flush();
  expect(mod.getAccount()).toEqual({ userId: 'u1', email: 'alex@example.com' });

  fake.emitAuthEvent('SIGNED_OUT', null);
  await flush();
  expect(mod.getAccount()).toBeNull();
});

it('subscribes to auth only once', () => {
  mod.startAccount();
  mod.startAccount();
  expect(fake.supabase.auth.onAuthStateChange).toHaveBeenCalledTimes(1);
});

it('passes the email and code through to Supabase', async () => {
  await mod.sendEmailCode('alex@example.com');
  await mod.verifyEmailCode('alex@example.com', '123456');
  expect(fake.supabase.auth.signInWithOtp).toHaveBeenCalledWith({
    email: 'alex@example.com',
    options: { shouldCreateUser: true },
  });
  expect(fake.supabase.auth.verifyOtp).toHaveBeenCalledWith({ email: 'alex@example.com', token: '123456', type: 'email' });
});

it('ignores TOKEN_REFRESHED, so a refresh never changes who is signed in', async () => {
  mod.startAccount();
  fake.emitAuthEvent('INITIAL_SESSION', null);
  await flush();
  fake.emitAuthEvent('TOKEN_REFRESHED', fake.makeSession('u1'));
  await flush();
  expect(mod.getAccountState()).toEqual({ status: 'signedOut' });
});

it('applies the auth event after the callback returns (supabase-js deadlock caveat)', async () => {
  mod.startAccount();
  fake.emitAuthEvent('SIGNED_IN', fake.makeSession('u1'));
  expect(mod.getAccountState()).toEqual({ status: 'loading' });
  await flush();
  expect(mod.getAccount()?.userId).toBe('u1');
});

describe('without Supabase configured', () => {
  beforeEach(() => {
    jest.resetModules();
    fake = require('@/test/fake-supabase');
    fake.resetSupabase();
    fake.setSupabaseConfigured(false);
    mod = require('../account');
  });

  it('is unconfigured, has no account and never subscribes to auth', () => {
    expect(mod.getAccountState()).toEqual({ status: 'unconfigured' });
    expect(mod.getAccount()).toBeNull();
    mod.startAccount();
    expect(fake.supabase.auth.onAuthStateChange).not.toHaveBeenCalled();
  });
});

describe('useAccountState', () => {
  it('re-renders with each state change and unsubscribes on unmount', async () => {
    const seen: string[] = [];
    function Probe() {
      seen.push(mod.useAccountState().status);
      return null;
    }
    // The same React the freshly loaded account module uses (jest.resetModules above).
    const { createElement } = require('react') as typeof import('react');
    const { act, create } = require('react-test-renderer') as typeof import('react-test-renderer');
    mod.startAccount();
    let tree!: ReturnType<typeof create>;
    act(() => {
      tree = create(createElement(Probe));
    });
    expect(seen.at(-1)).toBe('loading');

    await act(async () => {
      fake.emitAuthEvent('SIGNED_IN', fake.makeSession('u1'));
      await flush();
    });
    expect(seen.at(-1)).toBe('ready');

    act(() => tree.unmount());
    const renders = seen.length;
    fake.emitAuthEvent('SIGNED_OUT', null);
    await flush();
    expect(mod.getAccountState()).toEqual({ status: 'signedOut' });
    expect(seen).toHaveLength(renders);
  });
});

describe('signInWithGoogle', () => {
  it('exchanges the Google ID token with Supabase', async () => {
    google.getGoogleIdToken.mockResolvedValue('id-token');
    await mod.signInWithGoogle();
    expect(auth.signInWithIdToken).toHaveBeenCalledWith({ provider: 'google', token: 'id-token' });
  });

  it('does nothing when the user cancels the picker', async () => {
    google.getGoogleIdToken.mockResolvedValue(null);
    await expect(mod.signInWithGoogle()).resolves.toBeUndefined();
    expect(auth.signInWithIdToken).not.toHaveBeenCalled();
  });

  it('throws the Supabase error', async () => {
    google.getGoogleIdToken.mockResolvedValue('id-token');
    auth.signInWithIdToken.mockImplementation(fail('Invalid token'));
    await expect(mod.signInWithGoogle()).rejects.toMatchObject({ message: 'Invalid token' });
  });

  it('throws when the Google SDK fails', async () => {
    google.getGoogleIdToken.mockRejectedValue(new Error('Google sign-in is not configured.'));
    await expect(mod.signInWithGoogle()).rejects.toThrow('not configured');
    expect(auth.signInWithIdToken).not.toHaveBeenCalled();
  });
});

describe('email code sign-in', () => {
  it('throws when sending the code fails', async () => {
    fake.supabase.auth.signInWithOtp.mockImplementation(fail('Rate limited'));
    await expect(mod.sendEmailCode('alex@example.com')).rejects.toMatchObject({ message: 'Rate limited' });
  });

  it('throws when the code is wrong', async () => {
    fake.supabase.auth.verifyOtp.mockImplementation(fail('Token has expired or is invalid'));
    await expect(mod.verifyEmailCode('alex@example.com', '000000')).rejects.toMatchObject({
      message: 'Token has expired or is invalid',
    });
  });
});

describe('dev password sign-in', () => {
  const DEV_EMAIL = 'jgpasch@gmail.com';
  const creds = { email: DEV_EMAIL, password: 'perfect-bite-dev' };

  it('recognises the dev email in dev builds, ignoring case and spaces', () => {
    expect(mod.isDevPasswordEmail(DEV_EMAIL)).toBe(true);
    expect(mod.isDevPasswordEmail('  JGPasch@Gmail.com ')).toBe(true);
    expect(mod.isDevPasswordEmail('alex@example.com')).toBe(false);
    expect(mod.isDevPasswordEmail('')).toBe(false);
  });

  it('is off in release builds', () => {
    const g = globalThis as { __DEV__?: boolean };
    const dev = g.__DEV__;
    g.__DEV__ = false;
    try {
      expect(mod.isDevPasswordEmail(DEV_EMAIL)).toBe(false);
    } finally {
      g.__DEV__ = dev;
    }
  });

  it('refuses any other email without calling Supabase', async () => {
    await expect(mod.devPasswordSignIn('alex@example.com')).rejects.toThrow('not available');
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it('signs in with the fixed password, using the canonical email', async () => {
    await mod.devPasswordSignIn(' JGPASCH@gmail.com');
    expect(auth.signInWithPassword).toHaveBeenCalledWith(creds);
    expect(auth.signUp).not.toHaveBeenCalled();
  });

  it('creates the user on first use', async () => {
    auth.signInWithPassword.mockImplementation(fail('Invalid login credentials', 'invalid_credentials'));
    await mod.devPasswordSignIn(DEV_EMAIL);
    expect(auth.signUp).toHaveBeenCalledWith(creds);
  });

  it('reports the sign-in error when the user exists with another password', async () => {
    auth.signInWithPassword.mockImplementation(fail('Invalid login credentials', 'invalid_credentials'));
    auth.signUp.mockImplementation(fail('User already registered', 'user_already_exists'));
    await expect(mod.devPasswordSignIn(DEV_EMAIL)).rejects.toMatchObject({ message: 'Invalid login credentials' });
  });

  it('reports any other sign-up error', async () => {
    auth.signInWithPassword.mockImplementation(fail('Invalid login credentials', 'invalid_credentials'));
    auth.signUp.mockImplementation(fail('Signups not allowed', 'signup_disabled'));
    await expect(mod.devPasswordSignIn(DEV_EMAIL)).rejects.toMatchObject({ message: 'Signups not allowed' });
  });
});

describe('signOut', () => {
  it('signs out of Supabase, then Google', async () => {
    await mod.signOut();
    expect(fake.supabase.auth.signOut).toHaveBeenCalledTimes(1);
    expect(google.signOutOfGoogle).toHaveBeenCalledTimes(1);
  });

  it('throws the Supabase error and stays signed in to Google', async () => {
    fake.supabase.auth.signOut.mockImplementation(fail('Network request failed'));
    await expect(mod.signOut()).rejects.toMatchObject({ message: 'Network request failed' });
    expect(google.signOutOfGoogle).not.toHaveBeenCalled();
  });

  it('ignores a Google sign-out failure', async () => {
    google.signOutOfGoogle.mockRejectedValue(new Error('SIGN_IN_REQUIRED'));
    await expect(mod.signOut()).resolves.toBeUndefined();
  });
});
