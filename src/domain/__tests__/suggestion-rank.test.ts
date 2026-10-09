import { describe, expect, it } from '@jest/globals';

import { frecency, rankHistory, type HistoryRow } from '../suggestion-rank';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date(Date.UTC(2026, 9, 9));
const daysAgo = (d: number) => new Date(now.getTime() - d * DAY);

const usage = (displayName: string, useCount: number, ageDays: number, extra: Partial<HistoryRow> = {}): HistoryRow => ({
  ingredientName: displayName.toLowerCase(),
  displayName,
  useCount,
  lastUsedAt: daysAgo(ageDays),
  hiddenAt: null,
  ...extra,
});

const names = (rows: HistoryRow[]) => rows.map((r) => r.displayName);

describe('frecency', () => {
  it('halves every 30 days', () => {
    expect(frecency(usage('milk', 4, 0), now)).toBe(4);
    expect(frecency(usage('milk', 4, 30), now)).toBe(2);
    expect(frecency(usage('milk', 4, 60), now)).toBe(1);
    expect(frecency(usage('milk', 1, 15), now)).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it('treats a future time as now', () => {
    expect(frecency(usage('milk', 3, -10), now)).toBe(3);
  });

  it('is 0 for a count of 0', () => {
    expect(frecency(usage('milk', 0, 1), now)).toBe(0);
  });
});

describe('rankHistory', () => {
  it('ranks a frequent old item above a once-used recent one', () => {
    // 5 uses 30 days ago scores 2.5; 1 use yesterday scores ~0.98.
    const rows = [usage('chicken breasts', 1, 1), usage('chicken thighs', 5, 30)];
    expect(names(rankHistory(rows, 'chi', now))).toEqual(['chicken thighs', 'chicken breasts']);
  });

  it('lets recency win once the old uses have decayed enough', () => {
    // 5 uses 120 days ago scores 0.3125; 1 use today scores 1.
    const rows = [usage('chicken thighs', 5, 120), usage('chicken breasts', 1, 0)];
    expect(names(rankHistory(rows, 'chi', now))).toEqual(['chicken breasts', 'chicken thighs']);
  });

  it('matches a later word in the name', () => {
    const rows = [usage('chicken thighs', 2, 0), usage('milk', 3, 0)];
    expect(names(rankHistory(rows, 'thighs', now))).toEqual(['chicken thighs']);
    expect(names(rankHistory(rows, 'thi', now))).toEqual(['chicken thighs']);
  });

  it('does not match the middle of a word', () => {
    expect(rankHistory([usage('chicken thighs', 2, 0)], 'hick', now)).toEqual([]);
  });

  it('puts a prefix match ahead of a word match at equal score', () => {
    const rows = [usage('green onion', 2, 3), usage('onion', 2, 3)];
    expect(names(rankHistory(rows, 'on', now))).toEqual(['onion', 'green onion']);
    // The prefix match wins even when it is the longer name.
    const longer = [usage('red onion', 1, 0), usage('onion rings', 1, 0)];
    expect(names(rankHistory(longer, 'onion', now))).toEqual(['onion rings', 'red onion']);
  });

  it('lets a higher-scoring word match beat a prefix match', () => {
    const rows = [usage('onion', 1, 0), usage('green onion', 3, 0)];
    expect(names(rankHistory(rows, 'on', now))).toEqual(['green onion', 'onion']);
  });

  it('breaks ties by shorter name, then alphabetically', () => {
    const rows = [usage('milks', 1, 0), usage('milk b', 1, 0), usage('milk a', 1, 0), usage('milk', 1, 0)];
    expect(names(rankHistory(rows, 'mil', now))).toEqual(['milk', 'milks', 'milk a', 'milk b']);
  });

  it('matches the key when the display name does not', () => {
    const row = usage('Tomatoes', 1, 0, { ingredientName: 'tomato' });
    const other = usage('Roma tomatoes', 1, 0, { ingredientName: 'roma tomato' });
    expect(rankHistory([row, other], 'tomato', now)).toEqual([row, other]);
    // `tomatoes` matches the display names only.
    expect(rankHistory([row, other], 'tomatoes', now)).toEqual([row, other]);
  });

  it('ignores case and surrounding whitespace in the query and names', () => {
    const rows = [usage('Chicken Thighs', 1, 0, { ingredientName: 'chicken thigh' })];
    expect(names(rankHistory(rows, '  CHI ', now))).toEqual(['Chicken Thighs']);
    expect(names(rankHistory(rows, 'Thi', now))).toEqual(['Chicken Thighs']);
  });

  it('drops hidden rows', () => {
    const rows = [usage('chicken salad', 9, 0, { hiddenAt: daysAgo(1) }), usage('chicken thighs', 1, 0)];
    expect(names(rankHistory(rows, 'chi', now))).toEqual(['chicken thighs']);
  });

  it('returns [] for an empty or blank query', () => {
    const rows = [usage('milk', 1, 0)];
    expect(rankHistory(rows, '', now)).toEqual([]);
    expect(rankHistory(rows, '   ', now)).toEqual([]);
  });

  it('returns [] when nothing matches or there is no history', () => {
    expect(rankHistory([usage('milk', 1, 0)], 'egg', now)).toEqual([]);
    expect(rankHistory([], 'egg', now)).toEqual([]);
  });

  it('returns the original rows without mutating the input', () => {
    const rows = [usage('chicken breasts', 1, 1), usage('chicken thighs', 5, 30)];
    const before = [...rows];
    const ranked = rankHistory(rows, 'chi', now);
    expect(ranked[0]).toBe(rows[1]);
    expect(rows).toEqual(before);
  });
});
