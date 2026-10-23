// Spec 4.3.3: the aisle order a list uses, from one source, with missing aisles appended.
import { describe, expect, it } from '@jest/globals';

import { resolveAisleOrder, type OrderedAisle } from '../aisle-order';

const system = (id: string, defaultRank: number | null): OrderedAisle => ({ id, householdId: null, defaultRank, createdAt: null });
const custom = (id: string, createdAt: number | null, householdId = 'h1'): OrderedAisle => ({
  id,
  householdId,
  defaultRank: null,
  createdAt: createdAt === null ? null : new Date(createdAt),
});

const PRODUCE = system('produce', 0);
const BAKERY = system('bakery', 1);
const DAIRY = system('dairy', 2);
const FROZEN = system('frozen', 3);
const COSTCO = custom('costco', 1000);
const MARKET = custom('market', 2000);
const ALL = [FROZEN, MARKET, DAIRY, PRODUCE, COSTCO, BAKERY];

const ids = (result: { categories: OrderedAisle[] }) => result.categories.map((c) => c.id);

describe('resolveAisleOrder', () => {
  it('with no orders, is the default: system aisles by rank, then custom ones by created_at', () => {
    const result = resolveAisleOrder({ personal: null, household: null, categories: ALL });
    expect(result.source).toBe('default');
    expect(ids(result)).toEqual(['produce', 'bakery', 'dairy', 'frozen', 'costco', 'market']);
  });

  it('uses the household order when the viewer has none', () => {
    const result = resolveAisleOrder({
      personal: null,
      household: ['market', 'frozen', 'dairy', 'bakery', 'produce', 'costco'],
      categories: ALL,
    });
    expect(result.source).toBe('household');
    expect(ids(result)).toEqual(['market', 'frozen', 'dairy', 'bakery', 'produce', 'costco']);
  });

  it("uses the viewer's own order over the household's, whole: nothing is taken from the household order", () => {
    const result = resolveAisleOrder({
      personal: ['dairy', 'produce'],
      household: ['frozen', 'market', 'bakery', 'costco', 'dairy', 'produce'],
      categories: ALL,
    });
    expect(result.source).toBe('personal');
    // Missing ones follow the default, not the household's positions.
    expect(ids(result)).toEqual(['dairy', 'produce', 'bakery', 'frozen', 'costco', 'market']);
  });

  it('an empty saved order is still that source, with everything appended by default', () => {
    expect(resolveAisleOrder({ personal: [], household: ['frozen'], categories: ALL })).toEqual({
      source: 'personal',
      categories: [PRODUCE, BAKERY, DAIRY, FROZEN, COSTCO, MARKET],
    });
    expect(resolveAisleOrder({ personal: null, household: [], categories: ALL }).source).toBe('household');
  });

  it('appends missing system aisles by default rank before missing custom aisles', () => {
    const result = resolveAisleOrder({ personal: null, household: ['market', 'dairy'], categories: ALL });
    expect(ids(result)).toEqual(['market', 'dairy', 'produce', 'bakery', 'frozen', 'costco']);
  });

  it('appends missing custom aisles by created_at, then id', () => {
    const late = custom('a-late', 5000);
    const twinB = custom('twin-b', 3000);
    const twinA = custom('twin-a', 3000);
    const result = resolveAisleOrder({
      personal: null,
      household: ['produce', 'bakery', 'dairy', 'frozen'],
      categories: [late, twinB, MARKET, twinA, COSTCO, PRODUCE, BAKERY, DAIRY, FROZEN],
    });
    expect(ids(result)).toEqual(['produce', 'bakery', 'dairy', 'frozen', 'costco', 'market', 'twin-a', 'twin-b', 'a-late']);
  });

  it('puts custom aisles with no created_at first among the missing ones, by id', () => {
    const result = resolveAisleOrder({
      personal: null,
      household: null,
      categories: [COSTCO, custom('old-b', null), custom('old-a', null)],
    });
    expect(ids(result)).toEqual(['old-a', 'old-b', 'costco']);
  });

  it('a system aisle without a rank goes after the ranked ones, by id', () => {
    const result = resolveAisleOrder({ personal: null, household: null, categories: [system('z', null), system('y', null), DAIRY] });
    expect(ids(result)).toEqual(['dairy', 'y', 'z']);
  });

  it("skips ids that are gone or another household's, and repeats", () => {
    // `elsewhere` is another household's custom aisle: not among this household's categories.
    const result = resolveAisleOrder({
      personal: ['gone', 'dairy', 'elsewhere', 'produce', 'dairy'],
      household: null,
      categories: [PRODUCE, DAIRY, BAKERY],
    });
    expect(ids(result)).toEqual(['dairy', 'produce', 'bakery']);
  });

  it('keeps every field of the categories it is given', () => {
    const named = { ...PRODUCE, name: 'Produce', slug: 'produce' };
    expect(resolveAisleOrder({ personal: null, household: null, categories: [named] }).categories[0]).toBe(named);
  });

  it('with no categories, is empty', () => {
    expect(resolveAisleOrder({ personal: ['dairy'], household: null, categories: [] })).toEqual({ categories: [], source: 'personal' });
  });
});
