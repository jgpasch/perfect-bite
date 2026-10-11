import { describe, expect, it, test } from '@jest/globals';

import {
  frecency,
  rankHistory,
  rankRecipes,
  type HistoryRow,
  type RecipeRow,
  type RecipeUse,
} from '../suggestion-rank';

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

const HOME = 'home';
const recipe = (name: string, ageDays: number, extra: Partial<RecipeRow> = {}): RecipeRow => ({
  id: name.toLowerCase().replace(/\s+/g, '-'),
  name,
  householdId: HOME,
  ingredientCount: 8,
  updatedAt: daysAgo(ageDays),
  ...extra,
});
const use = (recipeId: string, ageDays: number): RecipeUse => ({ recipeId, at: daysAgo(ageDays) });
const recipeNames = (rows: RecipeRow[]) => rows.map((r) => r.name);

describe('rankRecipes (spec 4.2)', () => {
  test('matches a whole-name prefix or the start of a later word, case-insensitively', () => {
    const rows = [recipe('Tacos', 1), recipe('Fish tacos', 2), recipe('Potato salad', 3), recipe('Dal', 4)];
    expect(recipeNames(rankRecipes(rows, [], HOME, 'TA', 5))).toEqual(['Tacos', 'Fish tacos']);
    // Not a word start: "ta" inside "potato" doesn't match.
    expect(recipeNames(rankRecipes(rows, [], HOME, 'ato', 5))).toEqual([]);
    expect(recipeNames(rankRecipes(rows, [], HOME, '  fish   ta ', 5))).toEqual(['Fish tacos']);
  });

  test('only this household, and only recipes with something to add', () => {
    const rows = [
      recipe('Tacos', 1, { householdId: 'lake' }),
      recipe('Tahini sauce', 2, { ingredientCount: 0 }),
      recipe('Tagine', 3),
    ];
    expect(recipeNames(rankRecipes(rows, [], HOME, 'ta', 5))).toEqual(['Tagine']);
    expect(recipeNames(rankRecipes(rows, [], 'lake', 'ta', 5))).toEqual(['Tacos']);
    expect(rankRecipes(rows, [], 'nowhere', 'ta', 5)).toEqual([]);
  });

  test('a query under 2 characters, or blank, matches nothing', () => {
    const rows = [recipe('Tacos', 1)];
    expect(rankRecipes(rows, [], HOME, 't', 5)).toEqual([]);
    expect(rankRecipes(rows, [], HOME, '   ', 5)).toEqual([]);
    expect(rankRecipes(rows, [], HOME, ' t ', 5)).toEqual([]);
  });

  test('most recently used first: the later of its last change and its last add to a list', () => {
    const rows = [recipe('Tacos', 10), recipe('Tagine', 5), recipe('Tamales', 20)];
    expect(recipeNames(rankRecipes(rows, [], HOME, 'ta', 5))).toEqual(['Tagine', 'Tacos', 'Tamales']);
    // Tamales was added to a list yesterday, Tacos 7 days ago (still after its last change).
    const uses = [use('tamales', 30), use('tamales', 1), use('tacos', 7)];
    expect(recipeNames(rankRecipes(rows, uses, HOME, 'ta', 5))).toEqual(['Tamales', 'Tagine', 'Tacos']);
    // An add older than the last change doesn't move it.
    expect(recipeNames(rankRecipes(rows, [use('tamales', 40)], HOME, 'ta', 5))).toEqual(['Tagine', 'Tacos', 'Tamales']);
  });

  test('ties: prefix before word, then shorter name, then alphabetical', () => {
    const rows = [recipe('Fish tacos', 1), recipe('Tacos al pastor', 1), recipe('Tacos', 1), recipe('Tabbouleh', 1)];
    expect(recipeNames(rankRecipes(rows, [], HOME, 'ta', 5))).toEqual(['Tacos', 'Tabbouleh', 'Tacos al pastor', 'Fish tacos']);
  });

  test('capped at the limit; zero or negative gives none', () => {
    const rows = [recipe('Tacos', 1), recipe('Tagine', 2), recipe('Tamales', 3)];
    expect(recipeNames(rankRecipes(rows, [], HOME, 'ta', 2))).toEqual(['Tacos', 'Tagine']);
    expect(rankRecipes(rows, [], HOME, 'ta', 0)).toEqual([]);
    expect(rankRecipes(rows, [], HOME, 'ta', -1)).toEqual([]);
  });

  test('works on the rows it was given: item history never enters, so recipes take no item slots', () => {
    const rows = [recipe('Tacos', 1)];
    const before = structuredClone(rows);
    const ranked = rankRecipes(rows, [], HOME, 'ta', 5);
    expect(ranked[0]).toBe(rows[0]);
    expect(rows).toEqual(before);
    // History ranking is unaffected by recipes with the same name.
    expect(names(rankHistory([usage('taco shells', 2, 0)], 'ta', now))).toEqual(['taco shells']);
  });
});
