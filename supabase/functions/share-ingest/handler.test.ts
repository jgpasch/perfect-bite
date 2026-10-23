// share-ingest (spec 6.12) through handleRequest, with a fake authenticator and an in-memory store
// that answers as ingest_share_import does (its SQL is covered by pgTAP): every answer, a resubmit
// after a lost response, the account mismatch and the operation conflict.
import { assertEquals, assertNotEquals, assertRejects } from '@std/assert';

import type { ShareEnvelope } from '@shared/index.ts';
import type { RpcClient } from '../_shared/device-credentials.ts';
import {
  canonicalJson,
  createShareIngestStore,
  type ShareImportStatus,
  type ShareIngestAuth,
  type ShareIngestOutcome,
  type ShareIngestRow,
  type ShareIngestStore,
  sharePayloadHash,
} from './handler.ts';
import { handleRequest, MAX_BODY_BYTES, type RequestDeps } from './request.ts';

const ENDPOINT = 'http://localhost/functions/v1/share-ingest';
const alex = '11111111-1111-4111-8111-111111111111';
const sam = '22222222-2222-4222-8222-222222222222';
const home = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const away = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const groceries = 'c0000000-0000-4000-8000-000000000001';
const awayList = 'c0000000-0000-4000-8000-000000000002';
const credential = 'd0000000-0000-4000-8000-000000000001';
const opId = '0192f0c4-7b1a-7c3d-8e4f-123456789abc';

const SESSION = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhbGV4In0.sig';
const DEVICE = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

const envelope = (overrides: Record<string, unknown> = {}) => ({
  v: 2,
  id: opId,
  userId: alex,
  url: 'https://www.example.com/lemon-pasta/?utm_source=share',
  householdId: home,
  listId: groceries,
  addToList: true,
  page: { title: '  Lemon pasta ', jsonLd: ['{"@type":"Recipe"}'], text: 'Boil the pasta.' },
  createdAt: '2026-10-22T09:30:00.000Z',
  appVersion: '1.4.0',
  source: 'share',
  ...overrides,
});

/** Answers as ingest_share_import: the id first, then the household, membership and list. */
function memoryStore(options: { limit?: number } = {}) {
  const rows = new Map<string, ShareIngestRow & { status: ShareImportStatus }>();
  const members: Record<string, string[]> = { [home]: [alex], [away]: [sam] };
  const lists: Record<string, string> = { [groceries]: home, [awayList]: away };
  const used = new Map<string, number>();
  const limitCalls: string[] = [];
  const store: ShareIngestStore = {
    checkLimit(credentialId) {
      limitCalls.push(credentialId);
      const n = used.get(credentialId) ?? 0;
      if (n >= (options.limit ?? 30)) return Promise.resolve('user_limit');
      used.set(credentialId, n + 1);
      return Promise.resolve('ok');
    },
    ingest(row): Promise<ShareIngestOutcome> {
      const existing = rows.get(row.id);
      if (existing) {
        return Promise.resolve(
          existing.userId === row.userId && existing.payloadHash === row.payloadHash
            ? { outcome: 'accepted', status: existing.status }
            : { outcome: 'conflict' },
        );
      }
      const household = row.householdId ?? (row.listId ? lists[row.listId] : undefined);
      if (row.listId && !lists[row.listId]) return Promise.resolve({ outcome: 'invalid_list' });
      if (!household || !members[household]?.includes(row.userId)) return Promise.resolve({ outcome: 'not_a_member' });
      if (row.listId && lists[row.listId] !== household) return Promise.resolve({ outcome: 'invalid_list' });
      rows.set(row.id, { ...row, householdId: household, status: 'received' });
      return Promise.resolve({ outcome: 'accepted', status: 'received' });
    },
  };
  return { store, rows, limitCalls };
}

const users: Record<string, ShareIngestAuth> = {
  [SESSION]: { userId: alex, credentialId: null },
  [DEVICE]: { userId: alex, credentialId: credential },
};

function serve(store: ShareIngestStore, overrides: Partial<RequestDeps> = {}) {
  const authenticated: string[] = [];
  let workerStarts = 0;
  const deps: RequestDeps = {
    authenticate: (token) => {
      authenticated.push(token);
      return Promise.resolve(users[token] ?? null);
    },
    store,
    startWorker: () => void workerStarts++,
    env: () => undefined,
    ...overrides,
  };
  return {
    call: (req: Request) => handleRequest(req, deps),
    authenticated,
    workerStarts: () => workerStarts,
  };
}

function post(body: unknown, headers: Record<string, string | null> = {}) {
  const all: Record<string, string | null> = {
    authorization: `Bearer ${SESSION}`,
    'idempotency-key': opId,
    'content-type': 'application/json',
    ...headers,
  };
  const h = new Headers();
  for (const [k, v] of Object.entries(all)) if (v !== null) h.set(k, v);
  return new Request(ENDPOINT, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: h });
}

async function answer(res: Response) {
  return { status: res.status, body: await res.json() };
}

// --- Accepted -------------------------------------------------------------------------------------

Deno.test('a new share with a session: 202 { id, status }, recorded for the session user, and the worker started', async () => {
  const { store, rows, limitCalls } = memoryStore();
  const server = serve(store);
  const res = await server.call(post(envelope()));

  assertEquals(await answer(res), { status: 202, body: { id: opId, status: 'received' } });
  assertEquals(res.headers.get('cache-control'), 'no-store');
  const row = rows.get(opId)!;
  assertEquals(row.userId, alex);
  assertEquals(row.credentialId, null);
  assertEquals(row.householdId, home);
  assertEquals(row.listId, groceries);
  assertEquals(row.addToList, true);
  assertEquals(row.url, 'https://www.example.com/lemon-pasta/?utm_source=share');
  assertEquals(row.urlKey, 'https://example.com/lemon-pasta');
  assertEquals(row.title, 'Lemon pasta');
  assertEquals(row.page, { title: '  Lemon pasta ', jsonLd: ['{"@type":"Recipe"}'], text: 'Boil the pasta.' });
  assertEquals(row.clientCreatedAt, '2026-10-22T09:30:00.000Z');
  assertEquals(row.appVersion, '1.4.0');
  assertEquals(row.source, 'share');
  assertEquals(row.payloadHash, await sharePayloadHash(envelope() as ShareEnvelope));
  assertEquals(server.authenticated, [SESSION]);
  assertEquals(limitCalls, [], 'a session has no per-credential limit');
  assertEquals(server.workerStarts(), 1);
});

Deno.test('a new share with a device credential: recorded with the credential, counted against its limit', async () => {
  const { store, rows, limitCalls } = memoryStore();
  const res = await serve(store).call(post(envelope(), { authorization: `Bearer ${DEVICE}` }));
  assertEquals(await answer(res), { status: 202, body: { id: opId, status: 'received' } });
  assertEquals(rows.get(opId)!.credentialId, credential);
  assertEquals(rows.get(opId)!.userId, alex);
  assertEquals(limitCalls, [credential]);
});

Deno.test('an envelope from an older extension (no v, userId, householdId or addToList) is the authenticated user\'s', async () => {
  const { store, rows } = memoryStore();
  const old = envelope({ v: undefined, userId: undefined, householdId: undefined, addToList: undefined, page: undefined });
  const res = await serve(store).call(post(old));
  assertEquals(await answer(res), { status: 202, body: { id: opId, status: 'received' } });
  const row = rows.get(opId)!;
  assertEquals(row.userId, alex);
  assertEquals(row.householdId, home, 'the list\'s household');
  assertEquals(row.addToList, true);
  assertEquals(row.page, null);
  assertEquals(row.title, null);
});

Deno.test('a recipe-only share has no list', async () => {
  const { store, rows } = memoryStore();
  const res = await serve(store).call(post(envelope({ addToList: false, listId: null })));
  assertEquals(res.status, 202);
  assertEquals(rows.get(opId)!.addToList, false);
  assertEquals(rows.get(opId)!.listId, null);
});

// --- Idempotency ----------------------------------------------------------------------------------

Deno.test('a resubmit after a lost response gets the same operation back, and records nothing new', async () => {
  const { store, rows } = memoryStore();
  const server = serve(store);
  await server.call(post(envelope())); // the answer never reaches the device
  const again = await server.call(post(envelope()));
  assertEquals(await answer(again), { status: 202, body: { id: opId, status: 'received' } });
  assertEquals(rows.size, 1);

  // Meanwhile the worker moved it on: the resubmit answers its current state.
  rows.get(opId)!.status = 'extracting';
  assertEquals(await answer(await server.call(post(envelope()))), { status: 202, body: { id: opId, status: 'extracting' } });
});

Deno.test('the background upload and the app\'s submit of one share are one operation', async () => {
  const { store, rows } = memoryStore();
  const server = serve(store);
  const upload = await server.call(post(envelope(), { authorization: `Bearer ${DEVICE}` }));
  const submit = await server.call(post(envelope(), { authorization: `Bearer ${SESSION}` }));
  assertEquals(upload.status, 202);
  assertEquals(await answer(submit), { status: 202, body: { id: opId, status: 'received' } });
  assertEquals(rows.size, 1);
  assertEquals(rows.get(opId)!.credentialId, credential, 'the first one recorded it');
});

Deno.test('upper-case ids (as Swift writes them) are the same operation', async () => {
  const { store, rows } = memoryStore();
  const server = serve(store);
  await server.call(post(envelope()));
  const upper = envelope({ id: opId.toUpperCase(), userId: alex.toUpperCase(), listId: groceries.toUpperCase(), householdId: home.toUpperCase() });
  const res = await server.call(post(upper, { 'idempotency-key': opId.toUpperCase() }));
  assertEquals(await answer(res), { status: 202, body: { id: opId, status: 'received' } });
  assertEquals(rows.size, 1);
});

Deno.test('the same id with another payload is 409 operation_conflict, and the first is kept', async () => {
  const { store, rows } = memoryStore();
  const server = serve(store);
  await server.call(post(envelope()));
  for (const changed of [
    envelope({ url: 'https://example.com/other' }),
    envelope({ addToList: false, listId: null }),
    envelope({ page: { title: 'Lemon pasta', text: 'Different text' } }),
    envelope({ page: undefined }),
  ]) {
    const res = await server.call(post(changed));
    assertEquals(await answer(res), { status: 409, body: { error: 'operation_conflict', message: 'This id is already another share' } });
  }
  assertEquals(rows.get(opId)!.urlKey, 'https://example.com/lemon-pasta');
});

Deno.test('the same id from another user is 409 operation_conflict', async () => {
  const { store } = memoryStore();
  const server = serve(store, {
    authenticate: (token) => Promise.resolve(token === SESSION ? { userId: alex, credentialId: null } : { userId: sam, credentialId: null }),
  });
  await server.call(post(envelope()));
  const res = await server.call(post(envelope({ userId: sam, householdId: away, listId: awayList }), { authorization: 'Bearer other.jwt.token' }));
  assertEquals((await answer(res)).body.error, 'operation_conflict');
});

Deno.test('the worker is started only for work still to do, and a failure to start it changes nothing', async () => {
  const { store, rows } = memoryStore();
  const server = serve(store);
  await server.call(post(envelope()));
  for (const status of ['done', 'failed'] as const) {
    rows.get(opId)!.status = status;
    assertEquals((await server.call(post(envelope()))).status, 202);
  }
  assertEquals(server.workerStarts(), 1);

  const broken = serve(memoryStore().store, { startWorker: () => { throw new Error('no runtime'); } });
  assertEquals(await answer(await broken.call(post(envelope()))), { status: 202, body: { id: opId, status: 'received' } });
});

// --- Refusals -------------------------------------------------------------------------------------

Deno.test('an envelope userId that isn\'t the authenticated user is 403 account_mismatch, nothing recorded', async () => {
  const { store, rows, limitCalls } = memoryStore();
  for (const authorization of [`Bearer ${SESSION}`, `Bearer ${DEVICE}`]) {
    const res = await serve(store).call(post(envelope({ userId: sam }), { authorization }));
    assertEquals(await answer(res), { status: 403, body: { error: 'account_mismatch', message: 'The share belongs to another account' } });
  }
  assertEquals(rows.size, 0);
  assertEquals(limitCalls, []);
});

Deno.test('no bearer token, another scheme or a token that doesn\'t authenticate is 401', async () => {
  const { store, rows } = memoryStore();
  const server = serve(store);
  for (const authorization of [null, '', 'Basic abc', 'Bearer', `Bearer ${DEVICE}x`, 'Bearer expired.jwt.token']) {
    const res = await server.call(post(envelope(), { authorization }));
    assertEquals(res.status, 401);
    assertEquals((await res.json()).error, 'unauthorized');
  }
  assertEquals(server.authenticated, [`${DEVICE}x`, 'expired.jwt.token'], 'only bearer tokens are tried');
  assertEquals(rows.size, 0);
});

Deno.test('an Idempotency-Key that is missing or not the envelope id is 400', async () => {
  const { store, rows } = memoryStore();
  for (const key of [null, '', '0192f0c4-7b1a-7c3d-8e4f-000000000000']) {
    const res = await serve(store).call(post(envelope(), { 'idempotency-key': key }));
    assertEquals(await answer(res), { status: 400, body: { error: 'invalid_request', message: 'Idempotency-Key must be the envelope id' } });
  }
  assertEquals(rows.size, 0);
});

Deno.test('a body that isn\'t a valid envelope is 400 invalid_request; a non-http(s) URL is invalid_url', async () => {
  const { store, rows } = memoryStore();
  const server = serve(store);
  const cases: [unknown, string][] = [
    ['{', 'invalid_request'],
    [null, 'invalid_request'],
    [envelope({ id: 'c0000000-0000-4000-8000-000000000001' }), 'invalid_request'], // not a v7 id
    [envelope({ source: 'siri' }), 'invalid_request'],
    [envelope({ v: 3 }), 'invalid_request'],
    [envelope({ userId: 'alex' }), 'invalid_request'],
    [envelope({ addToList: false }), 'invalid_request'], // recipe-only with a list
    [envelope({ page: { jsonLd: Array(11).fill('{}') } }), 'invalid_request'],
    [envelope({ url: 'ftp://example.com/recipe' }), 'invalid_url'],
    [envelope({ url: 'not a url' }), 'invalid_url'],
  ];
  for (const [body, code] of cases) {
    const res = await server.call(post(body));
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, code);
  }
  assertEquals(rows.size, 0);
});

Deno.test('a household the user isn\'t in is 403 not_a_member; a list outside the household is 400', async () => {
  const { store, rows } = memoryStore();
  const server = serve(store);
  const outsider = await server.call(post(envelope({ householdId: away, listId: awayList })));
  assertEquals(await answer(outsider), { status: 403, body: { error: 'not_a_member', message: 'Not a member of this household' } });
  const wrongList = await server.call(post(envelope({ listId: awayList })));
  assertEquals(await answer(wrongList), { status: 400, body: { error: 'invalid_request', message: 'listId is not a list of this household' } });
  const unknownList = await server.call(post(envelope({ householdId: null, listId: 'c0000000-0000-4000-8000-0000000000ff' })));
  assertEquals((await answer(unknownList)).status, 400);
  assertEquals(rows.size, 0);
});

Deno.test('a body over 2.5 MB is 413, declared or streamed', async () => {
  const { store, rows } = memoryStore();
  const server = serve(store);
  const declared = await server.call(post(envelope(), { 'content-length': String(MAX_BODY_BYTES + 1) }));
  assertEquals(await answer(declared), { status: 413, body: { error: 'payload_too_large', message: `Body over ${MAX_BODY_BYTES} bytes` } });

  // Within every per-field cap (10 blocks of 200 KB, 50 KB of text) but escaped past the total.
  const block = JSON.stringify({ text: '"'.repeat(130_000) });
  const big = envelope({ page: { jsonLd: Array(10).fill(block), text: 'x' } });
  const streamed = await server.call(post(big));
  assertEquals(streamed.status, 413);
  assertEquals(rows.size, 0);

  assertEquals(MAX_BODY_BYTES, 2_621_440);
});

Deno.test('a credential over its per-minute limit is 429 rate_limited, nothing recorded; a session is not limited', async () => {
  const { store, rows } = memoryStore({ limit: 2 });
  const server = serve(store);
  const device = { authorization: `Bearer ${DEVICE}` };
  assertEquals((await server.call(post(envelope(), device))).status, 202);
  assertEquals((await server.call(post(envelope(), device))).status, 202);
  const third = await server.call(post(envelope({ id: '0192f0c4-7b1a-7c3d-8e4f-000000000003' }), { ...device, 'idempotency-key': '0192f0c4-7b1a-7c3d-8e4f-000000000003' }));
  assertEquals((await answer(third)).body.error, 'rate_limited');
  assertEquals(third.status, 429);
  assertEquals(rows.size, 1);
  const session = await server.call(post(envelope({ id: '0192f0c4-7b1a-7c3d-8e4f-000000000003' }), { 'idempotency-key': '0192f0c4-7b1a-7c3d-8e4f-000000000003' }));
  assertEquals(session.status, 202);
});

Deno.test('SHARE_IMPORT=off is 503 unavailable with Retry-After, before authenticating', async () => {
  const { store, rows } = memoryStore();
  for (const value of ['off', ' OFF ']) {
    const server = serve(store, { env: (key) => (key === 'SHARE_IMPORT' ? value : undefined) });
    const res = await server.call(post(envelope()));
    assertEquals(await answer(res), { status: 503, body: { error: 'unavailable', message: 'Share import is paused' } });
    assertEquals(res.headers.get('retry-after'), '3600');
    assertEquals(server.authenticated, []);
  }
  const on = serve(store, { env: (key) => (key === 'SHARE_IMPORT' ? 'on' : undefined) });
  assertEquals((await on.call(post(envelope()))).status, 202);
  assertEquals(rows.size, 1);
});

Deno.test('only POST', async () => {
  const res = await serve(memoryStore().store).call(new Request(ENDPOINT, { method: 'GET' }));
  assertEquals(res.status, 405);
});

Deno.test('a database error is 500, and the log holds neither the page nor the token', async () => {
  const failing: ShareIngestStore = {
    checkLimit: () => Promise.resolve('ok'),
    ingest: () => Promise.reject(new Error('ingest_share_import failed: connection reset')),
  };
  const logged: string[] = [];
  const original = { error: console.error, log: console.log };
  console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '));
  console.log = (...args: unknown[]) => logged.push(args.map(String).join(' '));
  try {
    const res = await serve(failing).call(post(envelope(), { authorization: `Bearer ${DEVICE}` }));
    assertEquals(await answer(res), { status: 500, body: { error: 'internal_error', message: 'Recording the share failed' } });
    const failedAuth = await serve(failing, { authenticate: () => Promise.reject(new Error('use failed')) }).call(post(envelope()));
    assertEquals(failedAuth.status, 500);
  } finally {
    console.error = original.error;
    console.log = original.log;
  }
  assertEquals(logged.length, 2);
  assertEquals(logged.some((line) => line.includes('Boil the pasta') || line.includes(DEVICE)), false);
});

Deno.test('the accepted log line has sizes and counts, not the page', async () => {
  const logged: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => logged.push(args.map(String).join(' '));
  try {
    await serve(memoryStore().store).call(post(envelope(), { authorization: `Bearer ${DEVICE}` }));
  } finally {
    console.log = original;
  }
  const line = JSON.parse(logged[0]);
  assertEquals({ ...line, bytes: typeof line.bytes }, {
    level: 'info', event: 'share_ingested', status: 'received', via: 'credential', bytes: 'number', jsonLd: 1, textBytes: 15,
  });
});

// --- The payload hash -----------------------------------------------------------------------------

Deno.test('canonicalJson sorts keys at every level and drops undefined', () => {
  assertEquals(canonicalJson({ b: 1, a: { d: [3, { f: 1, e: null }], c: 'x' }, z: undefined }), '{"a":{"c":"x","d":[3,{"e":null,"f":1}]},"b":1}');
  assertEquals(canonicalJson(undefined), 'null');
  assertEquals(canonicalJson('é'), '"é"');
});

Deno.test('sharePayloadHash: the same share hashes the same; any part of the payload changes it', async () => {
  const base = envelope() as ShareEnvelope;
  const hash = await sharePayloadHash(base);
  assertEquals(hash.length, 64);
  const same = [
    { ...base, url: 'https://example.com/lemon-pasta' }, // the canonical URL
    { ...base, id: '0192f0c4-7b1a-7c3d-8e4f-000000000009', createdAt: '2026-10-23T00:00:00Z', appVersion: '2.0', v: undefined },
    { ...base, listId: groceries.toUpperCase(), householdId: home.toUpperCase() },
    { ...base, page: { text: 'Boil the pasta.', jsonLd: ['{"@type":"Recipe"}'], title: '  Lemon pasta ' } },
    { ...base, addToList: undefined },
  ];
  for (const e of same) assertEquals(await sharePayloadHash(e as ShareEnvelope), hash);
  const different = [
    { ...base, url: 'https://example.com/lemon-pasta-2' },
    { ...base, householdId: away },
    { ...base, householdId: null },
    { ...base, listId: null },
    { ...base, addToList: false, listId: null },
    { ...base, page: undefined },
    { ...base, page: { ...base.page, text: 'Boil the pasta!' } },
  ];
  for (const e of different) assertNotEquals(await sharePayloadHash(e as ShareEnvelope), hash);
});

// --- The store over the RPCs ----------------------------------------------------------------------

function fakeAdmin(answers: Record<string, { data: unknown; error: { message: string } | null }>) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const admin: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      return Promise.resolve(answers[fn]);
    },
  };
  return { admin, calls };
}

const row: ShareIngestRow = {
  id: opId, userId: alex, credentialId: credential, householdId: home, listId: groceries, addToList: true,
  url: 'https://example.com/a', urlKey: 'https://example.com/a', title: 'A', payloadHash: 'ab'.repeat(32),
  page: { title: 'A' }, clientCreatedAt: '2026-10-22T09:30:00.000Z', appVersion: '1.4.0', source: 'share',
};

Deno.test('createShareIngestStore: ingest sends every column and reads the one row back', async () => {
  const { admin, calls } = fakeAdmin({ ingest_share_import: { data: [{ outcome: 'accepted', status: 'committing' }], error: null } });
  assertEquals(await createShareIngestStore(admin).ingest(row), { outcome: 'accepted', status: 'committing' });
  assertEquals(calls, [{
    fn: 'ingest_share_import',
    args: {
      p_id: opId, p_user_id: alex, p_credential_id: credential, p_household_id: home, p_list_id: groceries,
      p_add_to_list: true, p_url: 'https://example.com/a', p_url_key: 'https://example.com/a', p_title: 'A',
      p_payload_hash: 'ab'.repeat(32), p_page: { title: 'A' }, p_client_created_at: '2026-10-22T09:30:00.000Z',
      p_app_version: '1.4.0', p_source: 'share',
    },
  }]);
});

Deno.test('createShareIngestStore: the refusals, and anything else is an error', async () => {
  for (const outcome of ['conflict', 'not_a_member', 'invalid_list']) {
    const { admin } = fakeAdmin({ ingest_share_import: { data: [{ outcome, status: null }], error: null } });
    assertEquals(await createShareIngestStore(admin).ingest(row), { outcome } as ShareIngestOutcome);
  }
  for (const data of [[], null, [{ outcome: 'accepted', status: 'lost' }], [{ outcome: 'nope' }]]) {
    const { admin } = fakeAdmin({ ingest_share_import: { data, error: null } });
    await assertRejects(() => createShareIngestStore(admin).ingest(row), Error, 'ingest_share_import answered');
  }
  const { admin } = fakeAdmin({ ingest_share_import: { data: null, error: { message: 'boom' } } });
  await assertRejects(() => createShareIngestStore(admin).ingest(row), Error, 'ingest_share_import failed: boom');
});

Deno.test('createShareIngestStore: checkLimit by credential', async () => {
  for (const data of ['ok', 'user_limit'] as const) {
    const { admin, calls } = fakeAdmin({ check_share_ingest_limit: { data, error: null } });
    assertEquals(await createShareIngestStore(admin).checkLimit(credential), data);
    assertEquals(calls, [{ fn: 'check_share_ingest_limit', args: { p_credential_id: credential } }]);
  }
  const { admin } = fakeAdmin({ check_share_ingest_limit: { data: 'daily_limit', error: null } });
  await assertRejects(() => createShareIngestStore(admin).checkLimit(credential), Error, 'answered daily_limit');
  const failing = fakeAdmin({ check_share_ingest_limit: { data: null, error: { message: 'boom' } } });
  await assertRejects(() => createShareIngestStore(failing.admin).checkLimit(credential), Error, 'check_share_ingest_limit failed');
});
