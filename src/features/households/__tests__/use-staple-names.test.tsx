// `useStapleNames` (spec 4.5 Marking from a recipe): the Add to a list sheet's tags, read at once and kept live.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { db, households } from '@/db';
import { ensureStarterData, getDefaultListId, getList } from '@/features/lists/lists';
import { resetDb } from '@/test/db';

import { setStaple, useStapleNames } from '../staples';

jest.mock('@/db/client', () => require('@/test/db'));

// Real writes go to better-sqlite3, which has no change hook: tests announce changes by hand.
type ChangeListener = (event: { tableName: string }) => void;
const mockChangeListeners = new Set<ChangeListener>();
jest.mock('expo-sqlite', () => ({
  addDatabaseChangeListener: (l: ChangeListener) => {
    mockChangeListeners.add(l);
    return { remove: () => mockChangeListeners.delete(l) };
  },
}));

async function changed(tableName: string) {
  await act(async () => {
    mockChangeListeners.forEach((l) => l({ tableName }));
  });
}

const USER = 'user-1';
let home: string;
let tree: ReactTestRenderer | null = null;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  home = getList(getDefaultListId(USER)!)!.householdId;
  db.insert(households).values({ id: 'cabin', name: 'Cabin' }).run();
});

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

function render(householdId: string) {
  const renders: string[][] = [];
  function Probe() {
    renders.push([...useStapleNames(householdId)].sort());
    return null;
  }
  act(() => {
    tree = create(<Probe />);
  });
  return renders;
}

describe('useStapleNames', () => {
  test('has the staples on the first render, before the live query lands', () => {
    setStaple(home, 'salt', true, USER);
    const renders = render(home);
    expect(renders[0]).toEqual(['salt']);
  });

  test("follows marks and unmarks, this household's only", async () => {
    setStaple(home, 'salt', true, USER);
    const renders = render(home);
    await act(async () => {});
    setStaple(home, 'cilantro', true, 'user-2');
    setStaple('cabin', 'pepper', true, USER);
    await changed('household_staples');
    expect(renders.at(-1)).toEqual(['cilantro', 'salt']);
    setStaple(home, 'salt', false, 'user-2');
    await changed('household_staples');
    expect(renders.at(-1)).toEqual(['cilantro']);
    setStaple(home, 'cilantro', false, USER);
    await changed('household_staples');
    expect(renders.at(-1)).toEqual([]);
  });

  test('other tables changing leave it be', async () => {
    const renders = render(home);
    await act(async () => {});
    setStaple(home, 'salt', true, USER);
    await changed('list_items');
    expect(renders.at(-1)).toEqual([]);
  });
});
