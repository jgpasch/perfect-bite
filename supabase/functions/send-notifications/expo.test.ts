import { assertEquals, assertRejects } from '@std/assert';

import { createExpoClient, ExpoPushError, RECEIPTS_URL, SEND_URL, type ExpoMessage } from './expo.ts';
import { fakeFetch } from './testing.ts';

const msg = (n: number): ExpoMessage => ({ to: `ExponentPushToken[t${n}]`, title: 'Groceries', body: 'Alex is shopping', data: {}, sound: 'default' });
const okTickets = (body: unknown) => Response.json({ data: (body as unknown[]).map((_, i) => ({ status: 'ok', id: `id-${i}` })) });

Deno.test('send posts the messages and returns one ticket each, without Authorization by default', async () => {
  const { fn, calls } = fakeFetch([okTickets]);
  const expo = createExpoClient({ fetch: fn, sleep: async () => {} });
  const tickets = await expo.send([msg(1), msg(2)]);
  assertEquals(tickets, [{ status: 'ok', id: 'id-0' }, { status: 'ok', id: 'id-1' }]);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, SEND_URL);
  assertEquals(calls[0].body, [msg(1), msg(2)]);
  assertEquals(calls[0].headers.Authorization, undefined);
  assertEquals(calls[0].headers['Content-Type'], 'application/json');
});

Deno.test('with an access token, sends it as a bearer', async () => {
  const { fn, calls } = fakeFetch([okTickets]);
  await createExpoClient({ fetch: fn, accessToken: 'secret-token', sleep: async () => {} }).send([msg(1)]);
  assertEquals(calls[0].headers.Authorization, 'Bearer secret-token');
});

Deno.test('sends in chunks of 100', async () => {
  const { fn, calls } = fakeFetch([okTickets, okTickets, okTickets]);
  const tickets = await createExpoClient({ fetch: fn, sleep: async () => {} }).send(Array.from({ length: 201 }, (_, i) => msg(i)));
  assertEquals(calls.map((c) => (c.body as unknown[]).length), [100, 100, 1]);
  assertEquals(tickets.length, 201);
});

Deno.test('a 429 is retried after a backoff', async () => {
  const sleeps: number[] = [];
  const { fn, calls } = fakeFetch([new Response('slow down', { status: 429 }), okTickets]);
  const tickets = await createExpoClient({ fetch: fn, sleep: async (ms) => void sleeps.push(ms) }).send([msg(1)]);
  assertEquals(tickets, [{ status: 'ok', id: 'id-0' }]);
  assertEquals(calls.length, 2);
  assertEquals(sleeps, [1000]);
});

Deno.test('5xx and network errors are retried, up to 3 tries, then it throws', async () => {
  const sleeps: number[] = [];
  const { fn, calls } = fakeFetch([new Response('', { status: 503 }), new Error('reset'), new Response('', { status: 500 })]);
  const err = await assertRejects(
    () => createExpoClient({ fetch: fn, sleep: async (ms) => void sleeps.push(ms) }).send([msg(1)]),
    ExpoPushError,
    'Expo answered 500',
  );
  assertEquals(err.status, 500);
  assertEquals(calls.length, 3);
  assertEquals(sleeps, [1000, 2000]);
});

Deno.test('a 400 is not retried', async () => {
  const { fn, calls } = fakeFetch([new Response('{"errors":[]}', { status: 400 })]);
  await assertRejects(() => createExpoClient({ fetch: fn, sleep: async () => {} }).send([msg(1)]), ExpoPushError, 'Expo answered 400');
  assertEquals(calls.length, 1);
});

Deno.test('a 200 with errors and no data throws', async () => {
  const { fn } = fakeFetch([Response.json({ errors: [{ code: 'PUSH_TOO_MANY_EXPERIENCE_IDS' }] })]);
  await assertRejects(() => createExpoClient({ fetch: fn, sleep: async () => {} }).send([msg(1)]), ExpoPushError, 'without data');
});

Deno.test('a ticket count that doesn\'t match the messages throws', async () => {
  const { fn } = fakeFetch([Response.json({ data: [] })]);
  await assertRejects(() => createExpoClient({ fetch: fn, sleep: async () => {} }).send([msg(1)]), ExpoPushError, '0 tickets for 1 messages');
});

Deno.test('getReceipts posts the ids and merges chunks of 1,000', async () => {
  const ids = Array.from({ length: 1001 }, (_, i) => `id-${i}`);
  const { fn, calls } = fakeFetch([
    Response.json({ data: { 'id-0': { status: 'ok' } } }),
    Response.json({ data: { 'id-1000': { status: 'error', details: { error: 'DeviceNotRegistered' } } } }),
  ]);
  const receipts = await createExpoClient({ fetch: fn, sleep: async () => {} }).getReceipts(ids);
  assertEquals(calls.map((c) => c.url), [RECEIPTS_URL, RECEIPTS_URL]);
  assertEquals(calls.map((c) => (c.body as { ids: string[] }).ids.length), [1000, 1]);
  assertEquals(receipts, { 'id-0': { status: 'ok' }, 'id-1000': { status: 'error', details: { error: 'DeviceNotRegistered' } } });
});
