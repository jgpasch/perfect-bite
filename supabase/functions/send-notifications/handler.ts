// Push notifications from the household_events queue (spec 4.13, 8.5). Each run groups the queued
// household events per (household, actor, list, kind), sends one push per ready group to the
// household's other members, sends each recipe import's push to its sharer at once, and checks the
// receipts of earlier pushes.

import { asError, reportError } from '../_shared/sentry.ts';
import type { ExpoClient, ExpoMessage, PushTicket } from './expo.ts';

export type EventKind = 'items_added' | 'shopping';

/** A queue message, as the triggers in 20261104120000_household_events.sql write it. */
export type HouseholdEvent = {
  kind: EventKind;
  household_id: string;
  list_id: string;
  actor: string;
  list_item_id: string;
  contribution_id?: string;
  recipe_id?: string | null;
  at: string;
};

/** A share import that finished (20261216100000_recipe_import_pushes.sql): pushed to its sharer alone. */
export type RecipeImportEvent = {
  kind: 'recipe_import';
  share_import_id: string;
  user_id: string;
  household_id: string;
  status: 'done' | 'failed';
  at: string;
};

export type QueuedEvent = { msgId: number; message: unknown };

/** A share import re-read at send time (public.recipe_import_notification). */
export type RecipeImportDetails = {
  status: string;
  recipeId: string | null;
  recipeName: string | null;
  appliedListId: string | null;
  listName: string | null;
  householdName: string | null;
  listGone: boolean;
  errorCode: string | null;
  resetsAt: string | null;
};

export type GroupItem = { id: string; name: string; recipeId: string | null; recipeName: string | null };

/** A group re-read at send time (public.notification_group). */
export type GroupDetails = {
  listName: string | null;
  actorName: string | null;
  /** Live rows only: contributions not undone, items still checked. One per contribution for adds. */
  items: GroupItem[];
  lastSentAt: string | null;
};

export type Recipient = { userId: string; token: string; platform: string };
export type StoredReceipt = { ticketId: string; token: string };
/** A sent group, for the shopping window. */
export type SentGroup = { householdId: string; actor: string; listId: string; kind: EventKind };

/** The database, over the service-role client in store.ts and fakes in tests. */
export type NotificationStore = {
  readEvents(qty: number, vtSeconds: number): Promise<QueuedEvent[]>;
  /** With `sent`, also records the group as sent (the shopping window), in the same transaction. */
  archive(msgIds: number[], sent?: SentGroup): Promise<void>;
  /** Makes events visible again for the next run. */
  release(msgIds: number[]): Promise<void>;
  groupDetails(kind: EventKind, listId: string, actor: string, ids: string[]): Promise<GroupDetails>;
  recipients(householdId: string, actor: string, kind: EventKind, at: Date): Promise<Recipient[]>;
  /** Null when the job is gone. */
  recipeImport(shareImportId: string): Promise<RecipeImportDetails | null>;
  /** The sharer's own tokens, with `recipe_imports` on and outside their quiet hours at `at`. */
  recipeImportRecipients(userId: string, at: Date): Promise<Recipient[]>;
  deleteTokens(tokens: string[]): Promise<void>;
  saveReceipts(receipts: StoredReceipt[]): Promise<void>;
  /** Drops receipts older than 24 hours, then returns those at least minAgeSeconds old. */
  dueReceipts(minAgeSeconds: number, limit: number): Promise<StoredReceipt[]>;
  deleteReceipts(ticketIds: string[]): Promise<void>;
};

export const READ_LIMIT = 500;
/**
 * How long a run hides the events it read. Above the Edge runtime's longest run (400 s wall clock on
 * paid plans), so the next cron run can't read a group this run is still sending. A group whose send
 * fails reappears after it; its oldest event is then at most 5 + 7 minutes old, inside STALE_MS, so
 * it's tried once more.
 */
export const VISIBILITY_SECONDS = 420;
/** A group sends once its newest event is this old… */
export const QUIET_MS = 60_000;
/** …or its oldest is this old, whichever is first. */
export const MAX_WAIT_MS = 5 * 60_000;
/** Events whose row time is older than this are dropped (checks synced long after the trip). */
export const STALE_MS = 15 * 60_000;
/** At most one shopping push per (actor, list) in this window. */
export const SHOPPING_WINDOW_MS = 2 * 60 * 60_000;
export const RECEIPT_MIN_AGE_SECONDS = 15 * 60;
export const RECEIPTS_LIMIT = 1000;
/** Tries to archive events once their push went out; waits 1 s, then 2 s between them. */
export const ARCHIVE_TRIES = 3;
export const ARCHIVE_DELAY_MS = 1000;

const KINDS: readonly string[] = ['items_added', 'shopping'];

const str = (v: unknown) => typeof v === 'string' && v.length > 0;

/** A queue message the worker can use, or null (it's archived as dropped). */
export function parseEvent(message: unknown): HouseholdEvent | RecipeImportEvent | null {
  if (typeof message !== 'object' || message === null) return null;
  const m = message as Record<string, unknown>;
  if (m.kind === 'recipe_import') return parseRecipeImportEvent(m);
  if (!KINDS.includes(m.kind as string)) return null;
  if (!str(m.household_id) || !str(m.list_id) || !str(m.actor) || !str(m.list_item_id) || !str(m.at)) return null;
  if (Number.isNaN(Date.parse(m.at as string))) return null;
  if (m.kind === 'items_added' && !str(m.contribution_id)) return null;
  return m as unknown as HouseholdEvent;
}

function parseRecipeImportEvent(m: Record<string, unknown>): RecipeImportEvent | null {
  if (!str(m.share_import_id) || !str(m.user_id) || !str(m.household_id) || !str(m.at)) return null;
  if (m.status !== 'done' && m.status !== 'failed') return null;
  if (Number.isNaN(Date.parse(m.at as string))) return null;
  return m as unknown as RecipeImportEvent;
}

export type Group = {
  key: string;
  kind: EventKind;
  householdId: string;
  actor: string;
  listId: string;
  events: { msgId: number; event: HouseholdEvent; at: number }[];
};

export type Sorted = {
  /** Unusable or stale: archive without sending. */
  dropped: number[];
  ready: Group[];
  waiting: Group[];
  /** Recipe imports: each is sent at once, on its own. */
  imports: { msgId: number; event: RecipeImportEvent }[];
};

/** Splits a run's events into dropped ones, ready groups and groups still waiting. */
export function groupEvents(queued: QueuedEvent[], now: number): Sorted {
  const dropped: number[] = [];
  const groups = new Map<string, Group>();
  const imports: Sorted['imports'] = [];
  for (const q of queued) {
    const event = parseEvent(q.message);
    if (!event) {
      dropped.push(q.msgId);
      continue;
    }
    const at = Date.parse(event.at);
    if (now - at > STALE_MS) {
      dropped.push(q.msgId);
      continue;
    }
    if (event.kind === 'recipe_import') {
      imports.push({ msgId: q.msgId, event });
      continue;
    }
    const key = [event.household_id, event.actor, event.list_id, event.kind].join('|');
    let group = groups.get(key);
    if (!group) {
      group = { key, kind: event.kind, householdId: event.household_id, actor: event.actor, listId: event.list_id, events: [] };
      groups.set(key, group);
    }
    group.events.push({ msgId: q.msgId, event, at });
  }
  const ready: Group[] = [];
  const waiting: Group[] = [];
  for (const group of groups.values()) {
    const times = group.events.map((e) => e.at);
    const quiet = now - Math.max(...times) >= QUIET_MS;
    const capped = now - Math.min(...times) >= MAX_WAIT_MS;
    (quiet || capped ? ready : waiting).push(group);
  }
  return { dropped, ready, waiting, imports };
}

/** The ids notification_group re-reads: contributions for adds, items for checks. */
export function groupRowIds(group: Group): string[] {
  const ids = group.events.map((e) => (group.kind === 'items_added' ? e.event.contribution_id! : e.event.list_item_id));
  return [...new Set(ids)];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The push's title and body, or null when there's nothing left to say (the list is gone, or every
 * add was undone, or every item unchecked). Names are passed through as they are: no markup.
 */
export function buildText(kind: EventKind, details: GroupDetails): { title: string; body: string } | null {
  if (details.listName === null || details.items.length === 0) return null;
  const actor = details.actorName?.trim() || 'Someone';
  if (kind === 'shopping') return { title: details.listName, body: `${actor} is shopping` };

  const first = details.items[0];
  if (first.recipeId !== null && first.recipeName && details.items.every((i) => i.recipeId === first.recipeId)) {
    return { title: details.listName, body: `${actor} added ${first.recipeName} (${plural(details.items.length, 'item')})` };
  }
  // A Combine can add twice to one item: name and count items, not contributions.
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of details.items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    names.push(item.name);
  }
  let what: string;
  if (names.length === 1) what = names[0];
  else if (names.length === 2) what = `${names[0]} and ${names[1]}`;
  else what = `${names[0]}, ${names[1]} and ${names.length - 2} more`;
  return { title: details.listName, body: `${actor} added ${what}` };
}

export function buildMessages(group: Group, text: { title: string; body: string }, recipients: Recipient[]): ExpoMessage[] {
  return recipients.map((r) => ({
    to: r.token,
    title: text.title,
    body: text.body,
    data: { url: `/list/${group.listId}`, kind: group.kind, householdId: group.householdId },
    sound: 'default',
    threadId: group.listId,
  }));
}

// --- Recipe imports (spec 4.13) ---

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A failed share's reason in spec 4.10's plain words, by its error code. */
export function importFailureReason(code: string | null, resetsAt: string | null): string {
  switch (code) {
    case 'not_a_recipe':
      return "That page doesn't look like a recipe";
    case 'invalid_url':
      return "That doesn't look like a link";
    case 'not_entitled':
      return "Recipe import isn't included in your plan.";
    case 'not_a_member':
      return "You're no longer in that household.";
    case 'daily_limit':
      return "You've reached today's limit. Try again tomorrow.";
    case 'limit_reached': {
      const resets = resetsAt ? new Date(resetsAt) : null;
      if (!resets || Number.isNaN(resets.getTime())) return "You've used this month's recipe imports.";
      // The limits reset at midnight UTC (_shared/limits.ts).
      return `You've used this month's recipe imports. They reset on ${MONTHS[resets.getUTCMonth()]} ${resets.getUTCDate()}.`;
    }
    case 'fetch_failed':
      return "Couldn't reach that site";
    default:
      return 'Something went wrong.';
  }
}

/** A recipe import push's title, body and url, or null when there's nothing to say. Names as they are: no markup. */
export function buildRecipeImportText(details: RecipeImportDetails): { title: string; body: string; url: string } | null {
  if (details.status === 'failed') {
    return { title: "Couldn't import that recipe", body: importFailureReason(details.errorCode, details.resetsAt), url: '/recipes' };
  }
  if (details.status !== 'done' || !details.recipeId) return null;
  const name = details.recipeName?.trim() || 'Your recipe';
  let body: string;
  if (details.listGone) body = `Saved ${name}. Its list was gone, so nothing was added.`;
  else if (details.appliedListId && details.listName) body = `Added to ${details.listName}`;
  else if (details.householdName) body = `Saved to ${details.householdName}`;
  else body = `Saved ${name}`;
  return { title: `${name} is ready`, body, url: `/recipe/${details.recipeId}` };
}

export function buildRecipeImportMessages(
  event: RecipeImportEvent,
  text: { title: string; body: string; url: string },
  recipients: Recipient[],
): ExpoMessage[] {
  return recipients.map((r) => ({
    to: r.token,
    title: text.title,
    body: text.body,
    data: { url: text.url, kind: 'recipe_import', status: event.status, shareImportId: event.share_import_id },
    sound: 'default',
  }));
}

async function sendRecipeImport(
  event: RecipeImportEvent,
  store: NotificationStore,
  expo: ExpoClient,
  clock: Date,
): Promise<'dropped' | { messages: ExpoMessage[]; tickets: PushTicket[] }> {
  const details = await store.recipeImport(event.share_import_id);
  // Gone, or moved on since (Try again put it back): the event is out of date.
  if (!details || details.status !== event.status) return 'dropped';
  const text = buildRecipeImportText(details);
  if (!text) return 'dropped';
  const recipients = await store.recipeImportRecipients(event.user_id, clock);
  if (recipients.length === 0) return 'dropped';
  const messages = buildRecipeImportMessages(event, text, recipients);
  return { messages, tickets: await expo.send(messages) };
}

export type RunResult = {
  read: number;
  /** Groups and recipe imports that got a push. */
  sent: number;
  /** Pushes sent (one per recipient device). */
  pushes: number;
  /** Events archived without a push: unusable, stale, undone, in the shopping window, no recipients. */
  dropped: number;
  /** Events left for a later run. */
  waiting: number;
  /** Groups that failed (left to reappear and be tried again). */
  failed: number;
  receiptsChecked: number;
  tokensRemoved: number;
};

export type RunDeps = {
  store: NotificationStore;
  expo: ExpoClient;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One run: the queue, then the receipts. Logs no names, tokens or message text. */
export async function runWorker({
  store,
  expo,
  now = () => new Date(),
  sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}: RunDeps): Promise<RunResult> {
  const result: RunResult = { read: 0, sent: 0, pushes: 0, dropped: 0, waiting: 0, failed: 0, receiptsChecked: 0, tokensRemoved: 0 };

  const queued = await store.readEvents(READ_LIMIT, VISIBILITY_SECONDS);
  result.read = queued.length;
  const clock = now();
  const sorted = groupEvents(queued, clock.getTime());

  if (sorted.dropped.length > 0) {
    await store.archive(sorted.dropped);
    result.dropped += sorted.dropped.length;
  }
  const waitingIds = sorted.waiting.flatMap((g) => g.events.map((e) => e.msgId));
  if (waitingIds.length > 0) {
    await store.release(waitingIds);
    result.waiting = waitingIds.length;
  }

  for (const group of sorted.ready) {
    const msgIds = group.events.map((e) => e.msgId);
    let outcome: Awaited<ReturnType<typeof sendGroup>>;
    try {
      outcome = await sendGroup(group, store, expo, clock);
      if (outcome === 'dropped') await store.archive(msgIds);
    } catch (err) {
      // Nothing sent, left as read: the events reappear after the visibility timeout and are tried
      // again until they go stale.
      result.failed += 1;
      console.error(`send-notifications: a ${group.kind} group failed:`, message(err));
      reportError('send-notifications', err);
      continue;
    }
    if (outcome === 'dropped') {
      result.dropped += msgIds.length;
      continue;
    }
    result.sent += 1;
    result.pushes += outcome.messages.length;
    // Sent: a failure from here on mustn't send the group again, so archiving is tried on its own
    // and never counts as a failed send.
    const { householdId, actor, listId, kind } = group;
    await archiveSent(store, sleep, msgIds, { householdId, actor, listId, kind });
    try {
      result.tokensRemoved += await handleTickets(store, outcome.messages, outcome.tickets);
    } catch (err) {
      console.error('send-notifications: recording a sent group failed:', message(asError(err)));
      reportError('send-notifications', asError(err), { event: 'record_sent_failed' });
    }
  }

  for (const { msgId, event } of sorted.imports) {
    let outcome: Awaited<ReturnType<typeof sendRecipeImport>>;
    try {
      outcome = await sendRecipeImport(event, store, expo, clock);
      if (outcome === 'dropped') await store.archive([msgId]);
    } catch (err) {
      // Left as read, like a group: tried again until it goes stale.
      result.failed += 1;
      console.error('send-notifications: a recipe_import push failed:', message(err));
      reportError('send-notifications', err);
      continue;
    }
    if (outcome === 'dropped') {
      result.dropped += 1;
      continue;
    }
    result.sent += 1;
    result.pushes += outcome.messages.length;
    await archiveSent(store, sleep, [msgId]);
    try {
      result.tokensRemoved += await handleTickets(store, outcome.messages, outcome.tickets);
    } catch (err) {
      console.error('send-notifications: recording a sent recipe import failed:', message(asError(err)));
      reportError('send-notifications', asError(err), { event: 'record_sent_failed' });
    }
  }

  try {
    const checked = await checkReceipts(store, expo);
    result.receiptsChecked = checked.checked;
    result.tokensRemoved += checked.tokensRemoved;
  } catch (err) {
    console.error('send-notifications: receipts failed:', message(err));
    reportError('send-notifications', err);
  }
  return result;
}

/**
 * Archives events whose push went out (with a group, recording its window in the same call), trying
 * ARCHIVE_TRIES times. Never throws and never releases: if every try fails the events reappear only
 * after the visibility timeout, and the failure goes to Sentry.
 */
async function archiveSent(
  store: NotificationStore,
  sleep: (ms: number) => Promise<void>,
  msgIds: number[],
  sent?: SentGroup,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await store.archive(msgIds, sent);
      return;
    } catch (err) {
      if (attempt >= ARCHIVE_TRIES) {
        console.error('send-notifications: archiving sent events failed:', message(asError(err)));
        reportError('send-notifications', asError(err), { event: 'archive_sent_failed' });
        return;
      }
      await sleep(ARCHIVE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
}

async function sendGroup(
  group: Group,
  store: NotificationStore,
  expo: ExpoClient,
  clock: Date,
): Promise<'dropped' | { messages: ExpoMessage[]; tickets: PushTicket[] }> {
  const details = await store.groupDetails(group.kind, group.listId, group.actor, groupRowIds(group));
  const text = buildText(group.kind, details);
  if (!text) return 'dropped';
  if (
    group.kind === 'shopping' &&
    details.lastSentAt !== null &&
    clock.getTime() - Date.parse(details.lastSentAt) < SHOPPING_WINDOW_MS
  ) {
    return 'dropped';
  }
  const recipients = await store.recipients(group.householdId, group.actor, group.kind, clock);
  if (recipients.length === 0) return 'dropped';

  const messages = buildMessages(group, text, recipients);
  return { messages, tickets: await expo.send(messages) };
}

async function handleTickets(store: NotificationStore, messages: ExpoMessage[], tickets: PushTicket[]): Promise<number> {
  const receipts: StoredReceipt[] = [];
  const gone = new Set<string>();
  const reported = new Set<string>();
  tickets.forEach((ticket, i) => {
    if (ticket.status === 'ok') receipts.push({ ticketId: ticket.id, token: messages[i].to });
    else if (ticket.details?.error === 'DeviceNotRegistered') gone.add(ticket.details.expoPushToken ?? messages[i].to);
    else pushError('ticket', ticket.details?.error ?? ticket.message ?? 'unknown', reported);
  });
  if (receipts.length > 0) await store.saveReceipts(receipts);
  if (gone.size > 0) await store.deleteTokens([...gone]);
  return gone.size;
}

/**
 * A push Expo or the device service refused for a reason other than an unregistered device (bad
 * credentials, too big): logged, and sent to Sentry once per reason in `reported`, since a broken
 * APNs key fails every push of a run the same way.
 */
function pushError(stage: 'ticket' | 'receipt', reason: string, reported: Set<string>) {
  console.error(`send-notifications: ${stage} error:`, reason);
  if (reported.has(reason)) return;
  reported.add(reason);
  reportError('send-notifications', new Error(`Push ${stage} error: ${reason}`), { event: `push_${stage}_error`, reason });
}

/** Receipts at least 15 minutes old: removes unregistered devices' tokens, then forgets them. */
export async function checkReceipts(store: NotificationStore, expo: ExpoClient): Promise<{ checked: number; tokensRemoved: number }> {
  const due = await store.dueReceipts(RECEIPT_MIN_AGE_SECONDS, RECEIPTS_LIMIT);
  if (due.length === 0) return { checked: 0, tokensRemoved: 0 };
  const receipts = await expo.getReceipts(due.map((r) => r.ticketId));
  const checked: string[] = [];
  const gone = new Set<string>();
  const reported = new Set<string>();
  for (const stored of due) {
    const receipt = receipts[stored.ticketId];
    if (!receipt) continue; // not ready yet; dropped after 24 hours
    checked.push(stored.ticketId);
    if (receipt.status === 'error') {
      if (receipt.details?.error === 'DeviceNotRegistered') gone.add(stored.token);
      else pushError('receipt', receipt.details?.error ?? receipt.message ?? 'unknown', reported);
    }
  }
  if (gone.size > 0) await store.deleteTokens([...gone]);
  if (checked.length > 0) await store.deleteReceipts(checked);
  return { checked: checked.length, tokensRemoved: gone.size };
}

/** POST → 200 RunResult · 405 · 500. */
export async function handleRequest(req: Request, run: () => Promise<RunResult>): Promise<Response> {
  if (req.method !== 'POST') return Response.json({ error: 'method_not_allowed', message: 'Use POST' }, { status: 405 });
  try {
    return Response.json(await run());
  } catch (err) {
    console.error('send-notifications failed:', message(err));
    reportError('send-notifications', err);
    return Response.json({ error: 'internal', message: 'Sending notifications failed' }, { status: 500 });
  }
}
