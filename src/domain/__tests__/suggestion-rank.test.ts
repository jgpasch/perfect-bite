import { describe, expect, it, test } from '@jest/globals';

import {
  frecency,
  mergeSuggestions,
  rankCatalog,
  rankHistory,
  rankRecipes,
  rankUsual,
  type CatalogRow,
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

describe('rankUsual', () => {
  it('orders by frecency: 3 uses last week (about 2.5) before 10 uses 90 days ago (1.25)', () => {
    const rows = [usage('eggs', 10, 90), usage('milk', 3, 7)];
    expect(frecency(rows[0], now)).toBe(1.25);
    expect(frecency(rows[1], now)).toBeCloseTo(2.55, 2);
    expect(names(rankUsual(rows, now))).toEqual(['milk', 'eggs']);
  });

  it('at equal frecency puts the most recently used first', () => {
    // 4 uses 30 days ago and 2 uses today both score 2.
    const rows = [usage('flour', 4, 30), usage('butter', 2, 0)];
    expect(names(rankUsual(rows, now))).toEqual(['butter', 'flour']);
  });

  it('at equal frecency and recency orders by display name', () => {
    const rows = [usage('limes', 2, 1), usage('apples', 2, 1), usage('Kale', 2, 1)];
    expect(names(rankUsual(rows, now))).toEqual(['Kale', 'apples', 'limes']);
  });

  it('drops hidden rows and counts under 2', () => {
    const rows = [
      usage('milk', 2, 1),
      usage('saffron', 1, 0),
      usage('nothing', 0, 0),
      usage('eggs', 9, 0, { hiddenAt: daysAgo(0) }),
    ];
    expect(names(rankUsual(rows, now))).toEqual(['milk']);
  });

  it('returns nothing for no rows', () => {
    expect(rankUsual([], now)).toEqual([]);
  });

  it('keeps the input untouched', () => {
    const rows = [usage('eggs', 2, 9), usage('milk', 3, 0)];
    rankUsual(rows, now);
    expect(names(rows)).toEqual(['eggs', 'milk']);
  });
});

describe('rankHistory', () => {
  it('at equal length ranks a frequent old item above a once-used recent one', () => {
    // 5 uses 30 days ago scores 2.5; 1 use yesterday scores ~0.98. Both names are 14 characters.
    const rows = [usage('chicken breast', 1, 1), usage('chicken thighs', 5, 30)];
    expect(names(rankHistory(rows, 'chi', now))).toEqual(['chicken thighs', 'chicken breast']);
  });

  it('at equal length lets recency win once the old uses have decayed enough', () => {
    // 5 uses 120 days ago scores 0.3125; 1 use today scores 1.
    const rows = [usage('chicken thighs', 5, 120), usage('chicken breast', 1, 0)];
    expect(names(rankHistory(rows, 'chi', now))).toEqual(['chicken breast', 'chicken thighs']);
  });

  it('puts the typed name first, however often the others are bought', () => {
    const rows = [usage('Coffee filters', 9, 0), usage('Coffee', 1, 60)];
    expect(names(rankHistory(rows, 'coffee', now))).toEqual(['Coffee', 'Coffee filters']);
    expect(names(rankHistory(rows, ' COFFEE ', now))).toEqual(['Coffee', 'Coffee filters']);
  });

  it('counts the typed name normalized as an add, so a plural finds the singular', () => {
    const rows = [usage('Coffee filters', 9, 0), usage('Coffee', 1, 60)];
    // `coffees` isn't a prefix of either name, but it is Coffee once normalized.
    expect(names(rankHistory(rows, 'coffees', now))).toEqual(['Coffee']);
    // Accents fold too: `limon` is Limón.
    const limon = usage('Limón', 1, 0, { ingredientName: 'limon' });
    expect(rankHistory([limon], 'limon', now)).toEqual([limon]);
    expect(rankHistory([usage('Coffee', 1, 0)], 'coffeez', now)).toEqual([]);
  });

  it('puts the typed name ahead of a shorter match', () => {
    // `Tea!!` is `tea` normalized as an add; `teal` is shorter but only a prefix match.
    const rows = [usage('teal', 9, 0), usage('Tea!!', 1, 0, { ingredientName: 'tea' })];
    expect(names(rankHistory(rows, 'tea', now))).toEqual(['Tea!!', 'teal']);
  });

  it('puts shorter names first, whatever their frecency (`chi`: Chives before Chicken thighs)', () => {
    const rows = [usage('Chicken thighs', 20, 0), usage('Chives', 1, 90), usage('Chili', 1, 90)];
    expect(names(rankHistory(rows, 'chi', now))).toEqual(['Chili', 'Chives', 'Chicken thighs']);
  });

  it('matches a later word in the name', () => {
    const rows = [usage('chicken thighs', 2, 0), usage('milk', 3, 0)];
    expect(names(rankHistory(rows, 'thighs', now))).toEqual(['chicken thighs']);
    expect(names(rankHistory(rows, 'thi', now))).toEqual(['chicken thighs']);
  });

  it('does not match the middle of a word', () => {
    expect(rankHistory([usage('chicken thighs', 2, 0)], 'hick', now)).toEqual([]);
  });

  it('at equal length puts a prefix match ahead of a higher-scoring word match', () => {
    const rows = [usage('red onions', 9, 0), usage('onion soup', 1, 30)];
    expect(names(rankHistory(rows, 'onion', now))).toEqual(['onion soup', 'red onions']);
  });

  it('puts a shorter word match ahead of a longer prefix match', () => {
    const rows = [usage('onion rings', 1, 0), usage('red onion', 1, 0)];
    expect(names(rankHistory(rows, 'onion', now))).toEqual(['red onion', 'onion rings']);
    const scored = [usage('onion', 1, 0), usage('green onion', 3, 0)];
    expect(names(rankHistory(scored, 'on', now))).toEqual(['onion', 'green onion']);
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

describe('mergeSuggestions', () => {
  const s = (displayName: string, key = displayName.toLowerCase()) => ({ key, displayName });
  const shown = (out: { displayName: string; source: string }[]) => out.map((r) => `${r.displayName} (${r.source})`);

  it('puts the typed name first, from either source', () => {
    expect(shown(mergeSuggestions([s('Coffee filters')], [s('Coffee')], 'coffee', 5))).toEqual([
      'Coffee (catalog)',
      'Coffee filters (history)',
    ]);
    // A plural typed name counts.
    expect(shown(mergeSuggestions([s('Coffee filters')], [s('Coffee')], 'coffees', 5))).toEqual(['Coffee (catalog)']);
  });

  it('puts shorter names first across sources', () => {
    const out = mergeSuggestions([s('Chicken thighs'), s('Chicken breasts')], [s('Chives'), s('Chili')], 'chi', 5);
    expect(shown(out)).toEqual([
      'Chili (catalog)',
      'Chives (catalog)',
      'Chicken thighs (history)',
      'Chicken breasts (history)',
    ]);
  });

  it('at equal length puts a prefix match before a word match, whatever the source', () => {
    expect(shown(mergeSuggestions([s('red onions')], [s('onion soup')], 'onion', 5))).toEqual([
      'onion soup (catalog)',
      'red onions (history)',
    ]);
  });

  it('at equal length and match keeps history in its frecency order, ahead of the catalog', () => {
    // History arrives in rankHistory's order (frecency), which isn't alphabetical.
    const out = mergeSuggestions([s('milk b'), s('milk a')], [s('milk c'), s('milk 0')], 'mil', 5);
    expect(shown(out)).toEqual(['milk b (history)', 'milk a (history)', 'milk 0 (catalog)', 'milk c (catalog)']);
  });

  it('dedupes by key, keeping the history row', () => {
    const out = mergeSuggestions([s('Chickpeas', 'chickpea')], [s('chickpeas', 'chickpea'), s('chicken')], 'chick', 5);
    expect(out).toEqual([
      { key: 'chicken', displayName: 'chicken', source: 'catalog' },
      { key: 'chickpea', displayName: 'Chickpeas', source: 'history' },
    ]);
  });

  it('applies the limit after ordering', () => {
    const out = mergeSuggestions([s('cheese sticks'), s('cheddar')], [s('cheese'), s('chervil')], 'che', 2);
    expect(shown(out)).toEqual(['cheese (catalog)', 'cheddar (history)']);
    expect(mergeSuggestions([s('cheese')], [], 'che', 0)).toEqual([]);
  });

  it('drops rows that do not match and returns [] for a blank query', () => {
    expect(shown(mergeSuggestions([s('milk')], [s('pistachio')], 'chi', 5))).toEqual([]);
    expect(mergeSuggestions([s('milk')], [s('mint')], '  ', 5)).toEqual([]);
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

  test('a whole-name prefix match before a word match, however recently used', () => {
    const rows = [recipe('Fish tacos', 0), recipe('Tacos', 30)];
    expect(recipeNames(rankRecipes(rows, [use('fish tacos', 0)], HOME, 'ta', 5))).toEqual(['Tacos', 'Fish tacos']);
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

describe('rankCatalog (spec 4.2, 4.15)', () => {
  const entry = (displayName: string, lang: string | null): CatalogRow => ({ key: displayName, displayName, lang });
  const rows = [
    entry('milk', 'en'),
    entry('leche', 'es'),
    entry('leche de soya', 'es'),
    entry('dulce de leche', 'en'),
    entry('lemon', 'en'),
    entry('lechuga', 'es'),
    entry('lecithin', null),
  ];
  const shown = (q: string, language: string, limit = 10) => rankCatalog(rows, q, language, limit).map((r) => r.displayName);

  it("puts names in the app's language first, then prefix before word matches, shorter, then A–Z", () => {
    expect(shown('le', 'es')).toEqual(['leche', 'lechuga', 'leche de soya', 'lemon', 'lecithin', 'dulce de leche']);
    expect(shown('le', 'en')).toEqual(['lemon', 'dulce de leche', 'leche', 'lechuga', 'lecithin', 'leche de soya']);
  });

  it("treats an unknown language (null) as not the app's, and with no name in the app's language ranks as before", () => {
    expect(shown('lec', 'en')).toEqual(['dulce de leche', 'leche', 'lechuga', 'lecithin', 'leche de soya']);
    expect(shown('lec', 'fr')).toEqual(['leche', 'lechuga', 'lecithin', 'leche de soya', 'dulce de leche']);
  });

  it('matches a query of several words after any space, case-insensitively', () => {
    expect(shown('DE LECHE', 'es')).toEqual(['dulce de leche']);
    expect(shown('  de soya ', 'en')).toEqual(['leche de soya']);
    expect(shown('ilk', 'en')).toEqual([]);
  });

  it('caps at the limit, and an empty query or a zero limit gives nothing', () => {
    expect(shown('le', 'es', 2)).toEqual(['leche', 'lechuga']);
    expect(shown('le', 'es', 0)).toEqual([]);
    expect(shown('   ', 'es')).toEqual([]);
    expect(rankCatalog([], 'le', 'es', 5)).toEqual([]);
  });
});
