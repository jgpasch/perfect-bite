import type { SupabaseClient } from '@supabase/supabase-js';
import { assertEquals, assertRejects } from '@std/assert';

import { NotEntitledError, requireFeature } from './entitlements.ts';

const USER = '019a4c10-0000-7000-8000-0000000de701';
const HOUSEHOLD = '019a4c10-0000-7000-8000-00000000a001';

/** A service-role client whose `rpc` records each call and answers `answer`. */
function fakeAdmin(answer: { data: unknown; error: unknown }) {
  const calls: { fn: string; args: unknown }[] = [];
  const admin = {
    rpc: (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return Promise.resolve(answer);
    },
  } as unknown as Pick<SupabaseClient, 'rpc'>;
  return { admin, calls };
}

Deno.test('requireFeature: has_feature true resolves, calling it once with the user and feature', async () => {
  const { admin, calls } = fakeAdmin({ data: true, error: null });
  assertEquals(await requireFeature(admin, USER, 'recipe_photo_ai'), undefined);
  assertEquals(calls, [{ fn: 'has_feature', args: { p_user_id: USER, p_feature: 'recipe_photo_ai', p_household_id: null } }]);
});

Deno.test('requireFeature: the household, when given, is passed through', async () => {
  const { admin, calls } = fakeAdmin({ data: true, error: null });
  await requireFeature(admin, USER, 'recipe_import', HOUSEHOLD);
  assertEquals(calls[0].args, { p_user_id: USER, p_feature: 'recipe_import', p_household_id: HOUSEHOLD });
});

Deno.test('requireFeature: has_feature false throws NotEntitledError naming the feature', async () => {
  const { admin } = fakeAdmin({ data: false, error: null });
  const err = await assertRejects(() => requireFeature(admin, USER, 'recipe_import'), NotEntitledError);
  assertEquals(err.feature, 'recipe_import');
  assertEquals(err.name, 'NotEntitledError');
  assertEquals(err.message, "Your plan doesn't include recipe_import");
});

Deno.test('requireFeature: anything but true (null, a string) is not entitled', async () => {
  for (const data of [null, 'true', 1]) {
    const { admin } = fakeAdmin({ data, error: null });
    await assertRejects(() => requireFeature(admin, USER, 'recipe_photo_ai'), NotEntitledError);
  }
});

Deno.test('requireFeature: a database error is thrown as is, not as NotEntitledError', async () => {
  const dbError = { message: 'permission denied for function has_feature', code: '42501' };
  const { admin } = fakeAdmin({ data: null, error: dbError });
  const err = await requireFeature(admin, USER, 'recipe_import').then(
    () => null,
    (e: unknown) => e,
  );
  assertEquals(err, dbError);
});
