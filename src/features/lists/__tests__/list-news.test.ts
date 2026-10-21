// NEW rows (spec 4.1): which rows have news on open, what their badge shows, when a row is in sight, and each badge's 10 s clock.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import type { Unit } from '@/shared';

import type { ItemContribution } from '../items';
import type { MemberNews } from '../last-seen';
import { inSight, mergeRowNews, newsByItem, rowBadge, useNewBadgeClocks } from '../list-news';

jest.mock('@/global.css', () => ({}));
jest.mock('@/db/client', () => require('@/test/db'));
jest.mock('@/lib/supabase', () => require('@/test/fake-supabase'));
jest.mock('@/features/auth/account', () => ({ getAccount: () => ({ userId: 'me' }) }));

const at = (min: number) => new Date(Date.UTC(2026, 9, 16, 12, 0) - min * 60_000);

describe('newsByItem', () => {
  const news = (itemId: string, contributionIds: string[], fresh: boolean, min = 1) => ({
    itemId,
    displayName: itemId,
    addedAt: at(min),
    contributionIds,
    fresh,
  });

  test('each item once, though two members added to it, with all their adds', () => {
    const members: MemberNews[] = [
      { userId: 'alex', items: [news('eggs', ['e1'], true), news('limes', ['l1'], false, 30)] },
      { userId: 'sam', items: [news('limes', ['l2'], false, 10)] },
    ];
    const byItem = newsByItem(members);
    expect([...byItem.keys()].sort()).toEqual(['eggs', 'limes']);
    expect(byItem.get('limes')).toEqual({ fresh: false, added: new Set(['l1', 'l2']) });
    expect(byItem.get('eggs')).toEqual({ fresh: true, added: new Set(['e1']) });
  });

  test('nothing new is no rows', () => {
    expect(newsByItem([]).size).toBe(0);
    expect(newsByItem([{ userId: 'alex', items: [] }]).size).toBe(0);
  });
});

describe('mergeRowNews', () => {
  test('fresh if either is; every add', () => {
    expect(mergeRowNews({ fresh: true, added: new Set(['a']) }, { fresh: false, added: new Set(['b']) })).toEqual({
      fresh: true,
      added: new Set(['a', 'b']),
    });
    expect(mergeRowNews(undefined, { fresh: false, added: new Set(['b']) })).toEqual({ fresh: false, added: new Set(['b']) });
    expect(mergeRowNews(undefined, undefined)).toBeUndefined();
  });
});

describe('rowBadge', () => {
  const c = (id: string, quantity: number | null, unit: Unit | null, over: Partial<ItemContribution> = {}): ItemContribution => ({
    id,
    quantity,
    unit,
    source: 'manual',
    recipeId: null,
    recipeName: null,
    createdAt: at(1),
    addedBy: 'alex',
    ...over,
  });
  const added = (...ids: string[]) => ({ fresh: false, added: new Set(ids) });

  test('a fresh item is NEW', () => {
    expect(rowBadge({ fresh: true, added: new Set(['a']) }, [c('a', 1, 'box')], null)).toEqual({ kind: 'new' });
  });

  test("what others added to an item that was there, as one amount", () => {
    const pads = [c('old', 1, 'box'), c('new', 1, 'box')];
    expect(rowBadge(added('new'), pads, null)).toEqual({ kind: 'added', amount: '1 box' });
    // 8 oz onto 2 lb reads as it was added.
    expect(rowBadge(added('oz'), [c('lb', 2, 'lb'), c('oz', 8, 'oz')], null)).toEqual({ kind: 'added', amount: '8 oz' });
    // Two adds since: summed.
    expect(rowBadge(added('a', 'b'), [c('x', 1, 'lb'), c('a', 1, 'lb'), c('b', 1, 'lb')], null)).toEqual({ kind: 'added', amount: '2 lb' });
  });

  test('an add with no amount is one of the usual unit, or a plain one', () => {
    const milk = [c('old', 1, 'gal'), c('new', null, null)];
    expect(rowBadge(added('new'), milk, 'gal')).toEqual({ kind: 'added', amount: '1 gal' });
    expect(rowBadge(added('new'), milk, null)).toEqual({ kind: 'added', amount: '1' });
  });

  test("adds that aren't one amount: tint the amount instead", () => {
    expect(rowBadge(added('a', 'b'), [c('x', 3, 'cup'), c('a', 1, 'cup'), c('b', 1, 'tsp')], null)).toEqual({
      kind: 'added',
      amount: '',
    });
  });

  test('a recipe link with no quantity, or none of the adds on this row, shows nothing', () => {
    const link = c('link', null, null, { source: 'recipe', recipeId: 'tacos', recipeName: 'Tacos' });
    expect(rowBadge(added('link'), [c('old', 1, 'box'), link], null)).toBeNull();
    expect(rowBadge(added('elsewhere'), [c('old', 1, 'box')], null)).toBeNull();
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
