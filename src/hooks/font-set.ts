// The device's font set for the font trial (DESIGN.md Fonts), held in memory so `useTheme()` can read it
// without the database. Settings saves it (`design.fontSet`) and the root layout loads it at startup.
import { useSyncExternalStore } from 'react';

import { FONT_SETS, type FontSet } from '@/constants/theme';

/** A saved font set, or `bricolage` (today's) for anything unknown. */
export function readFontSet(value: unknown): FontSet {
  return FONT_SETS.find((set) => set === value) ?? 'bricolage';
}

let current: FontSet = 'bricolage';
const listeners = new Set<() => void>();

export function getFontSet(): FontSet {
  return current;
}

/** Switches every screen to `set` at once (it isn't saved; see `setFontSetSetting`). */
export function applyFontSet(set: FontSet): void {
  if (set === current) return;
  current = set;
  for (const listener of [...listeners]) listener();
}

export function subscribeFontSet(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The font set in use, re-rendering when it's switched. */
export function useFontSet(): FontSet {
  return useSyncExternalStore(subscribeFontSet, getFontSet);
}
