// The secret-key check in index.ts (withSupabase): only cron, with the key, gets in.
import { assertEquals } from '@std/assert';

const KEY = 'sb_secret_test_worker_key';
Deno.env.set('SUPABASE_URL', 'http://127.0.0.1:1');
Deno.env.set('SUPABASE_SECRET_KEYS', JSON.stringify({ default: KEY }));
Deno.env.set('SUPABASE_PUBLISHABLE_KEYS', JSON.stringify({ default: 'sb_publishable_test' }));
const { default: worker } = await import('./index.ts');

const call = (headers: Record<string, string>, method = 'POST') =>
  worker.fetch(new Request('http://localhost/functions/v1/send-notifications', { method, headers }));

Deno.test('a caller without the key gets 401', async () => {
  const res = await call({});
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test('a caller with the wrong key, or a publishable key, gets 401', async () => {
  for (const apikey of ['sb_secret_wrong', 'sb_publishable_test']) {
    const res = await call({ apikey });
    assertEquals(res.status, 401, apikey);
    await res.body?.cancel();
  }
});

Deno.test('the secret key gets past auth (a GET then answers 405 without touching the database)', async () => {
  const res = await call({ apikey: KEY }, 'GET');
  assertEquals(res.status, 405);
  await res.body?.cancel();
});
