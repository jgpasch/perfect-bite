// NEW rows (spec 4.1): which rows are new on open, when a row is in sight, and each badge's 10 s clock.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { MemberNews } from '../last-seen';
import { inSight, newItemIds, useNewBadgeClocks } from '../list-news';

jest.mock('@/global.css', () => ({}));
jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'me' }) }));

const at = (min: number) => new Date(Date.UTC(2026, 9, 16, 12, 0) - min * 60_000);

describe('newItemIds', () => {
  test('each item once, though two members added to it', () => {
    const news: MemberNews[] = [
      {
        userId: 'alex',
        items: [
          { itemId: 'eggs', displayName: 'eggs', addedAt: at(1) },
          { itemId: 'limes', displayName: 'limes', addedAt: at(30) },
        ],
      },
      { userId: 'sam', items: [{ itemId: 'limes', displayName: 'limes', addedAt: at(10) }] },
    ];
    expect([...newItemIds(news)].sort()).toEqual(['eggs', 'limes']);
  });

  test('nothing new is no rows', () => {
    expect(newItemIds([]).size).toBe(0);
    expect(newItemIds([{ userId: 'alex', items: [] }]).size).toBe(0);
  });
});

describe('inSight', () => {
  const viewport = { y: 100, height: 600 };
  test("a row whose middle is in the list's frame", () => {
    expect(inSight({ y: 300, height: 50 }, viewport)).toBe(true);
    // Half under the top edge: its middle is at 100.
    expect(inSight({ y: 75, height: 50 }, viewport)).toBe(true);
    expect(inSight({ y: 74, height: 50 }, viewport)).toBe(false);
    expect(inSight({ y: 675, height: 50 }, viewport)).toBe(true);
    expect(inSight({ y: 676, height: 50 }, viewport)).toBe(false);
    expect(inSight({ y: 900, height: 50 }, viewport)).toBe(false);
  });
});

describe('useNewBadgeClocks', () => {
  type Clocks = ReturnType<typeof useNewBadgeClocks>;
  let clocks!: Clocks;
  let tree: ReactTestRenderer | null = null;
  function Harness({ listId, active }: { listId: string; active: boolean }) {
    clocks = useNewBadgeClocks(listId, active);
    return null;
  }
  const render = (listId: string, active: boolean) =>
    act(() => {
      if (tree) tree.update(createElement(Harness, { listId, active }));
      else tree = create(createElement(Harness, { listId, active }));
    });
  const advance = (ms: number) => act(() => void jest.advanceTimersByTime(ms));
  const gone = () => [...clocks.gone].sort();

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    act(() => tree?.unmount());
    tree = null;
    jest.useRealTimers();
  });

  test('a badge goes 10 s after its row is first in sight, not before', () => {
    render('list', true);
    act(() => clocks.seen(['eggs']));
    expect(clocks.started('eggs')).toBe(true);
    expect(clocks.started('limes')).toBe(false);
    advance(9_999);
    expect(gone()).toEqual([]);
    advance(1);
    expect(gone()).toEqual(['eggs']);
  });

  test("the clock starts on sight, not on load: a row seen later keeps its badge until 10 s after that", () => {
    render('list', true);
    act(() => clocks.seen(['eggs']));
    advance(8_000);
    act(() => clocks.seen(['limes']));
    advance(2_000);
    expect(gone()).toEqual(['eggs']);
    advance(7_999);
    expect(gone()).toEqual(['eggs']);
    advance(1);
    expect(gone()).toEqual(['eggs', 'limes']);
  });

  test('seeing a row again neither restarts its clock nor brings its badge back', () => {
    render('list', true);
    act(() => clocks.seen(['eggs']));
    advance(6_000);
    act(() => clocks.seen(['eggs']));
    advance(4_000);
    expect(gone()).toEqual(['eggs']);
    act(() => clocks.seen(['eggs']));
    advance(20_000);
    expect(gone()).toEqual(['eggs']);
  });

  test('off screen nothing starts; leaving ends the visit, and the next starts afresh', () => {
    render('list', false);
    act(() => clocks.seen(['eggs']));
    expect(clocks.started('eggs')).toBe(false);
    render('list', true);
    act(() => clocks.seen(['eggs', 'limes']));
    advance(10_000);
    expect(gone()).toEqual(['eggs', 'limes']);
    // Leaving with a clock still running drops it.
    act(() => clocks.seen(['corn']));
    render('list', false);
    expect(gone()).toEqual([]);
    advance(10_000);
    render('list', true);
    expect(gone()).toEqual([]);
    expect(clocks.started('corn')).toBe(false);
    expect(clocks.started('eggs')).toBe(false);
  });

  test('another list is another visit', () => {
    render('list', true);
    act(() => clocks.seen(['eggs']));
    advance(10_000);
    expect(gone()).toEqual(['eggs']);
    render('other', true);
    expect(gone()).toEqual([]);
  });
});
