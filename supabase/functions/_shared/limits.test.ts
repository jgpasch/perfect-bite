import { assertEquals } from '@std/assert';

import { dailyLimitResponse, dailyResetsAt, limitReachedResponse, monthlyResetsAt } from './limits.ts';

Deno.test('dailyResetsAt is the next UTC midnight', () => {
  assertEquals(dailyResetsAt(Date.parse('2026-10-18T22:31:00Z')), '2026-10-19T00:00:00.000Z');
  assertEquals(dailyResetsAt(Date.parse('2026-10-18T00:00:00Z')), '2026-10-19T00:00:00.000Z');
  assertEquals(dailyResetsAt(Date.parse('2026-10-18T23:59:59.999Z')), '2026-10-19T00:00:00.000Z');
});

Deno.test('dailyResetsAt rolls over months and years', () => {
  assertEquals(dailyResetsAt(Date.parse('2026-10-31T23:59:59.999Z')), '2026-11-01T00:00:00.000Z');
  assertEquals(dailyResetsAt(Date.parse('2027-02-28T12:00:00Z')), '2027-03-01T00:00:00.000Z');
  assertEquals(dailyResetsAt(Date.parse('2028-02-28T12:00:00Z')), '2028-02-29T00:00:00.000Z');
  assertEquals(dailyResetsAt(Date.parse('2026-12-31T23:59:59.999Z')), '2027-01-01T00:00:00.000Z');
});

Deno.test('dailyResetsAt goes by UTC, not the local day', () => {
  // 19 Oct 00:30 UTC is still 18 Oct in the Americas; it's the 19th's day.
  assertEquals(dailyResetsAt(Date.parse('2026-10-19T00:30:00Z')), '2026-10-20T00:00:00.000Z');
});

Deno.test('dailyLimitResponse answers 429 daily_limit with resets_at', async () => {
  const res = dailyLimitResponse('Daily limit reached', Date.parse('2026-02-10T08:00:00Z'));
  assertEquals(res.status, 429);
  assertEquals(await res.json(), {
    error: 'daily_limit',
    message: 'Daily limit reached',
    resets_at: '2026-02-11T00:00:00.000Z',
  });
});

Deno.test('monthlyResetsAt is the first instant of next month, UTC', () => {
  assertEquals(monthlyResetsAt(Date.parse('2026-10-18T22:31:00Z')), '2026-11-01T00:00:00.000Z');
  assertEquals(monthlyResetsAt(Date.parse('2026-10-01T00:00:00Z')), '2026-11-01T00:00:00.000Z');
  assertEquals(monthlyResetsAt(Date.parse('2026-10-31T23:59:59.999Z')), '2026-11-01T00:00:00.000Z');
});

Deno.test('monthlyResetsAt rolls December over into January', () => {
  assertEquals(monthlyResetsAt(Date.parse('2026-12-31T12:00:00Z')), '2027-01-01T00:00:00.000Z');
});

Deno.test('monthlyResetsAt goes by UTC, not the local day', () => {
  // 1 Nov 00:30 UTC is still 31 Oct in the Americas; it's November's limit.
  assertEquals(monthlyResetsAt(Date.parse('2026-11-01T00:30:00Z')), '2026-12-01T00:00:00.000Z');
});

Deno.test('limitReachedResponse answers 429 limit_reached with resets_at', async () => {
  const res = limitReachedResponse('Monthly limit reached', Date.parse('2026-02-10T08:00:00Z'));
  assertEquals(res.status, 429);
  assertEquals(await res.json(), {
    error: 'limit_reached',
    message: 'Monthly limit reached',
    resets_at: '2026-03-01T00:00:00.000Z',
  });
});
