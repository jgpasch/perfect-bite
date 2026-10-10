import { describe, expect, it } from '@jest/globals';

import { compareHlc, formatHlc, MAX_COUNTER, parseHlc, receiveHlc, tickHlc } from '../hlc';

const D = 'device-a';

describe('formatHlc / parseHlc', () => {
  it('formats with fixed widths', () => {
    expect(formatHlc({ wall: 1760000000000, counter: 0, device: D })).toBe('1760000000000-0000-device-a');
    expect(formatHlc({ wall: 5, counter: 255, device: 'x' })).toBe('0000000000005-00ff-x');
    expect(formatHlc({ wall: 1760000000000, counter: MAX_COUNTER, device: D })).toBe('1760000000000-ffff-device-a');
  });

  it('round-trips', () => {
    const hlc = { wall: 1760000000123, counter: 42, device: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' };
    expect(parseHlc(formatHlc(hlc))).toEqual(hlc);
  });

  it('rejects malformed text', () => {
    expect(parseHlc('')).toBeNull();
    expect(parseHlc('176000000000-0000-a')).toBeNull(); // 12 digits
    expect(parseHlc('1760000000000-00FF-a')).toBeNull(); // upper-case hex
    expect(parseHlc('1760000000000-0000-')).toBeNull();
    expect(parseHlc('1760000000000-0000-a b')).toBeNull();
    expect(parseHlc(`1760000000000-0000-${'a'.repeat(65)}`)).toBeNull();
  });

  it('refuses to format out-of-range parts', () => {
    expect(() => formatHlc({ wall: -1, counter: 0, device: D })).toThrow('wall clock');
    expect(() => formatHlc({ wall: 1e13, counter: 0, device: D })).toThrow('wall clock');
    expect(() => formatHlc({ wall: 1, counter: MAX_COUNTER + 1, device: D })).toThrow('counter');
    expect(() => formatHlc({ wall: 1, counter: 0, device: 'a.b' })).toThrow('device id');
  });
});

describe('compareHlc', () => {
  it('orders by time, then counter, then device', () => {
    expect(compareHlc('1760000000000-0000-b', '1760000000001-0000-a')).toBeLessThan(0);
    expect(compareHlc('1760000000000-0002-a', '1760000000000-0001-z')).toBeGreaterThan(0);
    expect(compareHlc('1760000000000-0001-a', '1760000000000-0001-b')).toBeLessThan(0);
    expect(compareHlc('1760000000000-0001-a', '1760000000000-0001-a')).toBe(0);
    // Hex counters sort right as text: 0x00ff < 0x0100.
    expect(compareHlc('1760000000000-00ff-a', '1760000000000-0100-a')).toBeLessThan(0);
  });
});

describe('tickHlc', () => {
  it('starts at the wall clock with counter 0', () => {
    expect(tickHlc(null, 1000, D)).toEqual({ wall: 1000, counter: 0, device: D });
  });

  it('counts up within one millisecond', () => {
    const a = tickHlc(null, 1000, D);
    const b = tickHlc(a, 1000, D);
    expect(b).toEqual({ wall: 1000, counter: 1, device: D });
  });

  it('resets the counter when the wall clock moves on', () => {
    expect(tickHlc({ wall: 1000, counter: 7, device: D }, 1001, D)).toEqual({ wall: 1001, counter: 0, device: D });
  });

  it('stays monotonic when the wall clock goes backwards', () => {
    const next = tickHlc({ wall: 5000, counter: 3, device: D }, 1000, D);
    expect(next).toEqual({ wall: 5000, counter: 4, device: D });
    expect(compareHlc(formatHlc(next), formatHlc({ wall: 5000, counter: 3, device: D }))).toBeGreaterThan(0);
  });

  it('carries a full counter into the next millisecond', () => {
    expect(tickHlc({ wall: 1000, counter: MAX_COUNTER, device: D }, 1000, D)).toEqual({ wall: 1001, counter: 0, device: D });
  });

  it('floors fractional wall times', () => {
    expect(tickHlc(null, 1000.9, D).wall).toBe(1000);
  });

  it('is strictly increasing over many ticks', () => {
    let last = tickHlc(null, 1000, D);
    for (let i = 0; i < 500; i++) {
      const next = tickHlc(last, 1000 - (i % 3), D);
      expect(compareHlc(formatHlc(next), formatHlc(last))).toBeGreaterThan(0);
      last = next;
    }
  });
});

describe('receiveHlc', () => {
  it('adopts a larger remote clock as its own', () => {
    const local = { wall: 1000, counter: 0, device: D };
    const remote = { wall: 9000, counter: 5, device: 'other' };
    expect(receiveHlc(local, remote, D)).toEqual({ wall: 9000, counter: 5, device: D });
  });

  it('keeps its own clock when the remote one is older', () => {
    const local = { wall: 9000, counter: 2, device: D };
    expect(receiveHlc(local, { wall: 1000, counter: 9, device: 'other' }, D)).toEqual(local);
  });

  it('compares counters within the same millisecond', () => {
    const local = { wall: 9000, counter: 2, device: D };
    expect(receiveHlc(local, { wall: 9000, counter: 3, device: 'other' }, D)).toEqual({ wall: 9000, counter: 3, device: D });
  });

  it('adopts the remote clock when there is no local one', () => {
    expect(receiveHlc(null, { wall: 9000, counter: 1, device: 'other' }, D)).toEqual({ wall: 9000, counter: 1, device: D });
  });

  it('makes the next local tick newer than the remote clock, even with a slow wall clock', () => {
    const remote = { wall: 9000, counter: 5, device: 'zzz' };
    const next = tickHlc(receiveHlc({ wall: 1000, counter: 0, device: D }, remote, D), 1000, D);
    expect(compareHlc(formatHlc(next), formatHlc(remote))).toBeGreaterThan(0);
  });
});
