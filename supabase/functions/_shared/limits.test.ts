import { assertEquals } from '@std/assert';

import { limitReachedResponse, monthlyResetsAt } from './limits.ts';

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
