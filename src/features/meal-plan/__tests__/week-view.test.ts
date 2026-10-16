import { afterEach, describe, expect, jest, test } from '@jest/globals';

import { i18n } from '@/i18n';

import {
  addSlotLabel,
  dayName,
  dayOfMonth,
  earlierDays,
  earlierLabel,
  entryText,
  isPastDay,
  mealLabel,
  resolvePlanHousehold,
  slotAccessibilityLabel,
  weekAccessibilityLabel,
} from '../week-view';

jest.mock('@/global.css', () => ({}));

afterEach(() => {
  i18n.changeLanguage('en');
});

const recipe = { kind: 'recipe' as const, recipeName: 'Chicken tacos', note: null };

describe('labels', () => {
  test('day names and the day of the month', () => {
    expect(dayName('2026-10-15', 'long')).toBe('Thursday');
    expect(dayName('2026-10-15', 'short')).toBe('Thu');
    expect(dayName('2026-10-15', 'long', 'es')).toBe('jueves');
    expect(dayOfMonth('2026-10-05')).toBe('5');
    expect(dayOfMonth('2026-10-15')).toBe('15');
  });

  test('the week for VoiceOver, from whichever day names it', () => {
    expect(weekAccessibilityLabel('2026-10-11')).toBe('Week of October 11');
    expect(weekAccessibilityLabel('2026-10-15')).toBe('Week of October 11');
    expect(weekAccessibilityLabel('2027-01-01')).toBe('Week of December 27');
    i18n.changeLanguage('es');
    expect(weekAccessibilityLabel('2026-10-11', 'es')).toBe('Semana del 11 de octubre');
  });

  test('what a slot shows for each kind', () => {
    expect(entryText(recipe)).toBe('Chicken tacos');
    expect(entryText({ kind: 'leftovers', recipeName: null, note: null })).toBe('Leftovers');
    expect(entryText({ kind: 'eating-out', recipeName: null, note: null })).toBe('Eating out');
    expect(entryText({ kind: 'note', recipeName: null, note: 'Pizza night' })).toBe('Pizza night');
    i18n.changeLanguage('es');
    expect(entryText({ kind: 'leftovers', recipeName: null, note: null })).toBe('Sobras');
  });

  test('a slot for VoiceOver, filled and empty, in English and Spanish', () => {
    expect(slotAccessibilityLabel('2026-10-15', 'dinner', recipe)).toBe('Thursday dinner, Chicken tacos');
    expect(slotAccessibilityLabel('2026-10-15', 'lunch', null)).toBe('Thursday lunch, empty');
    i18n.changeLanguage('es');
    expect(slotAccessibilityLabel('2026-10-15', 'dinner', recipe)).toBe('cena del jueves, Chicken tacos');
    expect(slotAccessibilityLabel('2026-10-15', 'lunch', null)).toBe('almuerzo del jueves, vacío');
  });

  test('meal names and "+ Add lunch"', () => {
    expect(mealLabel('breakfast')).toBe('Breakfast');
    expect(addSlotLabel('lunch')).toBe('+ Add lunch');
    i18n.changeLanguage('es');
    expect(addSlotLabel('dinner')).toBe('+ Agregar cena');
  });
});

describe('past days', () => {
  test('only days before today', () => {
    expect(isPastDay('2026-10-14', '2026-10-15')).toBe(true);
    expect(isPastDay('2026-10-15', '2026-10-15')).toBe(false);
    expect(isPastDay('2026-10-16', '2026-10-15')).toBe(false);
    expect(isPastDay('2025-12-31', '2026-01-01')).toBe(true);
  });
});

describe('the Earlier this week row', () => {
  test('the days before today in its week', () => {
    expect(earlierDays('2026-10-11', '2026-10-15')).toEqual(['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14']);
    expect(earlierDays('2026-10-11', '2026-10-17')).toHaveLength(6);
    expect(earlierDays('2026-10-11', '2026-10-12')).toEqual(['2026-10-11']);
  });

  test('none on Sunday', () => {
    expect(earlierDays('2026-10-11', '2026-10-11')).toEqual([]);
  });

  test('none in other weeks, past or future', () => {
    expect(earlierDays('2026-10-04', '2026-10-15')).toEqual([]);
    expect(earlierDays('2026-10-18', '2026-10-15')).toEqual([]);
  });

  test('a week across a month', () => {
    expect(earlierDays('2026-11-01', '2026-11-03')).toEqual(['2026-11-01', '2026-11-02']);
    expect(earlierDays('2026-10-25', '2026-10-27')).toEqual(['2026-10-25', '2026-10-26']);
  });

  test('"Sun – Wed", or one day alone', () => {
    expect(earlierLabel(['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14'])).toBe('Earlier this week · Sun – Wed');
    expect(earlierLabel(['2026-10-11'])).toBe('Earlier this week · Sun');
  });
});

describe('resolvePlanHousehold', () => {
  const households = [{ id: 'cabin' }, { id: 'home' }];

  test('the household picked on this device', () => {
    expect(resolvePlanHousehold(households, 'cabin', 'home')).toBe('cabin');
  });

  test("else the current list's", () => {
    expect(resolvePlanHousehold(households, null, 'home')).toBe('home');
    // A picked household the user left.
    expect(resolvePlanHousehold(households, 'gone', 'home')).toBe('home');
  });

  test('else the first', () => {
    expect(resolvePlanHousehold(households, null, null)).toBe('cabin');
    expect(resolvePlanHousehold(households, 'gone', 'also-gone')).toBe('cabin');
  });

  test('none without households', () => {
    expect(resolvePlanHousehold([], 'cabin', 'home')).toBeNull();
  });
});
