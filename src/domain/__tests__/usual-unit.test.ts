import { describe, expect, it } from '@jest/globals';

import { UNITS } from '@/shared';

import { unitFromKey, unitKey, usualUnit, usualUnitsByKey, withDefaultUnit, type UnitUsageRow } from '../usual-unit';

const t = (day: number) => new Date(Date.UTC(2026, 9, day));
const row = (unitKey: string, useCount: number, day = 1): UnitUsageRow => ({
  unitKey,
  useCount,
  lastUsedAt: t(day),
});

describe('unitKey / unitFromKey', () => {
  it('stores a unit as itself and no unit as count', () => {
    expect(unitKey('lb')).toBe('lb');
    expect(unitKey('fl oz')).toBe('fl oz');
    expect(unitKey(null)).toBe('count');
  });

  it('reads count back as null and a unit as itself', () => {
    expect(unitFromKey('count')).toBeNull();
    expect(unitFromKey('gal')).toBe('gal');
  });

  it('round-trips every unit', () => {
    for (const unit of [...UNITS, null]) expect(unitFromKey(unitKey(unit))).toBe(unit);
  });

  it('returns undefined for keys it does not know', () => {
    expect(unitFromKey('furlong')).toBeUndefined();
    expect(unitFromKey('')).toBeUndefined();
    expect(unitFromKey('LB')).toBeUndefined();
    expect(unitFromKey('lbs')).toBeUndefined();
  });
});

describe('usualUnit', () => {
  it('returns undefined when nothing is known', () => {
    expect(usualUnit([])).toBeUndefined();
    expect(usualUnit([row('lb', 0), row('count', 0)])).toBeUndefined();
    expect(usualUnit([row('furlong', 5)])).toBeUndefined();
  });

  it('returns the only unit', () => {
    expect(usualUnit([row('gal', 1)])).toBe('gal');
  });

  it('returns null when count is the usual unit', () => {
    expect(usualUnit([row('count', 3), row('lb', 1)])).toBeNull();
  });

  it('picks the highest count, ignoring recency', () => {
    expect(usualUnit([row('oz', 1, 30), row('lb', 4, 1), row('g', 2, 20)])).toBe('lb');
  });

  it('breaks a count tie by the latest use', () => {
    expect(usualUnit([row('lb', 2, 3), row('oz', 2, 9), row('g', 1, 20)])).toBe('oz');
    expect(usualUnit([row('oz', 2, 9), row('lb', 2, 3)])).toBe('oz');
  });

  it('breaks a full tie alphabetically', () => {
    expect(usualUnit([row('lb', 2, 5), row('can', 2, 5), row('oz', 2, 5)])).toBe('can');
    expect(usualUnit([row('lb', 1, 5), row('count', 1, 5)])).toBeNull();
  });

  it('ignores unknown keys, even with the highest count', () => {
    expect(usualUnit([row('furlong', 9, 30), row('kg', 1)])).toBe('kg');
  });

  it('ignores rows with a zero count', () => {
    expect(usualUnit([row('lb', 0, 30), row('oz', 1, 1)])).toBe('oz');
  });

  it('does not depend on input order and does not mutate it', () => {
    const rows = [row('cup', 3, 2), row('tbsp', 3, 4), row('tsp', 1, 9)];
    const copy = rows.map((r) => ({ ...r }));
    expect(usualUnit(rows)).toBe('tbsp');
    expect(usualUnit([...rows].reverse())).toBe('tbsp');
    expect(rows).toEqual(copy);
  });
});

describe('usualUnitsByKey', () => {
  const keyed = (ingredientName: string, unitKey: string, useCount: number, day = 1) => ({
    ingredientName,
    ...row(unitKey, useCount, day),
  });

  it('picks the usual unit for each ingredient key on its own', () => {
    const map = usualUnitsByKey([
      keyed('milk', 'gal', 3),
      keyed('chicken thigh', 'lb', 1, 1),
      keyed('milk', 'count', 1),
      keyed('chicken thigh', 'kg', 1, 5),
      keyed('egg', 'dozen', 2),
      keyed('egg', 'count', 2, 3),
      keyed('avocado', 'count', 4),
    ]);
    expect([...map.entries()].sort(([a], [b]) => a.localeCompare(b))).toEqual([
      ['avocado', null],
      ['chicken thigh', 'kg'],
      ['egg', null],
      ['milk', 'gal'],
    ]);
  });

  it('leaves out keys with nothing known', () => {
    const map = usualUnitsByKey([keyed('milk', 'gal', 0), keyed('salt', 'handful', 3), keyed('flour', 'cup', 1)]);
    expect(map.has('milk')).toBe(false);
    expect(map.has('salt')).toBe(false);
    expect(map.get('flour')).toBe('cup');
    expect(map.size).toBe(1);
  });

  it('is empty for no rows', () => {
    expect(usualUnitsByKey([]).size).toBe(0);
  });
});

describe('withDefaultUnit', () => {
  it('uses household history over the default', () => {
    expect(withDefaultUnit('qt', 'gal')).toBe('qt');
    expect(withDefaultUnit(null, 'gal')).toBeNull();
  });

  it('falls back to the default when there is no history', () => {
    expect(withDefaultUnit(undefined, 'gal')).toBe('gal');
    expect(withDefaultUnit(undefined, 'count')).toBeNull();
  });

  it('knows nothing with no default or an unknown one', () => {
    expect(withDefaultUnit(undefined, null)).toBeUndefined();
    expect(withDefaultUnit(undefined, undefined)).toBeUndefined();
    expect(withDefaultUnit(undefined, 'furlong')).toBeUndefined();
  });
});
