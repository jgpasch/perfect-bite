// This device's HLC clock (spec 7.1), kept in device settings.
import { beforeEach, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, deviceSettings } from '@/db';
import { resetDb } from '@/test/db';

import { getDeviceId, nextHlc, observeHlc } from '../clock';
import { compareHlc, parseHlc } from '../hlc';

jest.mock('@/db/client', () => require('@/test/db'));

const NOW = 1_790_000_000_000;

beforeEach(() => {
  resetDb();
});

const stored = () => db.select().from(deviceSettings).where(eq(deviceSettings.key, 'sync.clock')).get()?.value;

test('getDeviceId makes an id on first use, stores it with no HLC yet, and keeps it', () => {
  expect(stored()).toBeUndefined();
  const device = getDeviceId();
  expect(device).toMatch(/^[0-9a-f-]{36}$/);
  expect(stored()).toEqual({ device, last: null });
  expect(getDeviceId()).toBe(device);
  expect(getDeviceId()).toBe(device);
});

test('getDeviceId after the clock has ticked keeps the id and the last HLC', () => {
  const hlc = nextHlc(db, NOW);
  const device = parseHlc(hlc)!.device;
  expect(getDeviceId()).toBe(device);
  expect(stored()).toEqual({ device, last: hlc });
});

test('nextHlc stores each HLC, so the clock survives a restart (it reads settings, not memory)', () => {
  const first = nextHlc(db, NOW);
  expect(stored()).toMatchObject({ last: first });
  const device = parseHlc(first)!.device;
  expect(first).toBe(`${NOW}-0000-${device}`);

  // The wall clock went backwards: still later than the last one.
  const second = nextHlc(db, NOW - 60_000);
  expect(second).toBe(`${NOW}-0001-${device}`);
  expect(stored()).toEqual({ device, last: second });

  const third = nextHlc(db, NOW + 5);
  expect(third).toBe(`${NOW + 5}-0000-${device}`);
});

test('a clock row written by an earlier launch is picked up as is', () => {
  db.insert(deviceSettings)
    .values({ key: 'sync.clock', value: { device: 'dev-a', last: `${NOW}-0004-dev-a` } })
    .run();
  expect(getDeviceId()).toBe('dev-a');
  expect(nextHlc(db, NOW)).toBe(`${NOW}-0005-dev-a`);
});

test('observeHlc adopts a later remote HLC under this device id, so the next one is later still', () => {
  const device = getDeviceId();
  observeHlc(`${NOW}-0003-other`);
  expect(stored()).toEqual({ device, last: `${NOW}-0003-${device}` });
  const next = nextHlc(db, NOW - 1);
  expect(next).toBe(`${NOW}-0004-${device}`);
  expect(compareHlc(next, `${NOW}-0003-other`)).toBeGreaterThan(0);
});

test('observeHlc keeps the clock when the remote HLC is older', () => {
  const device = getDeviceId();
  const mine = nextHlc(db, NOW);
  observeHlc(`${NOW - 1}-0009-other`);
  expect(stored()).toEqual({ device, last: mine });
});

test('observeHlc ignores a malformed HLC and writes nothing', () => {
  observeHlc('garbage');
  observeHlc('');
  expect(stored()).toBeUndefined();
});

test('observeHlc rolls back with the transaction it ran in', () => {
  const device = getDeviceId();
  const before = nextHlc(db, NOW);
  expect(() =>
    db.transaction((tx) => {
      observeHlc(`${NOW + 1_000_000}-0009-other`, tx);
      expect((tx.select().from(deviceSettings).where(eq(deviceSettings.key, 'sync.clock')).get()!.value as { last: string }).last).toBe(
        `${NOW + 1_000_000}-0009-${device}`,
      );
      throw new Error('pull page failed');
    }),
  ).toThrow('pull page failed');

  expect(stored()).toEqual({ device, last: before });
  expect(nextHlc(db, NOW)).toBe(`${NOW}-0001-${device}`);
});

test('nextHlc rolls back with its transaction too', () => {
  const first = nextHlc(db, NOW);
  expect(() =>
    db.transaction((tx) => {
      nextHlc(tx, NOW);
      throw new Error('write failed');
    }),
  ).toThrow('write failed');
  expect(stored()).toMatchObject({ last: first });
});

test('a first-use device id made inside a rolled-back transaction is not kept', () => {
  let inside = '';
  expect(() =>
    db.transaction((tx) => {
      inside = getDeviceId(tx);
      throw new Error('rolled back');
    }),
  ).toThrow('rolled back');
  expect(stored()).toBeUndefined();
  const device = getDeviceId();
  expect(device).not.toBe(inside);
  expect(getDeviceId()).toBe(device);
});
