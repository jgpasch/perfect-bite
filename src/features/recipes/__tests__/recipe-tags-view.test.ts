import { describe, expect, test } from '@jest/globals';

import { emptyRecipeTags, type RecipeTags } from '@/shared/recipe-tags';

import {
  facetAtMax,
  facetLimitLabel,
  parseTotalTime,
  recipeTagPills,
  showImportTagsNote,
  splitTotalMinutes,
  toggleTag,
} from '../recipe-tags-view';

const tags = (partial: Partial<RecipeTags>): RecipeTags => ({ ...emptyRecipeTags(), ...partial });

describe('recipeTagPills', () => {
  test('facets in display order, values in each facet’s order, then the time bucket', () => {
    const pills = recipeTagPills(
      tags({ method: ['one-pot'], protein: ['beef', 'chicken'], meal: ['dinner', 'lunch'], cuisine: ['mexican'] }),
      25,
    );
    expect(pills.map((p) => p.accessibilityLabel)).toEqual([
      'Meal: Lunch',
      'Meal: Dinner',
      'Cuisine: Mexican',
      'Protein: Chicken',
      'Protein: Beef',
      'Method: One pot',
      'Time: Under 30 min',
    ]);
    expect(pills[0]).toEqual({ key: 'meal:lunch', facet: 'Meal', value: 'Lunch', accessibilityLabel: 'Meal: Lunch' });
    expect(pills.at(-1)).toEqual({ key: 'time:under-30', facet: 'Time', value: 'Under 30 min', accessibilityLabel: 'Time: Under 30 min' });
  });

  test('the time pill follows the buckets', () => {
    expect(recipeTagPills(null, 30).map((p) => p.value)).toEqual(['Under 1 hour']);
    expect(recipeTagPills(null, 60).map((p) => p.value)).toEqual(['Under 1 hour']);
    expect(recipeTagPills(null, 61).map((p) => p.value)).toEqual(['Over 1 hour']);
    expect(recipeTagPills(null, 29).map((p) => p.value)).toEqual(['Under 30 min']);
  });

  test('untagged with no time has no pills; empty facets have none either', () => {
    expect(recipeTagPills(null, null)).toEqual([]);
    expect(recipeTagPills(emptyRecipeTags(), null)).toEqual([]);
  });

  test('slugs the app doesn’t know aren’t shown', () => {
    expect(recipeTagPills(tags({ meal: ['brunch', 'dinner'], diet: ['keto'] }), null).map((p) => p.key)).toEqual(['meal:dinner']);
  });
});

describe('showImportTagsNote', () => {
  test('shows for unedited import tags', () => {
    expect(showImportTagsNote({ tags: tags({ meal: ['dinner'] }), tagsEdited: false, totalMinutes: null })).toBe(true);
    expect(showImportTagsNote({ tags: emptyRecipeTags(), tagsEdited: false, totalMinutes: 40 })).toBe(true);
  });

  test('hidden once a person edits them, for untagged recipes, and when the import found nothing', () => {
    expect(showImportTagsNote({ tags: tags({ meal: ['dinner'] }), tagsEdited: true, totalMinutes: null })).toBe(false);
    expect(showImportTagsNote({ tags: null, tagsEdited: false, totalMinutes: null })).toBe(false);
    expect(showImportTagsNote({ tags: emptyRecipeTags(), tagsEdited: false, totalMinutes: null })).toBe(false);
    expect(showImportTagsNote({ tags: tags({ meal: ['brunch'] }), tagsEdited: false, totalMinutes: null })).toBe(false);
  });
});

describe('toggleTag and facetAtMax', () => {
  test('adds and removes a value', () => {
    const on = toggleTag(emptyRecipeTags(), 'meal', 'dinner');
    expect(on.meal).toEqual(['dinner']);
    expect(toggleTag(on, 'meal', 'dinner').meal).toEqual([]);
  });

  test('a facet at its maximum refuses another value but still lets one go', () => {
    const full = tags({ meal: ['dinner', 'lunch'] });
    expect(facetAtMax(full, 'meal')).toBe(true);
    expect(toggleTag(full, 'meal', 'snack')).toBe(full);
    expect(toggleTag(full, 'meal', 'lunch').meal).toEqual(['dinner']);
    expect(facetAtMax(toggleTag(full, 'meal', 'lunch'), 'meal')).toBe(false);
  });

  test('protein allows 3, the others 2', () => {
    let t = emptyRecipeTags();
    for (const slug of ['chicken', 'beef', 'pork']) t = toggleTag(t, 'protein', slug);
    expect(t.protein).toEqual(['chicken', 'beef', 'pork']);
    expect(facetAtMax(t, 'protein')).toBe(true);
    expect(toggleTag(t, 'protein', 'fish').protein).toEqual(['chicken', 'beef', 'pork']);
    expect(facetAtMax(tags({ diet: ['vegan'] }), 'diet')).toBe(false);
    expect(facetAtMax(tags({ diet: ['vegan', 'vegetarian'] }), 'diet')).toBe(true);
  });

  test('unknown slugs are kept and don’t count against the maximum', () => {
    const t = tags({ meal: ['brunch', 'dinner'] });
    expect(facetAtMax(t, 'meal')).toBe(false);
    const added = toggleTag(t, 'meal', 'lunch');
    expect(added.meal).toEqual(['brunch', 'dinner', 'lunch']);
    expect(toggleTag(added, 'meal', 'dinner').meal).toEqual(['brunch', 'lunch']);
  });

  test('doesn’t change the tags it was given or other facets', () => {
    const t = tags({ cuisine: ['thai'] });
    const next = toggleTag(t, 'meal', 'dinner');
    expect(t.meal).toEqual([]);
    expect(next.cuisine).toEqual(['thai']);
  });

  test('facetLimitLabel', () => {
    expect(facetLimitLabel(2)).toBe('Pick up to 2');
    expect(facetLimitLabel(3)).toBe('Pick up to 3');
  });
});

describe('the total time fields', () => {
  test('splitTotalMinutes', () => {
    expect(splitTotalMinutes(null)).toEqual({ hours: '', minutes: '' });
    expect(splitTotalMinutes(80)).toEqual({ hours: '1', minutes: '20' });
    expect(splitTotalMinutes(45)).toEqual({ hours: '', minutes: '45' });
    expect(splitTotalMinutes(120)).toEqual({ hours: '2', minutes: '0' });
    expect(splitTotalMinutes(2880)).toEqual({ hours: '48', minutes: '0' });
  });

  test('parseTotalTime reads hours and minutes', () => {
    expect(parseTotalTime('1', '20')).toEqual({ ok: true, totalMinutes: 80 });
    expect(parseTotalTime('', '45')).toEqual({ ok: true, totalMinutes: 45 });
    expect(parseTotalTime('2', '')).toEqual({ ok: true, totalMinutes: 120 });
    expect(parseTotalTime(' 1 ', ' 5 ')).toEqual({ ok: true, totalMinutes: 65 });
    expect(parseTotalTime('', '90')).toEqual({ ok: true, totalMinutes: 90 });
    expect(parseTotalTime('48', '0')).toEqual({ ok: true, totalMinutes: 2880 });
  });

  test('empty or zero is no time', () => {
    expect(parseTotalTime('', '')).toEqual({ ok: true, totalMinutes: null });
    expect(parseTotalTime('  ', ' ')).toEqual({ ok: true, totalMinutes: null });
    expect(parseTotalTime('0', '0')).toEqual({ ok: true, totalMinutes: null });
  });

  test('refuses non-whole numbers and over 48 hours', () => {
    expect(parseTotalTime('1.5', '')).toEqual({ ok: false, error: 'Use whole numbers' });
    expect(parseTotalTime('', '-5')).toEqual({ ok: false, error: 'Use whole numbers' });
    expect(parseTotalTime('a', '')).toEqual({ ok: false, error: 'Use whole numbers' });
    expect(parseTotalTime('48', '1')).toEqual({ ok: false, error: 'Up to 48 hours' });
    expect(parseTotalTime('', '2881')).toEqual({ ok: false, error: 'Up to 48 hours' });
  });
});
