import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import { db, households } from '@/db';
import { createList, deleteList, ensureStarterData, getDefaultListId, setDefaultList, setListArchived } from '@/features/lists/lists';
import { ListSnapshotSchema } from '@/shared';
import { resetDb } from '@/test/db';

import * as appGroup from '../app-group';
import {
  buildListSnapshot,
  clearSiriListSnapshot,
  currentListSnapshot,
  siriListChoices,
  SNAPSHOT_TABLES,
  startListSnapshot,
  syncListSnapshot,
  type SnapshotListRow,
} from '../list-snapshot';

jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('../app-group', () => ({
  getAppGroupContainer: jest.fn(() => ({})),
  writeListSnapshot: jest.fn(),
  clearListSnapshot: jest.fn(),
}));
type ChangeListener = (event: { tableName: string }) => void;
const mockChangeListeners: ChangeListener[] = [];
const mockRemoveListener = jest.fn();
jest.mock('expo-sqlite', () => ({
  addDatabaseChangeListener: (l: ChangeListener) => {
    mockChangeListeners.push(l);
    return { remove: mockRemoveListener };
  },
}));
const changeListeners = mockChangeListeners;
const removeListener = mockRemoveListener;

const mocked = appGroup as jest.Mocked<typeof appGroup>;

// Two households, lists in the user's order, one archived.
const HOME = 'Smith home';
const CABIN = 'Lake cabin';
const ID = {
  groceries: '019a4c10-0000-7000-8000-00000000a001',
  costco: '019a4c10-0000-7000-8000-00000000a002',
  cabinGroceries: '019a4c10-0000-7000-8000-00000000b001',
  party: '019a4c10-0000-7000-8000-00000000b002',
};
const FIXTURE: SnapshotListRow[] = [
  { id: ID.groceries, name: 'Groceries', householdName: HOME, archivedAt: null },
  { id: ID.cabinGroceries, name: 'Groceries', householdName: CABIN, archivedAt: null },
  { id: ID.party, name: 'Party', householdName: CABIN, archivedAt: new Date('2026-10-01T00:00:00Z') },
  { id: ID.costco, name: 'Costco', householdName: HOME, archivedAt: null },
];

describe('buildListSnapshot', () => {
  test('offers every live list across households, in order, with its household and the default', () => {
    expect(buildListSnapshot(FIXTURE, ID.cabinGroceries)).toEqual({
      defaultListId: ID.cabinGroceries,
      lists: [
        { id: ID.groceries, name: 'Groceries', householdName: HOME },
        { id: ID.cabinGroceries, name: 'Groceries', householdName: CABIN },
        { id: ID.costco, name: 'Costco', householdName: HOME },
      ],
    });
  });

  test('passes the schema the intent reads', () => {
    expect(() => ListSnapshotSchema.parse(buildListSnapshot(FIXTURE, ID.groceries))).not.toThrow();
  });

  test('leaves archived lists out, and a default that is not offered', () => {
    const snapshot = buildListSnapshot(FIXTURE, ID.party);
    expect(snapshot.lists.map((l) => l.id)).not.toContain(ID.party);
    expect(snapshot).not.toHaveProperty('defaultListId');
    expect(buildListSnapshot(FIXTURE, 'not-a-list')).not.toHaveProperty('defaultListId');
  });

  test('no default list', () => {
    expect(buildListSnapshot(FIXTURE, null)).not.toHaveProperty('defaultListId');
  });

  test('no lists', () => {
    expect(buildListSnapshot([], null)).toEqual({ lists: [] });
    expect(buildListSnapshot([], ID.groceries)).toEqual({ lists: [] });
  });

  test('does not change its input', () => {
    const copy = structuredClone(FIXTURE);
    buildListSnapshot(FIXTURE, ID.groceries);
    expect(FIXTURE).toEqual(copy);
  });
});

describe('siriListChoices', () => {
  test('names the household when there are several, and ticks the default', () => {
    expect(siriListChoices(buildListSnapshot(FIXTURE, ID.costco))).toEqual([
      { id: ID.groceries, name: 'Groceries', householdName: HOME, selected: false },
      { id: ID.cabinGroceries, name: 'Groceries', householdName: CABIN, selected: false },
      { id: ID.costco, name: 'Costco', householdName: HOME, selected: true },
    ]);
  });

  test('one household: no household names', () => {
    const home = FIXTURE.filter((l) => l.householdName === HOME);
    expect(siriListChoices(buildListSnapshot(home, ID.groceries))).toEqual([
      { id: ID.groceries, name: 'Groceries', selected: true },
      { id: ID.costco, name: 'Costco', selected: false },
    ]);
  });

  test('nothing ticked without a default, and no rows without lists', () => {
    expect(siriListChoices(buildListSnapshot(FIXTURE, null)).some((c) => c.selected)).toBe(false);
    expect(siriListChoices({ lists: [] })).toEqual([]);
  });
});

const USER = 'user-1';

describe('currentListSnapshot', () => {
  let groceries: string;
  beforeEach(() => {
    resetDb();
    ensureStarterData(USER);
    groceries = getDefaultListId(USER)!;
  });

  test('every list across the households on this device, with the default', () => {
    db.insert(households).values({ id: 'cabin', name: 'Lake cabin' }).run();
    const costco = createList('Costco');
    const cabin = createList('Cabin food', 'cabin');
    expect(currentListSnapshot(USER)).toEqual({
      defaultListId: groceries,
      lists: [
        { id: groceries, name: 'Groceries', householdName: 'Personal' },
        { id: costco, name: 'Costco', householdName: 'Personal' },
        { id: cabin, name: 'Cabin food', householdName: 'Lake cabin' },
      ],
    });
  });

  test('follows the default list, archiving and deleting', () => {
    const costco = createList('Costco');
    const party = createList('Party');
    setDefaultList(USER, costco);
    expect(currentListSnapshot(USER).defaultListId).toBe(costco);

    setListArchived(party, true);
    deleteList(costco);
    // The default falls back to the first remaining list, as getDefaultListId does.
    expect(currentListSnapshot(USER)).toEqual({
      defaultListId: groceries,
      lists: [{ id: groceries, name: 'Groceries', householdName: 'Personal' }],
    });
  });
});

describe('writing the snapshot', () => {
  beforeEach(() => {
    resetDb();
    ensureStarterData(USER);
    jest.clearAllMocks();
    mocked.getAppGroupContainer.mockReturnValue({} as ReturnType<typeof appGroup.getAppGroupContainer>);
    changeListeners.length = 0;
    clearSiriListSnapshot(); // forget the last write between tests
    jest.clearAllMocks();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('writes the current snapshot, then only when it changes', () => {
    syncListSnapshot(USER);
    expect(mocked.writeListSnapshot).toHaveBeenCalledTimes(1);
    expect(mocked.writeListSnapshot).toHaveBeenLastCalledWith(currentListSnapshot(USER));

    syncListSnapshot(USER);
    expect(mocked.writeListSnapshot).toHaveBeenCalledTimes(1);

    const costco = createList('Costco');
    syncListSnapshot(USER);
    expect(mocked.writeListSnapshot).toHaveBeenCalledTimes(2);
    expect(mocked.writeListSnapshot.mock.lastCall?.[0].lists.map((l) => l.id)).toContain(costco);
  });

  test('does nothing without the App Group', () => {
    mocked.getAppGroupContainer.mockReturnValue(undefined);
    syncListSnapshot(USER);
    expect(mocked.writeListSnapshot).not.toHaveBeenCalled();
  });

  test('a failed write is logged, not thrown, and retried next time', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mocked.writeListSnapshot.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    expect(() => syncListSnapshot(USER)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    syncListSnapshot(USER);
    expect(mocked.writeListSnapshot).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  test('sign-out clears the file, and the next sign-in writes again', () => {
    syncListSnapshot(USER);
    clearSiriListSnapshot();
    expect(mocked.clearListSnapshot).toHaveBeenCalledTimes(1);
    syncListSnapshot(USER);
    expect(mocked.writeListSnapshot).toHaveBeenCalledTimes(2);
  });

  test('a failed clear is logged, not thrown', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mocked.clearListSnapshot.mockImplementationOnce(() => {
      throw new Error('no access');
    });
    expect(() => clearSiriListSnapshot()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test('watches lists, households (memberships) and user settings (default list)', () => {
    expect(SNAPSHOT_TABLES).toEqual(['lists', 'households', 'user_settings']);
  });

  test('start writes on launch, then once per burst of relevant changes, until stopped', () => {
    jest.useFakeTimers();
    const stop = startListSnapshot(USER);
    expect(mocked.writeListSnapshot).toHaveBeenCalledTimes(1);
    expect(changeListeners).toHaveLength(1);
    const fire = (tableName: string) => changeListeners[0]({ tableName });

    createList('Costco');
    createList('Target');
    fire('lists');
    fire('lists');
    fire('list_items'); // not a snapshot table
    expect(mocked.writeListSnapshot).toHaveBeenCalledTimes(1);
    jest.runAllTimers();
    expect(mocked.writeListSnapshot).toHaveBeenCalledTimes(2);
    expect(mocked.writeListSnapshot.mock.lastCall?.[0].lists.map((l) => l.name)).toEqual(['Groceries', 'Costco', 'Target']);

    fire('list_items');
    jest.runAllTimers();
    expect(mocked.writeListSnapshot).toHaveBeenCalledTimes(2);

    createList('Aldi');
    fire('lists');
    stop();
    jest.runAllTimers();
    expect(removeListener).toHaveBeenCalledTimes(1);
    expect(mocked.writeListSnapshot).toHaveBeenCalledTimes(2);
  });
});
