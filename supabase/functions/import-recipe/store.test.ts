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

Deno.test('checkLimit: no household (an old build) sends null, so the user\'s oldest counts', async () => {
  const { admin, calls } = fakeAdmin({ data: 'monthly_limit', error: null });
  assertEquals(await createRecipeImportStore(admin, { userId: USER }).checkLimit(), 'monthly_limit');
  assertEquals(calls[0].args, { p_user_id: USER, p_household_id: null });
});

Deno.test('checkLimit: an rpc error is thrown', async () => {
  const error = new Error('boom');
  const { admin } = fakeAdmin({ data: null, error });
  const thrown = await assertRejects(() => createRecipeImportStore(admin, { userId: USER }).checkLimit(HOUSEHOLD));
  assertEquals(thrown, error);
});
