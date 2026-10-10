// This device's hybrid logical clock (spec 7.1), kept in device settings so it stays monotonic
// across launches. Reads and writes go through the caller's transaction, so a write that rolls back
// takes its clock tick with it.
import { eq } from 'drizzle-orm';

import { db, deviceSettings } from '@/db';
import { newId } from '@/lib/id';

import { formatHlc, parseHlc, receiveHlc, tickHlc, type Hlc } from './hlc';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Exec = typeof db | Tx;

const CLOCK_KEY = 'sync.clock';

type StoredClock = { device: string; last: string | null };

function readClock(exec: Exec): StoredClock {
  const row = exec.select().from(deviceSettings).where(eq(deviceSettings.key, CLOCK_KEY)).get();
  const stored = row?.value as StoredClock | undefined;
  return stored ?? { device: newId(), last: null };
}

function writeClock(exec: Exec, value: StoredClock): void {
  exec
    .insert(deviceSettings)
    .values({ key: CLOCK_KEY, value })
    .onConflictDoUpdate({ target: deviceSettings.key, set: { value } })
    .run();
}

const parsed = (text: string | null): Hlc | null => (text ? parseHlc(text) : null);

/** This device's id, the last part of its HLCs. Made on first use. */
export function getDeviceId(exec: Exec = db): string {
  const clock = readClock(exec);
  if (clock.last === null) writeClock(exec, clock);
  return clock.device;
}

/** A new HLC for a local write, newer than every HLC this device has made or seen. */
export function nextHlc(exec: Exec = db, now = Date.now()): string {
  const clock = readClock(exec);
  const hlc = formatHlc(tickHlc(parsed(clock.last), now, clock.device));
  writeClock(exec, { device: clock.device, last: hlc });
  return hlc;
}

/** Adopts a remote HLC (from a pull) if it is later than this device's clock. Ignores malformed ones. */
export function observeHlc(remote: string, exec: Exec = db): void {
  const theirs = parseHlc(remote);
  if (!theirs) return;
  const clock = readClock(exec);
  const next = formatHlc(receiveHlc(parsed(clock.last), theirs, clock.device));
  if (next !== clock.last) writeClock(exec, { device: clock.device, last: next });
}
