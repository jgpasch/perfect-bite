import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, ingredients, listItemContributions, listItems } from '@/db';
import { usualUnitsByKey } from '@/domain/usual-unit';
import { categorizePending } from '@/features/categories/categorization';
import { addItem, groupItems, listItemsQuery, setItemChecked, usualUnitsQuery } from '@/features/lists/items';
import { siriAddedToast } from '@/features/lists/list-view';
import { createList, deleteList, ensureStarterData, getDefaultListId, setListArchived } from '@/features/lists/lists';
import { resetDb } from '@/test/db';
import { setAppGroupRoot } from '@/test/fake-file-system';

import { PENDING_DIR, readPendingSiriAdds } from '../app-group';
import { drainSiriQueue, onSiriAdds, runSiriDrain, siriAddIds, siriTargetListId } from '../drain';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('expo-file-system', () => require('@/test/fake-file-system'));
jest.mock('expo-network', () => ({ addNetworkStateListener: () => ({ remove: () => {} }) }));
jest.mock('@/features/categories/categorization', () => ({ categorizePending: jest.fn(() => Promise.resolve()) }));

const USER = 'user-1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// UUIDv7 envelope ids, in the order they were spoken.
const E1 = '019a4c2e-7d3b-7a10-8f2e-3b9d1c0e5a71';
const E2 = '019a4c2e-9e01-7c44-b1aa-0f6e2d8c3b92';
const E3 = '019a4c2f-0102-7d55-a2bb-1a2b3c4d5e6f';
const GONE_LIST = '019a4c10-0000-7000-8000-00000000c057';

let root: string;
let groceries: string;
let costco: string;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  groceries = getDefaultListId(USER)!;
  costco = createList('Costco');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'siri-drain-'));
  fs.mkdirSync(path.join(root, PENDING_DIR), { recursive: true });
  setAppGroupRoot(root);
  jest.mocked(categorizePending).mockClear();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Writes a queued add as the intent does: `siri/pending/<id>.json`. */
function enqueue(id: string, text: string, extra: { listId?: string; createdAt?: string } = {}): void {
  const envelope = { id, source: 'siri', text, createdAt: '2026-10-08T17:42:05.123-05:00', appVersion: '1.0.0', ...extra };
  writeQueued(`${id}.json`, JSON.stringify(envelope));
}
const writeQueued = (name: string, body: string) => fs.writeFileSync(path.join(root, PENDING_DIR, name), body);
const queued = () => fs.readdirSync(path.join(root, PENDING_DIR)).sort();

/** "1 gal milk" per unchecked item, then "✓ 2 milk" per checked one. */
const rows = (id: string) => {
  const { unchecked, checked } = groupItems(listItemsQuery(id, USER).all(), usualUnitsByKey(usualUnitsQuery(id).all()));
  const text = (i: { displayName: string; amountText: string }) => (i.amountText ? `${i.amountText} ${i.displayName}` : i.displayName);
  return [...unchecked.map(text), ...checked.map((i) => `✓ ${text(i)}`)];
};
const contribution = (id: string) => db.select().from(listItemContributions).where(eq(listItemContributions.id, id)).get();

describe('siriAddIds', () => {
  test('derives the same UUIDv5 ids from the same envelope, and different ones per envelope', () => {
    const ids = siriAddIds(E1);
    expect(ids).toEqual(siriAddIds(E1));
    expect(ids.itemId).toMatch(UUID);
    expect(ids.contributionId).toMatch(UUID);
    expect(ids.itemId).not.toBe(ids.contributionId);
    expect(siriAddIds(E2).itemId).not.toBe(ids.itemId);
    expect(siriAddIds(E2).contributionId).not.toBe(ids.contributionId);
  });
});

describe('drainSiriQueue', () => {
  test('happy path: adds each envelope oldest first with derived ids, then deletes its file', () => {
    enqueue(E2, 'paper towels', { listId: costco, createdAt: '2026-10-08T17:43:11.004-05:00' });
    enqueue(E1, 'two avocados');

    const result = drainSiriQueue(USER);

    expect(result).toEqual({ added: 2, pendingNames: ['avocado', 'paper towel'] });
    expect(queued()).toEqual([]);
    expect(rows(groceries)).toEqual(['2 avocados']);
    expect(rows(costco)).toEqual(['paper towels']);
    const { itemId, contributionId } = siriAddIds(E1);
    expect(db.select().from(listItems).where(eq(listItems.id, itemId)).get()).toMatchObject({
      listId: groceries,
      ingredientName: 'avocado',
      addedBy: USER,
      createdAt: new Date('2026-10-08T22:42:05.123Z'),
    });
    expect(contribution(contributionId)).toMatchObject({ listItemId: itemId, source: 'siri', quantity: 2, unit: null, addedBy: USER });
    expect(contribution(siriAddIds(E2).contributionId)).toMatchObject({ listItemId: siriAddIds(E2).itemId, source: 'siri' });
  });

  test('a list that is gone, or archived, uses the default list', () => {
    enqueue(E1, 'eggs', { listId: GONE_LIST });
    setListArchived(costco, true);
    enqueue(E2, 'milk', { listId: costco });

    expect(drainSiriQueue(USER).added).toBe(2);

    expect(rows(groceries)).toEqual(['eggs', 'milk']);
    expect(rows(costco)).toEqual([]);
    expect(queued()).toEqual([]);
  });

  test('a deleted named list uses the default list', () => {
    deleteList(costco);
    enqueue(E1, 'eggs', { listId: costco });

    drainSiriQueue(USER);

    expect(rows(groceries)).toEqual(['eggs']);
  });

  test('draining the same envelope twice applies it once (crash between apply and delete)', () => {
    enqueue(E1, '1 gal milk');
    expect(drainSiriQueue(USER).added).toBe(1);
    enqueue(E1, '1 gal milk'); // the file survived the first drain

    expect(drainSiriQueue(USER)).toEqual({ added: 0, pendingNames: [] });

    expect(rows(groceries)).toEqual(['1 gal milk']);
    expect(queued()).toEqual([]);
  });

  test('an envelope already applied and then deleted by the user stays deleted', () => {
    enqueue(E1, 'milk');
    drainSiriQueue(USER);
    db.update(listItems).set({ deletedAt: new Date() }).where(eq(listItems.id, siriAddIds(E1).itemId)).run();
    enqueue(E1, 'milk');

    expect(drainSiriQueue(USER).added).toBe(0);

    expect(rows(groceries)).toEqual([]);
  });

  test('bad files and text with nothing to add are logged and deleted; the rest still apply', () => {
    writeQueued('019a4c2e-0000-7000-8000-000000000001.json', '{not json');
    writeQueued('019a4c2e-0000-7000-8000-000000000002.json', JSON.stringify({ id: 'nope', text: 'milk' }));
    enqueue(E1, '   ');
    enqueue(E2, 'eggs');
    writeQueued(`${E3}.json.tmp`, '{"partial":'); // still being written by the intent

    expect(drainSiriQueue(USER)).toEqual({ added: 1, pendingNames: ['egg'] });

    expect(queued()).toEqual([`${E3}.json.tmp`]);
    expect(rows(groceries)).toEqual(['eggs']);
    expect(console.warn).toHaveBeenCalledTimes(3);
    expect(jest.mocked(console.warn).mock.calls.map((c) => c[0])).toEqual([
      '[siri] dropping a bad queued add',
      '[siri] dropping a bad queued add',
      '[siri] dropping a queued add with nothing to add',
    ]);
  });

  test('Combines silently with an open item on the list', () => {
    const existing = addItem(groceries, '1 gal milk', USER)!;
    enqueue(E1, '1 gal milk');

    expect(drainSiriQueue(USER).added).toBe(1);

    expect(rows(groceries)).toEqual(['2 gal milk']);
    expect(contribution(siriAddIds(E1).contributionId)).toMatchObject({ listItemId: existing.itemId, source: 'siri' });
    expect(db.select().from(listItems).where(eq(listItems.id, siriAddIds(E1).itemId)).get()).toBeUndefined();
  });

  test('reopens a checked item with its amounts replaced', () => {
    const existing = addItem(groceries, '3 lb apples', USER)!;
    setItemChecked(existing.itemId, true, USER);
    enqueue(E1, '2 lb apples');

    drainSiriQueue(USER);

    expect(rows(groceries)).toEqual(['2 lb apples']);
  });

  test('several adds of the same thing fold into one item', () => {
    enqueue(E1, 'milk');
    enqueue(E2, 'milk');

    expect(drainSiriQueue(USER).added).toBe(2);

    expect(rows(groceries)).toEqual(['2 milk']);
  });

  test('with no list to add to, everything stays queued', () => {
    deleteList(groceries);
    deleteList(costco);
    expect(getDefaultListId(USER)).toBeNull();
    enqueue(E1, 'milk');

    expect(drainSiriQueue(USER)).toEqual({ added: 0, pendingNames: [] });

    expect(queued()).toEqual([`${E1}.json`]);
  });

  test('a drain started during another does nothing', () => {
    enqueue(E1, 'milk');
    let inner: ReturnType<typeof drainSiriQueue> | undefined;

    const outer = drainSiriQueue(USER, () => {
      inner = drainSiriQueue(USER);
      return readPendingSiriAdds();
    });

    expect(inner).toEqual({ added: 0, pendingNames: [] });
    expect(outer.added).toBe(1);
    expect(rows(groceries)).toEqual(['milk']);
  });

  test('records new names as pending for categorization', () => {
    enqueue(E1, 'dragon fruit');

    expect(drainSiriQueue(USER).pendingNames).toEqual(['dragon fruit']);
    expect(db.select().from(ingredients).where(eq(ingredients.normalizedName, 'dragon fruit')).get()?.status).toBe('pending');
  });
});

describe('siriTargetListId', () => {
  const envelope = (listId?: string) => ({ id: E1, source: 'siri' as const, text: 'milk', createdAt: '2026-10-08T17:42:05Z', appVersion: '1', listId });

  test('the named list, else the default', () => {
    expect(siriTargetListId(envelope(costco), USER)).toBe(costco);
    expect(siriTargetListId(envelope(), USER)).toBe(groceries);
    expect(siriTargetListId(envelope(GONE_LIST), USER)).toBe(groceries);
  });
});

describe('runSiriDrain', () => {
  test('categorizes new names in one batch and tells listeners the count', () => {
    const heard: number[] = [];
    const stop = onSiriAdds((n) => heard.push(n));
    enqueue(E1, 'dragon fruit');
    enqueue(E2, 'rambutan');

    expect(runSiriDrain(USER)?.added).toBe(2);

    expect(categorizePending).toHaveBeenCalledTimes(1);
    expect(categorizePending).toHaveBeenCalledWith(['dragon fruit', 'rambutan']);
    expect(heard).toEqual([2]);
    stop();
  });

  test('nothing added: no categorization call and no toast', () => {
    const listener = jest.fn();
    const stop = onSiriAdds(listener);
    enqueue(E1, 'milk');
    addItem(groceries, 'milk', USER); // milk is now known, so the drain records no pending name

    expect(runSiriDrain(USER)?.added).toBe(1);
    expect(categorizePending).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledWith(1);

    listener.mockClear();
    expect(runSiriDrain(USER)?.added).toBe(0);
    expect(listener).not.toHaveBeenCalled();
    stop();
  });

  test('an unsubscribed listener hears nothing', () => {
    const listener = jest.fn();
    onSiriAdds(listener)();
    enqueue(E1, 'milk');

    runSiriDrain(USER);

    expect(listener).not.toHaveBeenCalled();
  });

  test('without the App Group it does nothing', () => {
    setAppGroupRoot(null);
    enqueue(E1, 'milk');

    expect(runSiriDrain(USER)).toBeNull();
    expect(queued()).toEqual([`${E1}.json`]);
    expect(rows(groceries)).toEqual([]);
  });
});

describe('siriAddedToast', () => {
  test('counts items', () => {
    expect(siriAddedToast(1)).toEqual({ message: 'Siri added 1 item' });
    expect(siriAddedToast(2)).toEqual({ message: 'Siri added 2 items' });
  });
});
