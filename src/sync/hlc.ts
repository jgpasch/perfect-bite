// Hybrid logical clock (spec 7.1). Pure: the device's clock state lives in `clock.ts`.
//
// Wire format: '<wall clock ms, 13 digits>-<counter, 4 hex digits>-<device id>', e.g.
// '1760000000000-0000-3f9a…'. The fixed widths make plain text comparison order HLCs by time,
// then counter, then device, which is how `apply_mutations` compares them.

export type Hlc = {
  /** Wall clock, ms since the epoch. */
  wall: number;
  /** Orders events within one `wall` millisecond. */
  counter: number;
  /** Device id: letters, digits, `_` or `-`, up to 64. */
  device: string;
};

export const MAX_COUNTER = 0xffff;
const MAX_WALL = 9_999_999_999_999;
const PATTERN = /^(\d{13})-([0-9a-f]{4})-([0-9A-Za-z_-]{1,64})$/;
const DEVICE = /^[0-9A-Za-z_-]{1,64}$/;

export function isValidDeviceId(device: string): boolean {
  return DEVICE.test(device);
}

export function formatHlc({ wall, counter, device }: Hlc): string {
  if (!Number.isInteger(wall) || wall < 0 || wall > MAX_WALL) throw new Error(`Invalid HLC wall clock ${wall}`);
  if (!Number.isInteger(counter) || counter < 0 || counter > MAX_COUNTER) throw new Error(`Invalid HLC counter ${counter}`);
  if (!isValidDeviceId(device)) throw new Error(`Invalid HLC device id ${device}`);
  return `${String(wall).padStart(13, '0')}-${counter.toString(16).padStart(4, '0')}-${device}`;
}

/** The HLC in `text`, or null if it isn't one. */
export function parseHlc(text: string): Hlc | null {
  const match = PATTERN.exec(text);
  if (!match) return null;
  return { wall: Number(match[1]), counter: parseInt(match[2], 16), device: match[3] };
}

/** Negative, zero or positive as `a` is older than, the same as, or newer than `b`. */
export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Orders by wall then counter, ignoring the device. */
function compareTime(a: Hlc, b: Hlc): number {
  return a.wall - b.wall || a.counter - b.counter;
}

/**
 * The clock for a new local event at wall time `now`: later than `last` (the device's previous
 * event or the largest remote clock it adopted), even if the wall clock went backwards. A full
 * counter carries into the next millisecond.
 */
export function tickHlc(last: Hlc | null, now: number, device: string): Hlc {
  const wall = Math.max(last?.wall ?? 0, Math.floor(now));
  const counter = last && wall === last.wall ? last.counter + 1 : 0;
  if (counter > MAX_COUNTER) return { wall: wall + 1, counter: 0, device };
  return { wall, counter, device };
}

/**
 * The device's clock after seeing `remote` (from the server): the later of the two, kept as this
 * device's. The next `tickHlc` is then newer than `remote`, so a local edit made after seeing a
 * remote one always wins over it.
 */
export function receiveHlc(local: Hlc | null, remote: Hlc, device: string): Hlc {
  const later = local && compareTime(local, remote) >= 0 ? local : remote;
  return { wall: later.wall, counter: later.counter, device };
}
