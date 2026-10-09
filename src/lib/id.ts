import { getRandomBytes } from 'expo-crypto';
import { v7 } from 'uuid';

// uuid's own monotonic counter only runs when v7() gets no options, and we have to pass the
// random bytes, so keep the counter here (same scheme as uuid's updateV7State).
const state = { msecs: -Infinity, seq: 0 };

/**
 * A new row id: UUIDv7, generated on the device so rows can be created offline (spec 5).
 * Ids from this device sort in creation order, even within one millisecond.
 */
export function newId(): string {
  // Hermes has no crypto.getRandomValues; expo-crypto supplies the random bytes.
  const random = getRandomBytes(16);
  const now = Date.now();
  if (now > state.msecs) {
    state.msecs = now;
    // Start each millisecond at a random point in the lower half, leaving room to count up.
    state.seq = ((random[6] << 23) | (random[7] << 16) | (random[8] << 8) | random[9]) & 0x7fffffff;
    state.seq >>>= 1;
  } else {
    state.seq = (state.seq + 1) | 0;
    if (state.seq === 0) state.msecs++;
  }
  return v7({ random, msecs: state.msecs, seq: state.seq });
}
