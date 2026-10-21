import type { SupabaseClient } from '@supabase/supabase-js';
import { assertEquals, assertRejects } from '@std/assert';

import { createRecipeImportStore } from './store.ts';

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
  } as unknown as SupabaseClient;
  return { admin, calls };
}

Deno.test('checkLimit: the household is passed to check_recipe_import_limit', async () => {
  const { admin, calls } = fakeAdmin({ data: 'ok', error: null });
  assertEquals(await createRecipeImportStore(admin, { userId: USER }).checkLimit(HOUSEHOLD), 'ok');
  assertEquals(calls, [{ fn: 'check_recipe_import_limit', args: { p_user_id: USER, p_household_id: HOUSEHOLD } }]);
});

Deno.test('checkLimit: a refusal is returned as answered', async () => {
  const { admin } = fakeAdmin({ data: 'monthly_limit', error: null });
  assertEquals(await createRecipeImportStore(admin, { userId: USER }).checkLimit(HOUSEHOLD), 'monthly_limit');
});

Deno.test('requireFeature: has_feature is asked about the request\'s household', async () => {
  const { admin, calls } = fakeAdmin({ data: true, error: null });
  await createRecipeImportStore(admin, { userId: USER }).requireFeature('recipe_import', HOUSEHOLD);
  assertEquals(calls, [{ fn: 'has_feature', args: { p_user_id: USER, p_feature: 'recipe_import', p_household_id: HOUSEHOLD } }]);
});

Deno.test('checkLimit: an rpc error is thrown', async () => {
  const error = new Error('boom');
  const { admin } = fakeAdmin({ data: null, error });
  const thrown = await assertRejects(() => createRecipeImportStore(admin, { userId: USER }).checkLimit(HOUSEHOLD));
  assertEquals(thrown, error);
});
