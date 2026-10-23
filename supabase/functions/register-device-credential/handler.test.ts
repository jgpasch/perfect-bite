// register-device-credential (spec 6.12) through handleRequest with a fake service-role client:
// what it sends to register_device_credential, what it answers, and that the token isn't logged.
import { assertEquals, assertMatch, assertNotEquals, assertRejects } from '@std/assert';

import { hashDeviceToken, type RpcClient } from '../_shared/device-credentials.ts';
import { createRegisterStore, registerDeviceCredential } from './handler.ts';
import { handleRequest } from './request.ts';

const ENDPOINT = 'http://localhost/functions/v1/register-device-credential';
const ann = '11111111-1111-1111-1111-111111111111';
const install = '0b0e4f6a-7d1c-4e43-9a8b-6f2d9c3e1a50';

function fakeAdmin(answer: { data: unknown; error: { message: string } | null }) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const admin: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      return Promise.resolve(answer);
    },
  };
  return { admin, calls };
}

const post = (body: unknown) =>
  new Request(ENDPOINT, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

function serve(admin: RpcClient, random?: (bytes: Uint8Array) => Uint8Array) {
  const store = createRegisterStore(admin, ann);
  return (req: Request) => handleRequest(req, { register: (request) => registerDeviceCredential(request, { store, random }) });
}

Deno.test('registers the token by its hash for the user and installation, and returns it once', async () => {
  const { admin, calls } = fakeAdmin({ data: '2027-01-20T12:00:00.123456+00:00', error: null });
  const res = await serve(admin, (bytes) => bytes.map((_, i) => i))(post({ installationId: install }));

  assertEquals(res.status, 200);
  assertEquals(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assertEquals(body, { token: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', expiresAt: '2027-01-20T12:00:00.123Z' });
  assertEquals(calls, [{
    fn: 'register_device_credential',
    args: {
      p_user_id: ann,
      p_installation_id: install,
      p_token_hash: '630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd',
    },
  }]);
});

Deno.test('a new random token each time, never sent to the database', async () => {
  const { admin, calls } = fakeAdmin({ data: '2027-01-20T12:00:00+00:00', error: null });
  const first = await (await serve(admin)(post({ installationId: install }))).json();
  const second = await (await serve(admin)(post({ installationId: install }))).json();
  assertMatch(first.token, /^[A-Za-z0-9_-]{43}$/);
  assertNotEquals(first.token, second.token);
  assertEquals(calls[0].args.p_token_hash, await hashDeviceToken(first.token));
  assertEquals(calls[1].args.p_token_hash, await hashDeviceToken(second.token));
  assertEquals(JSON.stringify(calls).includes(first.token), false);
});

Deno.test('an upper-case installation id is sent lower-case', async () => {
  const { admin, calls } = fakeAdmin({ data: '2027-01-20T12:00:00+00:00', error: null });
  assertEquals((await serve(admin)(post({ installationId: install.toUpperCase() }))).status, 200);
  assertEquals(calls[0].args.p_installation_id, install);
});

Deno.test('a missing or malformed installationId → 400, nothing registered', async () => {
  const { admin, calls } = fakeAdmin({ data: '2027-01-20T12:00:00+00:00', error: null });
  for (const body of [{}, { installationId: 'abc' }, { installationId: 42 }, null, []]) {
    const res = await serve(admin)(post(body));
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, 'invalid_request');
  }
  const bad = await serve(admin)(new Request(ENDPOINT, { method: 'POST', body: '{' }));
  assertEquals(bad.status, 400);
  assertEquals(calls, []);
});

Deno.test('only POST; a body over 1 KB → 413', async () => {
  const { admin } = fakeAdmin({ data: '2027-01-20T12:00:00+00:00', error: null });
  assertEquals((await serve(admin)(new Request(ENDPOINT, { method: 'GET' }))).status, 405);
  const big = await serve(admin)(post({ installationId: install, pad: 'x'.repeat(2000) }));
  assertEquals(big.status, 413);
  assertEquals((await big.json()).error, 'payload_too_large');
});

Deno.test('a database error → 500, and nothing logged holds the token', async () => {
  const { admin } = fakeAdmin({ data: null, error: { message: 'duplicate key value' } });
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '));
  let token = '';
  try {
    const res = await serve(admin, (bytes) => {
      bytes.fill(7);
      token = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';
      return bytes;
    })(post({ installationId: install }));
    assertEquals(res.status, 500);
    assertEquals(await res.json(), { error: 'internal_error', message: 'Registering the device failed' });
  } finally {
    console.error = original;
  }
  assertEquals(logged.length, 1);
  assertMatch(logged[0], /duplicate key value/);
  assertEquals(logged[0].includes(token), false);
});

Deno.test('createRegisterStore: no expiry back is an error', async () => {
  const { admin } = fakeAdmin({ data: null, error: null });
  await assertRejects(() => createRegisterStore(admin, ann).register(install, 'ab'.repeat(32)), Error, 'no expiry');
});
