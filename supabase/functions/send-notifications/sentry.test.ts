import { assertEquals } from '@std/assert';

import { startFakeSentry } from '../_shared/fake-sentry.ts';
import type { NotificationStore, QueuedEvent, Recipient } from './handler.ts';
import { fakeFetch, type FakeResponse } from './testing.ts';

// What reaches Sentry from a run that sent but then failed, or whose pushes were refused. One fake
// Sentry for the file: sentry.ts reads SENTRY_DSN once, on import, so it's set before the import.

const sentry = startFakeSentry();
Deno.env.set('SENTRY_DSN', sentry.dsn);
const { runWorker } = await import('./handler.ts');
const { createExpoClient } = await import('./expo.ts');

const NOW = Date.parse('2026-10-17T12:00:00Z');
const H = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const LIST = 'a1000000-0000-7000-8000-000000000001';
const ALEX = '11111111-1111-1111-1111-111111111111';

/** One add by Alex, a minute old, going to two other members. */
const EVENT: QueuedEvent = {
  msgId: 1,
  message: { kind: 'items_added', household_id: H, list_id: LIST, actor: ALEX, contribution_id: 'c1', list_item_id: 'i1', recipe_id: null, at: new Date(NOW - 60_000).toISOString() },
};

function run(store: Partial<NotificationStore>, responses: FakeResponse[]) {
  let read = false;
  const full: NotificationStore = {
    readEvents: () => {
      const events = read ? [] : [EVENT];
      read = true;
      return Promise.resolve(events);
    },
    archive: async () => {},
    release: async () => {},
    groupDetails: () =>
      Promise.resolve({ listName: 'Groceries', actorName: 'Alex', items: [{ id: 'i1', name: 'Milk', recipeId: null, recipeName: null }], lastSentAt: null }),
    recipients: () =>
      Promise.resolve<Recipient[]>([
        { userId: 'sam', token: 'ExponentPushToken[sam]', platform: 'ios' },
        { userId: 'kim', token: 'ExponentPushToken[kim]', platform: 'ios' },
      ]),
    recipeImport: () => Promise.resolve(null),
    recipeImportRecipients: () => Promise.resolve([]),
    deleteTokens: async () => {},
    saveReceipts: async () => {},
    dueReceipts: () => Promise.resolve([]),
    deleteReceipts: async () => {},
    ...store,
  };
  const expo = createExpoClient({ fetch: fakeFetch(responses).fn, sleep: async () => {} });
  return runWorker({ store: full, expo, now: () => new Date(NOW), sleep: async () => {} });
}

const opts = { sanitizeOps: false, sanitizeResources: false };

Deno.test({
  ...opts,
  name: 'a failed saveReceipts after a send is reported with its full message, and the run still counts it sent',
  fn: async () => {
    sentry.events.length = 0;
    const result = await run(
      // What supabase-js returns: a plain object, not an Error.
      { saveReceipts: () => Promise.reject({ message: 'permission denied for table notification_sends', code: '42501', details: null, hint: null }) },
      [Response.json({ data: [{ status: 'ok', id: 't1' }, { status: 'ok', id: 't2' }] })],
    );
    assertEquals(result.sent, 1);
    await sentry.waitFor(1);
    assertEquals(sentry.events.length, 1);
    const [event] = sentry.events;
    assertEquals(event.exception, 'permission denied for table notification_sends (42501)');
    assertEquals([event.tags.function, event.tags.event], ['send-notifications', 'record_sent_failed']);
  },
});

Deno.test({
  ...opts,
  name: 'archiving a sent group failing every try is reported once; the run still counts it sent',
  fn: async () => {
    sentry.events.length = 0;
    let tries = 0;
    const result = await run(
      {
        archive: () => {
          tries += 1;
          return Promise.reject({ message: 'connection reset', code: '08006', details: null, hint: null });
        },
      },
      [Response.json({ data: [{ status: 'ok', id: 't1' }, { status: 'ok', id: 't2' }] })],
    );
    assertEquals([result.sent, result.failed, tries], [1, 0, 3]);
    await sentry.waitFor(1);
    // Give a wrongly sent second report time to arrive.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assertEquals(sentry.events.length, 1);
    const [event] = sentry.events;
    assertEquals(event.exception, 'connection reset (08006)');
    assertEquals([event.tags.function, event.tags.event], ['send-notifications', 'archive_sent_failed']);
  },
});

Deno.test({
  ...opts,
  name: 'refused tickets are reported once per reason; DeviceNotRegistered is not reported',
  fn: async () => {
    sentry.events.length = 0;
    await run({}, [
      Response.json({
        data: [
          { status: 'error', message: 'bad key', details: { error: 'InvalidCredentials' } },
          { status: 'error', message: 'bad key', details: { error: 'InvalidCredentials' } },
        ],
      }),
    ]);
    await run({}, [
      Response.json({
        data: [
          { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
          { status: 'ok', id: 't2' },
        ],
      }),
    ]);
    await sentry.waitFor(1);
    // Give a wrongly sent second report time to arrive.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assertEquals(sentry.events.length, 1);
    const [event] = sentry.events;
    assertEquals(event.exception, 'Push ticket error: InvalidCredentials');
    assertEquals([event.tags.event, event.tags.reason], ['push_ticket_error', 'InvalidCredentials']);
  },
});

Deno.test({ ...opts, name: 'stop the fake Sentry', fn: () => sentry.server.shutdown() });
