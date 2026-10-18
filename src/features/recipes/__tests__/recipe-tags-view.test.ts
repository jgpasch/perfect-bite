import { describe, expect, test } from '@jest/globals';

import { i18n } from '@/i18n';
import { emptyRecipeTags, type RecipeTags } from '@/shared/recipe-tags';

import {
  applySuggestedTags,
  facetAtMax,
  facetLimitLabel,
  parseTotalTime,
  recipeTagLine,
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

  test('saved pills come first, in the en and es labels', async () => {
    const t = tags({ meal: ['dinner'], saved: ['want-to-try', 'favorite'] });
    expect(recipeTagPills(t, null).map((p) => p.accessibilityLabel)).toEqual([
      'Saved: Favorite',
      'Saved: Want to try',
      'Meal: Dinner',
    ]);
    await i18n.changeLanguage('es');
    try {
      expect(recipeTagPills(t, null).map((p) => p.value)).toEqual(['Favorita', 'Por probar', 'Cena']);
    } finally {
      await i18n.changeLanguage('en');
    }
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

describe('recipeTagLine', () => {
  test('values only, in pill order, joined with " · "; VoiceOver reads them all', () => {
    expect(recipeTagLine(tags({ protein: ['chicken'], meal: ['dinner', 'lunch'], cuisine: ['american'] }), 50)).toEqual({
      favorite: false,
      text: 'Lunch · Dinner · American · Chicken · Under 1 hour',
      accessibilityLabel: 'Tags: Lunch, Dinner, American, Chicken, Under 1 hour',
    });
  });

  test('Favorite becomes the heart, and is still read', () => {
    expect(recipeTagLine(tags({ saved: ['want-to-try', 'favorite'], meal: ['dinner'] }), null)).toEqual({
      favorite: true,
      text: 'Want to try · Dinner',
      accessibilityLabel: 'Tags: Favorite, Want to try, Dinner',
    });
  });

  test('Favorite alone: the heart with no text', () => {
    expect(recipeTagLine(tags({ saved: ['favorite'] }), null)).toEqual({ favorite: true, text: '', accessibilityLabel: 'Tags: Favorite' });
  });

  test('a time alone', () => {
    expect(recipeTagLine(null, 20)).toEqual({ favorite: false, text: 'Under 30 min', accessibilityLabel: 'Tags: Under 30 min' });
  });

  test('many tags: every value, in order', () => {
    const line = recipeTagLine(
      tags({ meal: ['lunch', 'dinner'], cuisine: ['italian', 'french'], protein: ['chicken', 'beef', 'pork'], diet: ['vegan'], method: ['grill', 'one-pot'] }),
      300,
    )!;
    expect(line.text).toBe('Lunch · Dinner · Italian · French · Chicken · Beef · Pork · Vegan · One pot · Grill · Over 1 hour');
    expect(line.accessibilityLabel.split(', ')).toHaveLength(11);
  });

  test('nothing to show: null, so the row offers Add tags', () => {
    expect(recipeTagLine(null, null)).toBeNull();
    expect(recipeTagLine(emptyRecipeTags(), null)).toBeNull();
    expect(recipeTagLine(tags({ meal: ['brunch'] }), null)).toBeNull();
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

  test('ignores saved tags', () => {
    const saved = tags({ saved: ['favorite', 'want-to-try'] });
    expect(showImportTagsNote({ tags: saved, tagsEdited: false, totalMinutes: null })).toBe(false);
    expect(showImportTagsNote({ tags: { ...saved, meal: ['dinner'] }, tagsEdited: false, totalMinutes: null })).toBe(true);
    expect(showImportTagsNote({ tags: saved, tagsEdited: false, totalMinutes: 20 })).toBe(true);
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

describe('applySuggestedTags', () => {
  test('the suggestion replaces every facet’s known picks, emptying the ones it left out', () => {
    const current = tags({ meal: ['lunch'], cuisine: ['thai'], diet: ['vegan'], method: ['grill'] });
    expect(applySuggestedTags(current, tags({ meal: ['dinner'], protein: ['beef', 'chicken'] }))).toEqual({
      saved: [],
      meal: ['dinner'],
      cuisine: [],
      protein: ['chicken', 'beef'],
      diet: [],
      method: [],
    });
  });

  test('keeps the current picks’ unknown slugs after the suggested values', () => {
    const current = tags({ meal: ['brunch', 'lunch'], method: ['sous-vide'] });
    expect(applySuggestedTags(current, tags({ meal: ['dinner'], cuisine: ['mexican'] }))).toEqual({
      saved: [],
      meal: ['dinner', 'brunch'],
      cuisine: ['mexican'],
      protein: [],
      diet: [],
      method: ['sous-vide'],
    });
  });

  test('drops suggested slugs it doesn’t know and caps each facet at its maximum', () => {
    const suggested = tags({ meal: ['dinner', 'lunch', 'snack', 'feast'], protein: ['beef', 'pork', 'fish', 'chicken'] });
    const out = applySuggestedTags(emptyRecipeTags(), suggested)!;
    expect(out.meal).toEqual(['lunch', 'dinner']);
    expect(out.protein).toEqual(['chicken', 'beef', 'pork']);
  });

  test('a suggestion with no known value is null, so the picks stay', () => {
    expect(applySuggestedTags(tags({ meal: ['dinner'] }), emptyRecipeTags())).toBeNull();
    expect(applySuggestedTags(tags({ meal: ['dinner'] }), tags({ meal: ['feast'] }))).toBeNull();
  });

  test('keeps saved as picked, unknown slugs too', () => {
    const current = tags({ saved: ['want-to-try', 'loved', 'favorite'], meal: ['lunch'], cuisine: ['thai'] });
    expect(applySuggestedTags(current, tags({ meal: ['dinner'] }))).toEqual({
      ...emptyRecipeTags(),
      saved: ['want-to-try', 'loved', 'favorite'],
      meal: ['dinner'],
    });
    expect(applySuggestedTags(tags({}), tags({ meal: ['dinner'] }))!.saved).toEqual([]);
  });

  test('never takes saved from the suggestion', () => {
    const suggested = { ...tags({ meal: ['dinner'] }), saved: ['favorite'] };
    expect(applySuggestedTags(tags({ saved: ['want-to-try'] }), suggested)!.saved).toEqual(['want-to-try']);
    expect(applySuggestedTags(emptyRecipeTags(), suggested)!.saved).toEqual([]);
    // Only saved in a suggestion is nothing suggested.
    expect(applySuggestedTags(emptyRecipeTags(), tags({ saved: ['favorite'] }))).toBeNull();
  });

  test('doesn’t change the tags it was given', () => {
    const current = tags({ meal: ['lunch'] });
    applySuggestedTags(current, tags({ meal: ['dinner'] }));
    expect(current).toEqual(tags({ meal: ['lunch'] }));
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
