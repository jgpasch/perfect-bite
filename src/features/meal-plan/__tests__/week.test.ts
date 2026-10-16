import { afterAll, describe, expect, test } from '@jest/globals';

import { initI18n } from '@/i18n';

import { addDays, nextWeek, previousWeek, today, weekDays, weekLabel, weekStart } from '../week';

afterAll(() => initI18n('en'));

describe('weekStart', () => {
  test('is the Sunday on or before the day', () => {
    expect(weekStart('2026-10-11')).toBe('2026-10-11'); // a Sunday
    expect(weekStart('2026-10-15')).toBe('2026-10-11'); // Thursday
    expect(weekStart('2026-10-17')).toBe('2026-10-11'); // Saturday
    expect(weekStart('2026-10-18')).toBe('2026-10-18');
  });

  test('crosses months and years', () => {
    expect(weekStart('2026-11-03')).toBe('2026-11-01');
    expect(weekStart('2029-11-02')).toBe('2029-10-28');
    expect(weekStart('2027-01-01')).toBe('2026-12-27');
    expect(weekStart('2028-03-01')).toBe('2028-02-27'); // after a leap day
  });

  test('refuses text that is not a day', () => {
    expect(() => weekStart('2026-02-30')).toThrow('Not a day: 2026-02-30');
    expect(() => weekStart('15/10/2026')).toThrow('Not a day');
    expect(() => weekStart('')).toThrow('Not a day');
  });
});

describe('weekDays', () => {
  test('seven days, Sunday to Saturday, from any day of the week', () => {
    const week = ['2026-10-11', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17'];
    expect(weekDays('2026-10-11')).toEqual(week);
    expect(weekDays('2026-10-15')).toEqual(week);
  });

  test('across a month and a year', () => {
    expect(weekDays('2029-10-28')).toEqual([
      '2029-10-28',
      '2029-10-29',
      '2029-10-30',
      '2029-10-31',
      '2029-11-01',
      '2029-11-02',
      '2029-11-03',
    ]);
    expect(weekDays('2026-12-27')).toEqual([
      '2026-12-27',
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-01',
      '2027-01-02',
    ]);
    expect(weekDays('2028-02-27')).toContain('2028-02-29');
  });

  test('across a DST change: seven distinct days, no day skipped or repeated', () => {
    // In the US, DST ends on Sunday 2026-11-01 and starts on Sunday 2026-03-08.
    expect(weekDays('2026-11-04')).toEqual([
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
    ]);
    expect(weekDays('2026-03-08')).toEqual([
      '2026-03-08',
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
      '2026-03-13',
      '2026-03-14',
    ]);
    expect(weekDays('2026-03-07')[6]).toBe('2026-03-07');
  });
});

describe('previousWeek and nextWeek', () => {
  test('move by seven days from the week start', () => {
    expect(previousWeek('2026-10-15')).toBe('2026-10-04');
    expect(nextWeek('2026-10-15')).toBe('2026-10-18');
    expect(nextWeek('2026-10-25')).toBe('2026-11-01'); // into the DST change
    expect(previousWeek('2026-11-01')).toBe('2026-10-25');
    expect(nextWeek('2026-12-27')).toBe('2027-01-03');
    expect(previousWeek('2027-01-03')).toBe('2026-12-27');
  });

  test('go back and forward without limit', () => {
    let week = '2026-10-11';
    for (let i = 0; i < 520; i++) week = nextWeek(week);
    expect(week).toBe(addDays('2026-10-11', 520 * 7));
    for (let i = 0; i < 520; i++) week = previousWeek(week);
    expect(week).toBe('2026-10-11');
  });
});

describe('addDays', () => {
  test('moves by days across months, years and leap days', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2026-10-15', 0)).toBe('2026-10-15');
  });
});

// Jest gives each test file its own `process.env`, so these use local times (`new Date(y, m, d, h)`)
// and hold in whatever zone the tests run in.
describe('today', () => {
  test('is the local calendar day, from just after midnight to just before the next', () => {
    expect(today(new Date(2026, 9, 15, 0, 0, 1))).toBe('2026-10-15');
    expect(today(new Date(2026, 9, 15, 23, 59, 59))).toBe('2026-10-15');
    expect(today(new Date(2026, 9, 16, 0, 0, 0))).toBe('2026-10-16');
    expect(today(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
    expect(today(new Date(2027, 0, 1, 0, 1))).toBe('2027-01-01');
    expect(today(new Date(2026, 0, 5, 9))).toBe('2026-01-05'); // pads month and day
  });

  test('every hour of the US and EU DST change days stays on that day', () => {
    for (const [year, month, day] of [
      [2026, 2, 8], // US spring forward
      [2026, 10, 1], // US fall back
      [2026, 2, 29], // EU spring forward
      [2026, 9, 25], // EU fall back
    ]) {
      const expected = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      for (let hour = 0; hour < 24; hour++) {
        expect(today(new Date(year, month, day, hour, 30))).toBe(expected);
      }
      expect(today(new Date(year, month, day - 1, 23, 59))).toBe(addDays(expected, -1));
      expect(today(new Date(year, month, day + 1, 0, 1))).toBe(addDays(expected, 1));
    }
  });

  test("today's week starts on its Sunday across the DST change", () => {
    expect(weekStart(today(new Date(2026, 10, 1, 1, 30)))).toBe('2026-11-01');
    expect(weekStart(today(new Date(2026, 10, 7, 23, 30)))).toBe('2026-11-01');
    expect(weekStart(today(new Date(2026, 2, 14, 23, 30)))).toBe('2026-03-08');
  });
});

describe('weekLabel', () => {
  test('one month: the month once', () => {
    expect(weekLabel('2026-10-11', 'en')).toBe('Oct 11 – 17');
    expect(weekLabel('2026-10-15', 'en')).toBe('Oct 11 – 17');
  });

  test('two months, and two years: both months', () => {
    expect(weekLabel('2029-10-28', 'en')).toBe('Oct 28 – Nov 3');
    expect(weekLabel('2026-12-27', 'en')).toBe('Dec 27 – Jan 2');
  });

  test('a DST week labels its seven days', () => {
    expect(weekLabel('2026-11-01', 'en')).toBe('Nov 1 – 7');
  });

  test('in Spanish, the month where Spanish puts it', () => {
    expect(weekLabel('2026-10-11', 'es')).toBe('11 – 17 oct');
    expect(weekLabel('2029-10-28', 'es')).toBe('28 oct – 3 nov');
  });

  test("defaults to the app's language", () => {
    initI18n('es');
    expect(weekLabel('2026-10-11')).toBe('11 – 17 oct');
    initI18n('en');
    expect(weekLabel('2026-10-11')).toBe('Oct 11 – 17');
  });
});
