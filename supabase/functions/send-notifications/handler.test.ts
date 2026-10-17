import { assertEquals } from '@std/assert';

import { createExpoClient, RECEIPTS_URL, SEND_URL, type ExpoMessage } from './expo.ts';
import {
  buildText,
  handleRequest,
  runWorker,
  type EventKind,
  type GroupDetails,
  type NotificationStore,
  type QueuedEvent,
  type Recipient,
  type StoredReceipt,
} from './handler.ts';
import { fakeFetch, okTickets, type FakeResponse } from './testing.ts';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const H = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GROCERIES = 'a1000000-0000-7000-8000-000000000001';
const HARDWARE = 'a1000000-0000-7000-8000-000000000002';
const ALEX = '11111111-1111-1111-1111-111111111111';
const SAM = '22222222-2222-2222-2222-222222222222';
const KIM = '33333333-3333-3333-3333-333333333333';
const TOKENS: Record<string, string> = {
  [ALEX]: 'ExponentPushToken[alex]',
  [SAM]: 'ExponentPushToken[sam]',
  [KIM]: 'ExponentPushToken[kim]',
};
const sec = (s: number) => new Date(NOW - s * 1000).toISOString();

let nextMsgId = 1;
function add(opts: { id: string; ageS: number; actor?: string; list?: string; item?: string; recipe?: string }): QueuedEvent {
  return {
    msgId: nextMsgId++,
    message: {
      kind: 'items_added',
      household_id: H,
      list_id: opts.list ?? GROCERIES,
      actor: opts.actor ?? ALEX,
      contribution_id: opts.id,
      list_item_id: opts.item ?? `item-${opts.id}`,
      recipe_id: opts.recipe ?? null,
      source: opts.recipe ? 'recipe' : 'manual',
      at: sec(opts.ageS),
    },
  };
}
function check(opts: { item: string; ageS: number; actor?: string; list?: string }): QueuedEvent {
  return {
    msgId: nextMsgId++,
    message: { kind: 'shopping', household_id: H, list_id: opts.list ?? GROCERIES, actor: opts.actor ?? ALEX, list_item_id: opts.item, at: sec(opts.ageS) },
  };
}

/** A row the worker re-reads: a contribution (by its id) or a checked item (by its id). */
type Row = { name: string; item?: string; recipeId?: string; recipeName?: string; live?: boolean };

function fakeStore(events: QueuedEvent[], db: { rows?: Record<string, Row>; lastSent?: Record<string, string>; due?: StoredReceipt[] } = {}) {
  const rows = db.rows ?? {};
  const lastSent: Record<string, string> = { ...db.lastSent };
  const lists: Record<string, string | null> = { [GROCERIES]: 'Groceries', [HARDWARE]: 'Hardware' };
  const names: Record<string, string | null> = { [ALEX]: 'Alex', [SAM]: 'Sam', [KIM]: 'Kim' };
  const calls = {
    read: [] as [number, number][],
    archived: [] as number[],
    released: [] as number[],
    groupDetails: [] as { kind: EventKind; listId: string; actor: string; ids: string[] }[],
    recipients: [] as { householdId: string; actor: string; kind: EventKind; at: string }[],
    recordSent: [] as string[],
    deletedTokens: [] as string[],
    savedReceipts: [] as StoredReceipt[],
    dueReceipts: [] as [number, number][],
    deletedReceipts: [] as string[],
  };
  let queue = [...events];
  const store: NotificationStore = {
    async readEvents(qty, vt) {
      calls.read.push([qty, vt]);
      const read = queue.slice(0, qty);
      queue = queue.slice(qty);
      return read;
    },
    async archive(ids) {
      calls.archived.push(...ids);
    },
    async release(ids) {
      calls.released.push(...ids);
    },
    async groupDetails(kind, listId, actor, ids) {
      calls.groupDetails.push({ kind, listId, actor, ids });
      const items = ids
        .filter((id) => rows[id]?.live !== false)
        .map((id) => {
          const row = rows[id] ?? { name: `name-${id}` };
          return { id: row.item ?? id, name: row.name, recipeId: row.recipeId ?? null, recipeName: row.recipeName ?? null };
        });
      return {
        listName: lists[listId] ?? null,
        actorName: names[actor] ?? null,
        items,
        lastSentAt: lastSent[`${actor}|${listId}|${kind}`] ?? null,
      } satisfies GroupDetails;
    },
    async recipients(householdId, actor, kind, at) {
      calls.recipients.push({ householdId, actor, kind, at: at.toISOString() });
      return [ALEX, SAM, KIM].filter((u) => u !== actor).map((u): Recipient => ({ userId: u, token: TOKENS[u], platform: 'ios' }));
    },
    async recordSent(householdId, actor, listId, kind) {
      calls.recordSent.push(`${householdId}|${actor}|${listId}|${kind}`);
      lastSent[`${actor}|${listId}|${kind}`] = new Date(NOW).toISOString();
    },
    async deleteTokens(tokens) {
      calls.deletedTokens.push(...tokens);
    },
    async saveReceipts(receipts) {
      calls.savedReceipts.push(...receipts);
    },
    async dueReceipts(minAge, limit) {
      calls.dueReceipts.push([minAge, limit]);
      return db.due ?? [];
    },
    async deleteReceipts(ids) {
      calls.deletedReceipts.push(...ids);
    },
  };
  return { store, calls, push: (...more: QueuedEvent[]) => queue.push(...more) };
}

function setup(events: QueuedEvent[], db: Parameters<typeof fakeStore>[1] = {}, responses: FakeResponse[] = []) {
  const s = fakeStore(events, db);
  const f = fakeFetch(responses);
  const sleeps: number[] = [];
  const expo = createExpoClient({ fetch: f.fn, sleep: async (ms) => void sleeps.push(ms) });
  const run = (at = NOW) => runWorker({ store: s.store, expo, now: () => new Date(at) });
  return { ...s, fetchCalls: f.calls, sleeps, run };
}

const sent = (calls: { url: string; body: unknown }[]) =>
  calls.filter((c) => c.url === SEND_URL).flatMap((c) => c.body as ExpoMessage[]);

const msgIds = (events: QueuedEvent[]) => events.map((e) => e.msgId);

// Grouping ----------------------------------------------------------------------------------------

Deno.test('reads up to 500 events with a 2-minute visibility timeout', async () => {
  const t = setup([]);
  await t.run();
  assertEquals(t.calls.read, [[500, 120]]);
});

Deno.test('a group quiet for less than 60 s waits: released, not sent, not archived', async () => {
  const events = [add({ id: 'c1', ageS: 90 }), add({ id: 'c2', ageS: 30 })];
  const t = setup(events);
  const result = await t.run();
  assertEquals(t.calls.released, msgIds(events));
  assertEquals(t.calls.archived, []);
  assertEquals(t.fetchCalls, []);
  assertEquals(result.waiting, 2);
  assertEquals(result.sent, 0);
});

Deno.test('a group whose newest event is 60 s old sends once, to the other members, and is archived', async () => {
  const events = [add({ id: 'c1', ageS: 100 }), add({ id: 'c2', ageS: 60 })];
  const t = setup(events, { rows: { c1: { name: 'Milk' }, c2: { name: 'Eggs' } } }, [okTickets]);
  const result = await t.run();
  assertEquals(sent(t.fetchCalls), [
    {
      to: TOKENS[SAM],
      title: 'Groceries',
      body: 'Alex added Milk and Eggs',
      data: { url: `/list/${GROCERIES}`, kind: 'items_added', householdId: H },
      sound: 'default',
      threadId: GROCERIES,
    },
    {
      to: TOKENS[KIM],
      title: 'Groceries',
      body: 'Alex added Milk and Eggs',
      data: { url: `/list/${GROCERIES}`, kind: 'items_added', householdId: H },
      sound: 'default',
      threadId: GROCERIES,
    },
  ]);
  assertEquals(t.calls.archived, msgIds(events));
  assertEquals(t.calls.released, []);
  assertEquals(t.calls.groupDetails, [{ kind: 'items_added', listId: GROCERIES, actor: ALEX, ids: ['c1', 'c2'] }]);
  assertEquals(t.calls.recordSent, [`${H}|${ALEX}|${GROCERIES}|items_added`]);
  assertEquals(result, { read: 2, sent: 1, pushes: 2, dropped: 0, waiting: 0, failed: 0, receiptsChecked: 0, tokensRemoved: 0 });
});

Deno.test('the 5-minute cap sends a group that never goes quiet', async () => {
  const events = [add({ id: 'c1', ageS: 300 }), add({ id: 'c2', ageS: 150 }), add({ id: 'c3', ageS: 10 })];
  const t = setup(events, { rows: { c1: { name: 'Milk' }, c2: { name: 'Eggs' }, c3: { name: 'Bread' } } }, [okTickets]);
  await t.run();
  assertEquals(sent(t.fetchCalls).map((m) => m.body), ['Alex added Milk, Eggs and 1 more', 'Alex added Milk, Eggs and 1 more']);
  assertEquals(t.calls.archived, msgIds(events));
});

Deno.test('just under the cap and not quiet, it still waits', async () => {
  const events = [add({ id: 'c1', ageS: 299 }), add({ id: 'c2', ageS: 10 })];
  const t = setup(events);
  await t.run();
  assertEquals(t.fetchCalls, []);
  assertEquals(t.calls.released, msgIds(events));
});

Deno.test('two actors on one list make two groups, each sent to everyone but its actor', async () => {
  const events = [add({ id: 'c1', ageS: 70 }), add({ id: 'c2', ageS: 70, actor: SAM })];
  const t = setup(events, { rows: { c1: { name: 'Milk' }, c2: { name: 'Eggs' } } }, [okTickets, okTickets]);
  const result = await t.run();
  assertEquals(
    sent(t.fetchCalls).map((m) => [m.to, m.body]),
    [
      [TOKENS[SAM], 'Alex added Milk'],
      [TOKENS[KIM], 'Alex added Milk'],
      [TOKENS[ALEX], 'Sam added Eggs'],
      [TOKENS[KIM], 'Sam added Eggs'],
    ],
  );
  assertEquals(t.calls.recipients.map((r) => [r.actor, r.kind, r.at]), [
    [ALEX, 'items_added', new Date(NOW).toISOString()],
    [SAM, 'items_added', new Date(NOW).toISOString()],
  ]);
  assertEquals(result.sent, 2);
});

Deno.test('two lists make two groups, each with its own url and thread', async () => {
  const events = [add({ id: 'c1', ageS: 70 }), add({ id: 'c2', ageS: 70, list: HARDWARE })];
  const t = setup(events, { rows: { c1: { name: 'Milk' }, c2: { name: 'Nails' } } }, [okTickets, okTickets]);
  await t.run();
  const messages = sent(t.fetchCalls).filter((m) => m.to === TOKENS[SAM]);
  assertEquals(messages.map((m) => [m.title, m.body, m.data.url, m.threadId]), [
    ['Groceries', 'Alex added Milk', `/list/${GROCERIES}`, GROCERIES],
    ['Hardware', 'Alex added Nails', `/list/${HARDWARE}`, HARDWARE],
  ]);
});

Deno.test('the person who made the change never gets the push', async () => {
  const t = setup([check({ item: 'i1', ageS: 70 })], { rows: { i1: { name: 'Milk' } } }, [okTickets]);
  await t.run();
  const to = sent(t.fetchCalls).map((m) => m.to);
  assertEquals(to, [TOKENS[SAM], TOKENS[KIM]]);
  assertEquals(to.includes(TOKENS[ALEX]), false);
  assertEquals(t.calls.recipients[0].actor, ALEX);
});

// Re-reading the rows -----------------------------------------------------------------------------

Deno.test('an undone add doesn\'t count', async () => {
  const events = [add({ id: 'c1', ageS: 70 }), add({ id: 'c2', ageS: 70 })];
  const t = setup(events, { rows: { c1: { name: 'Milk' }, c2: { name: 'Eggs', live: false } } }, [okTickets]);
  await t.run();
  assertEquals(sent(t.fetchCalls)[0].body, 'Alex added Milk');
});

Deno.test('a group whose adds were all undone is archived without a push', async () => {
  const events = [add({ id: 'c1', ageS: 70 })];
  const t = setup(events, { rows: { c1: { name: 'Milk', live: false } } });
  const result = await t.run();
  assertEquals(t.fetchCalls, []);
  assertEquals(t.calls.archived, msgIds(events));
  assertEquals(t.calls.recipients, []);
  assertEquals(t.calls.recordSent, []);
  assertEquals(result.dropped, 1);
});

Deno.test('checks unchecked again leave nothing to send', async () => {
  const events = [check({ item: 'i1', ageS: 70 })];
  const t = setup(events, { rows: { i1: { name: 'Milk', live: false } } });
  await t.run();
  assertEquals(t.fetchCalls, []);
  assertEquals(t.calls.archived, msgIds(events));
});

Deno.test('a stale event (more than 15 minutes old) is archived without a push', async () => {
  const stale = check({ item: 'i1', ageS: 15 * 60 + 1 });
  const fresh = check({ item: 'i2', ageS: 14 * 60, list: HARDWARE });
  const t = setup([stale, fresh], { rows: { i2: { name: 'Nails' } } }, [okTickets]);
  const result = await t.run();
  assertEquals(sent(t.fetchCalls).map((m) => m.title), ['Hardware', 'Hardware']);
  assertEquals(t.calls.archived, [stale.msgId, fresh.msgId]);
  assertEquals(t.calls.groupDetails.map((g) => g.ids), [['i2']]);
  assertEquals(result.dropped, 1);
});

Deno.test('an unusable message is archived', async () => {
  const bad = { msgId: 999, message: { kind: 'party', household_id: H } };
  const t = setup([bad]);
  const result = await t.run();
  assertEquals(t.calls.archived, [999]);
  assertEquals(result.dropped, 1);
});

Deno.test('no one to tell (everyone else off, quiet or without a token): archived, nothing sent', async () => {
  const events = [add({ id: 'c1', ageS: 70 })];
  const t = setup(events, { rows: { c1: { name: 'Milk' } } });
  t.store.recipients = async () => [];
  await t.run();
  assertEquals(t.fetchCalls, []);
  assertEquals(t.calls.archived, msgIds(events));
  assertEquals(t.calls.recordSent, []);
});

Deno.test('a deleted list sends nothing', async () => {
  const events = [add({ id: 'c1', ageS: 70, list: 'gone' })];
  const t = setup(events, { rows: { c1: { name: 'Milk' } } });
  await t.run();
  assertEquals(t.fetchCalls, []);
  assertEquals(t.calls.archived, msgIds(events));
});

// Shopping ----------------------------------------------------------------------------------------

Deno.test('several checks make one "is shopping" push', async () => {
  const events = [check({ item: 'i1', ageS: 120 }), check({ item: 'i2', ageS: 90 }), check({ item: 'i3', ageS: 61 })];
  const t = setup(events, {}, [okTickets]);
  await t.run();
  assertEquals(sent(t.fetchCalls).map((m) => [m.body, m.data.kind]), [
    ['Alex is shopping', 'shopping'],
    ['Alex is shopping', 'shopping'],
  ]);
  assertEquals(t.calls.recordSent, [`${H}|${ALEX}|${GROCERIES}|shopping`]);
});

Deno.test('the shopping window: a push less than 2 hours ago means none now; the checks are archived', async () => {
  const events = [check({ item: 'i1', ageS: 70 })];
  const t = setup(events, { lastSent: { [`${ALEX}|${GROCERIES}|shopping`]: sec(2 * 3600 - 1) } });
  const result = await t.run();
  assertEquals(t.fetchCalls, []);
  assertEquals(t.calls.archived, msgIds(events));
  assertEquals(t.calls.recipients, []);
  assertEquals(result.dropped, 1);
});

Deno.test('the shopping window: 2 hours after the last push, the next checks send again', async () => {
  const t = setup([check({ item: 'i1', ageS: 70 })], { lastSent: { [`${ALEX}|${GROCERIES}|shopping`]: sec(2 * 3600) } }, [okTickets]);
  await t.run();
  assertEquals(sent(t.fetchCalls).length, 2);
});

Deno.test('the shopping window across runs: more checks after a push send nothing else', async () => {
  const t = setup([check({ item: 'i1', ageS: 70 })], {}, [okTickets]);
  await t.run();
  t.push(check({ item: 'i2', ageS: 61 }));
  await t.run(NOW + 60_000);
  assertEquals(sent(t.fetchCalls).length, 2);
  assertEquals(t.calls.recordSent.length, 1);
});

Deno.test('the shopping window is per list and per actor; adds aren\'t limited', async () => {
  const t = setup(
    [check({ item: 'i1', ageS: 70, list: HARDWARE }), check({ item: 'i2', ageS: 70, actor: SAM }), add({ id: 'c1', ageS: 70 })],
    { rows: { c1: { name: 'Milk' } }, lastSent: { [`${ALEX}|${GROCERIES}|shopping`]: sec(60), [`${ALEX}|${GROCERIES}|items_added`]: sec(60) } },
    [okTickets, okTickets, okTickets],
  );
  const result = await t.run();
  assertEquals(result.sent, 3);
});

// Wording -----------------------------------------------------------------------------------------

const details = (items: { id: string; name: string; recipeId?: string; recipeName?: string }[], extra: Partial<GroupDetails> = {}): GroupDetails => ({
  listName: 'Groceries',
  actorName: 'Alex',
  lastSentAt: null,
  items: items.map((i) => ({ id: i.id, name: i.name, recipeId: i.recipeId ?? null, recipeName: i.recipeName ?? null })),
  ...extra,
});
const body = (d: GroupDetails, kind: EventKind = 'items_added') => buildText(kind, d)?.body;

Deno.test('"and N more" wording', () => {
  assertEquals(body(details([{ id: '1', name: 'milk' }])), 'Alex added milk');
  assertEquals(body(details([{ id: '1', name: 'milk' }, { id: '2', name: 'eggs' }])), 'Alex added milk and eggs');
  assertEquals(body(details([{ id: '1', name: 'milk' }, { id: '2', name: 'eggs' }, { id: '3', name: 'bread' }])), 'Alex added milk, eggs and 1 more');
  assertEquals(
    body(details(['milk', 'eggs', 'bread', 'butter', 'jam', 'tea'].map((name, i) => ({ id: String(i), name })))),
    'Alex added milk, eggs and 4 more',
  );
});

Deno.test('two contributions to one item (a Combine) name and count it once', () => {
  assertEquals(body(details([{ id: '1', name: 'milk' }, { id: '1', name: 'milk' }, { id: '2', name: 'eggs' }])), 'Alex added milk and eggs');
});

Deno.test('recipe wording: a group that is all one recipe\'s add', () => {
  const tacos = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i), name: `x${i}`, recipeId: 'r1', recipeName: 'Tacos' }));
  assertEquals(body(details(tacos(8))), 'Alex added Tacos (8 items)');
  assertEquals(body(details(tacos(1))), 'Alex added Tacos (1 item)');
});

Deno.test('a recipe add mixed with a manual add, or two recipes, uses the item wording', () => {
  assertEquals(
    body(details([{ id: '1', name: 'Onion', recipeId: 'r1', recipeName: 'Tacos' }, { id: '2', name: 'Milk' }])),
    'Alex added Onion and Milk',
  );
  assertEquals(
    body(details([{ id: '1', name: 'Onion', recipeId: 'r1', recipeName: 'Tacos' }, { id: '2', name: 'Rice', recipeId: 'r2', recipeName: 'Curry' }])),
    'Alex added Onion and Rice',
  );
});

Deno.test('the recipe wording end to end, after an undone ingredient', async () => {
  const events = ['c1', 'c2', 'c3'].map((id) => add({ id, ageS: 70, recipe: 'r1' }));
  const rows: Record<string, Row> = {
    c1: { name: 'Onion', recipeId: 'r1', recipeName: 'Tacos' },
    c2: { name: 'Garlic', recipeId: 'r1', recipeName: 'Tacos' },
    c3: { name: 'Lime', recipeId: 'r1', recipeName: 'Tacos', live: false },
  };
  const t = setup(events, { rows }, [okTickets]);
  await t.run();
  assertEquals(sent(t.fetchCalls)[0].body, 'Alex added Tacos (2 items)');
});

Deno.test('names with markdown or emoji go through as they are', () => {
  assertEquals(
    body(details([{ id: '1', name: '**Milk** _2%_' }, { id: '2', name: '🥚 Eggs <b>' }])),
    'Alex added **Milk** _2%_ and 🥚 Eggs <b>',
  );
  assertEquals(buildText('shopping', details([{ id: '1', name: 'x' }], { listName: '🛒 [Costco](x)' }))?.title, '🛒 [Costco](x)');
});

Deno.test('the title is the list name; no name falls back to "Someone"', () => {
  assertEquals(buildText('shopping', details([{ id: '1', name: 'x' }], { actorName: null })), { title: 'Groceries', body: 'Someone is shopping' });
  assertEquals(buildText('shopping', details([{ id: '1', name: 'x' }], { actorName: '  ' }))?.body, 'Someone is shopping');
});

Deno.test('nothing left, or no list: no text', () => {
  assertEquals(buildText('items_added', details([])), null);
  assertEquals(buildText('shopping', details([])), null);
  assertEquals(buildText('items_added', details([{ id: '1', name: 'milk' }], { listName: null })), null);
});

// Expo --------------------------------------------------------------------------------------------

Deno.test('a 429 is retried within the run, then the group sends', async () => {
  const events = [check({ item: 'i1', ageS: 70 })];
  const t = setup(events, {}, [new Response('', { status: 429 }), okTickets]);
  const result = await t.run();
  assertEquals(t.fetchCalls.filter((c) => c.url === SEND_URL).length, 2);
  assertEquals(t.sleeps, [1000]);
  assertEquals(result.sent, 1);
  assertEquals(t.calls.archived, msgIds(events));
});

Deno.test('a send still failing after 3 tries leaves the group to reappear; other groups still send', async () => {
  const failing = check({ item: 'i1', ageS: 70 });
  const other = check({ item: 'i2', ageS: 70, list: HARDWARE });
  const err = () => new Response('', { status: 502 });
  const t = setup([failing, other], {}, [err(), err(), err(), okTickets]);
  const result = await t.run();
  assertEquals(result.failed, 1);
  assertEquals(result.sent, 1);
  assertEquals(t.calls.archived, [other.msgId]);
  assertEquals(t.calls.released, []);
  assertEquals(t.calls.recordSent, [`${H}|${ALEX}|${HARDWARE}|shopping`]);
});

Deno.test('ok tickets are stored with their tokens; DeviceNotRegistered deletes that token', async () => {
  const t = setup([check({ item: 'i1', ageS: 70 })], {}, [
    Response.json({
      data: [
        { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered', expoPushToken: TOKENS[SAM] } },
        { status: 'ok', id: 'ticket-kim' },
      ],
    }),
  ]);
  const result = await t.run();
  assertEquals(t.calls.deletedTokens, [TOKENS[SAM]]);
  assertEquals(t.calls.savedReceipts, [{ ticketId: 'ticket-kim', token: TOKENS[KIM] }]);
  assertEquals(result.tokensRemoved, 1);
});

Deno.test('a DeviceNotRegistered ticket without the token in details uses the message\'s token', async () => {
  const t = setup([check({ item: 'i1', ageS: 70 })], {}, [
    Response.json({ data: [{ status: 'ok', id: 'a' }, { status: 'error', details: { error: 'DeviceNotRegistered' } }] }),
  ]);
  await t.run();
  assertEquals(t.calls.deletedTokens, [TOKENS[KIM]]);
});

Deno.test('another ticket error deletes nothing', async () => {
  const t = setup([check({ item: 'i1', ageS: 70 })], {}, [
    Response.json({ data: [{ status: 'error', details: { error: 'MessageRateExceeded' } }, { status: 'ok', id: 'a' }] }),
  ]);
  await t.run();
  assertEquals(t.calls.deletedTokens, []);
  assertEquals(t.calls.savedReceipts, [{ ticketId: 'a', token: TOKENS[KIM] }]);
});

// Receipts ----------------------------------------------------------------------------------------

Deno.test('receipts at least 15 minutes old are checked; DeviceNotRegistered deletes the token', async () => {
  const due = [
    { ticketId: 't1', token: TOKENS[SAM] },
    { ticketId: 't2', token: TOKENS[KIM] },
    { ticketId: 't3', token: TOKENS[ALEX] },
    { ticketId: 't4', token: 'ExponentPushToken[other]' },
  ];
  const t = setup([], { due }, [
    Response.json({
      data: {
        t1: { status: 'ok' },
        t2: { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
        t3: { status: 'error', details: { error: 'MessageTooBig' } },
      },
    }),
  ]);
  const result = await t.run();
  assertEquals(t.calls.dueReceipts, [[900, 1000]]);
  assertEquals(t.fetchCalls.map((c) => [c.url, c.body]), [[RECEIPTS_URL, { ids: ['t1', 't2', 't3', 't4'] }]]);
  assertEquals(t.calls.deletedTokens, [TOKENS[KIM]]);
  // t4 has no receipt yet: kept for a later run.
  assertEquals(t.calls.deletedReceipts, ['t1', 't2', 't3']);
  assertEquals(result.receiptsChecked, 3);
  assertEquals(result.tokensRemoved, 1);
});

Deno.test('no due receipts: no receipts request', async () => {
  const t = setup([]);
  await t.run();
  assertEquals(t.fetchCalls, []);
  assertEquals(t.calls.deletedReceipts, []);
});

Deno.test('a failed receipts request keeps the receipts and doesn\'t fail the run', async () => {
  const t = setup([], { due: [{ ticketId: 't1', token: TOKENS[SAM] }] }, [new Response('', { status: 400 })]);
  const result = await t.run();
  assertEquals(t.calls.deletedReceipts, []);
  assertEquals(result.receiptsChecked, 0);
});

// HTTP --------------------------------------------------------------------------------------------

const zero = { read: 0, sent: 0, pushes: 0, dropped: 0, waiting: 0, failed: 0, receiptsChecked: 0, tokensRemoved: 0 };

Deno.test('POST → 200 with the counts', async () => {
  const res = await handleRequest(new Request('http://localhost/', { method: 'POST' }), async () => ({ ...zero, sent: 2 }));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ...zero, sent: 2 });
});

Deno.test('only POST', async () => {
  const res = await handleRequest(new Request('http://localhost/', { method: 'GET' }), async () => zero);
  assertEquals(res.status, 405);
});

Deno.test('a failure → 500', async () => {
  const res = await handleRequest(new Request('http://localhost/', { method: 'POST' }), () => Promise.reject(new Error('db down')));
  assertEquals(res.status, 500);
  assertEquals((await res.json()).error, 'internal');
});
