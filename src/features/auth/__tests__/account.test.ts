import { beforeEach, expect, it, jest } from '@jest/globals';

import type * as AccountModule from '../account';
import type * as FakeSupabase from '@/test/fake-supabase';

jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
// The native Google SDK isn't available under Jest.
jest.mock('@/lib/google-sign-in', () => ({ getGoogleIdToken: jest.fn(), signOutOfGoogle: jest.fn(async () => {}) }));

let mod: typeof AccountModule;
let fake: typeof FakeSupabase;

beforeEach(() => {
  // account.ts keeps `state` and `started` at module level: load fresh copies.
  jest.resetModules();
  fake = require('@/test/fake-supabase');
  mod = require('../account');
  fake.resetSupabase();
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
