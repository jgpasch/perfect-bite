import { assertEquals, assertMatch, assertNotEquals, assertRejects } from '@std/assert';

import { hashDeviceToken, newDeviceToken, type RpcClient, verifyDeviceCredential } from './device-credentials.ts';

const ann = '11111111-1111-1111-1111-111111111111';

/** 32 bytes 0, 1, …, 31, as base64url. */
const COUNTING = newDeviceToken((bytes) => bytes.map((_, i) => i));
/** sha256 of the bytes 0…31. */
const COUNTING_SHA256 = '630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd';

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

Deno.test('newDeviceToken: 32 random bytes as base64url, different each time', () => {
  assertEquals(COUNTING, 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8');
  const a = newDeviceToken();
  assertMatch(a, /^[A-Za-z0-9_-]{43}$/);
  assertNotEquals(a, newDeviceToken());
});

Deno.test('newDeviceToken: base64url, not base64', () => {
  assertEquals(newDeviceToken((bytes) => bytes.fill(0xff)), '_'.repeat(42) + '8');
  assertEquals(newDeviceToken((bytes) => bytes.fill(0xfb)), '-_v7'.repeat(10) + '-_s');
});

Deno.test('hashDeviceToken: the sha256 of the 32 bytes as hex', async () => {
  assertEquals(await hashDeviceToken(COUNTING), COUNTING_SHA256);
});

Deno.test('hashDeviceToken: null for anything but 32 bytes of base64url', async () => {
  assertEquals(await hashDeviceToken(''), null);
  assertEquals(await hashDeviceToken('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHg'), null); // 31 bytes
  assertEquals(await hashDeviceToken(COUNTING + 'AAAA'), null); // 35 bytes
  assertEquals(await hashDeviceToken(COUNTING.replace('A', '+')), null); // base64, not base64url
  assertEquals(await hashDeviceToken(COUNTING + '='), null);
  assertEquals(await hashDeviceToken('not a token at all!'), null);
  assertEquals(await hashDeviceToken('A'), null); // not decodable
});

Deno.test('verifyDeviceCredential: the user id from use_device_credential, by hash and scope', async () => {
  const { admin, calls } = fakeAdmin({ data: ann, error: null });
  assertEquals(await verifyDeviceCredential(admin, COUNTING, 'share.ingest'), ann);
  assertEquals(calls, [{ fn: 'use_device_credential', args: { p_token_hash: COUNTING_SHA256, p_scope: 'share.ingest' } }]);
});

Deno.test('verifyDeviceCredential: null when the database finds no valid credential', async () => {
  // Unknown, revoked, expired and out-of-scope all come back as null from the RPC.
  const { admin, calls } = fakeAdmin({ data: null, error: null });
  assertEquals(await verifyDeviceCredential(admin, COUNTING, 'siri.add'), null);
  assertEquals(calls[0].args.p_scope, 'siri.add');
});

Deno.test('verifyDeviceCredential: a malformed token is null without asking the database', async () => {
  const { admin, calls } = fakeAdmin({ data: ann, error: null });
  assertEquals(await verifyDeviceCredential(admin, '', 'share.ingest'), null);
  assertEquals(await verifyDeviceCredential(admin, 'Bearer abc', 'share.ingest'), null);
  assertEquals(calls, []);
});

Deno.test('verifyDeviceCredential: a database error throws, without the token', async () => {
  const { admin } = fakeAdmin({ data: null, error: { message: 'connection reset' } });
  const err = await assertRejects(() => verifyDeviceCredential(admin, COUNTING, 'share.ingest'), Error, 'connection reset');
  assertEquals(err.message.includes(COUNTING), false);
});
