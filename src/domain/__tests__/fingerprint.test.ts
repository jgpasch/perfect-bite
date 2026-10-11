import { describe, expect, it } from '@jest/globals';

import { fingerprint } from '../fingerprint';

describe('fingerprint', () => {
  it('is stable for the same value', () => {
    expect(fingerprint({ produce: { count: ['apples'] } })).toBe(fingerprint({ produce: { count: ['apples'] } }));
  });

  it('is an unsigned 32-bit integer', () => {
    const value = fingerprint(['milk', 'eggs']);
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(2 ** 32);
  });

  it('changes when a name moves to another category or unit, keeping the length', () => {
    const a = { produce: { count: ['kale'] }, deli: { count: ['olives'] } };
    const b = { produce: { count: ['olives'] }, deli: { count: ['kale'] } };
    expect(JSON.stringify(a).length).toBe(JSON.stringify(b).length);
    expect(fingerprint(a)).not.toBe(fingerprint(b));
    expect(fingerprint({ dairy: { lb: ['milk'] } })).not.toBe(fingerprint({ dairy: { qt: ['milk'] } }));
  });
});
