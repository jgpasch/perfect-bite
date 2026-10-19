import { afterEach, describe, expect, test } from '@jest/globals';

import { initI18n } from '@/i18n';

import { limitResetsAt, resetDate } from '../limits';

afterEach(() => initI18n('en'));

describe('limitResetsAt', () => {
  test("keeps the server's resets_at", () => {
    expect(limitResetsAt('2026-11-01T00:00:00.000Z', Date.parse('2026-10-18T12:00:00Z'))).toBe('2026-11-01T00:00:00.000Z');
  });

  test('without one (an older server), the first instant of next month, UTC', () => {
    expect(limitResetsAt(undefined, Date.parse('2026-10-18T12:00:00Z'))).toBe('2026-11-01T00:00:00.000Z');
    expect(limitResetsAt(null, Date.parse('2026-10-01T00:00:00Z'))).toBe('2026-11-01T00:00:00.000Z');
    expect(limitResetsAt('', Date.parse('2026-10-31T23:59:59Z'))).toBe('2026-11-01T00:00:00.000Z');
  });

  test('December rolls into January', () => {
    expect(limitResetsAt(undefined, Date.parse('2026-12-20T08:00:00Z'))).toBe('2027-01-01T00:00:00.000Z');
  });

  test('the month is UTC: 1 Nov 00:30 UTC is already November', () => {
    expect(limitResetsAt(undefined, Date.parse('2026-11-01T00:30:00Z'))).toBe('2026-12-01T00:00:00.000Z');
  });

  test('an unreadable resets_at is replaced', () => {
    expect(limitResetsAt('soon', Date.parse('2026-10-18T12:00:00Z'))).toBe('2026-11-01T00:00:00.000Z');
  });
});

describe('resetDate', () => {
  test('a short date: "Nov 1"', () => {
    expect(resetDate('2026-11-01T00:00:00.000Z')).toBe('Nov 1');
    expect(resetDate('2027-01-01T00:00:00.000Z')).toBe('Jan 1');
  });

  test('read in UTC, so it is the 1st wherever the device is', () => {
    // Midnight UTC on the 1st is still the 31st west of Greenwich; the reset is still "Nov 1".
    expect(resetDate('2026-11-01T00:00:00.000Z')).toBe('Nov 1');
  });

  test('in Spanish: "1 nov"', () => {
    initI18n('es');
    expect(resetDate('2026-11-01T00:00:00.000Z')).toBe('1 nov');
  });
});
