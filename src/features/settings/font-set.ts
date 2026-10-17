import type { FontSet } from '@/constants/theme';
import { applyFontSet, readFontSet } from '@/hooks/font-set';

import { getDeviceSetting, setDeviceSetting } from './device-settings';

/** Settings > Design trials > Fonts (DESIGN.md Fonts): the font set on this device. */
export const FONT_SET_KEY = 'design.fontSet';

/** The saved font set, `bricolage` unless another was picked on this device. */
export function getFontSetSetting(): FontSet {
  return readFontSet(getDeviceSetting<unknown>(FONT_SET_KEY, null));
}

/** Saves the set and switches every screen to it at once. */
export function setFontSetSetting(set: FontSet): void {
  setDeviceSetting(FONT_SET_KEY, set);
  applyFontSet(set);
}

/**
 * Puts the saved set in use at startup. The root layout calls it before the database's migrations have
 * run, so on a first launch (no settings table yet) it stays `bricolage`.
 */
export function loadFontSet(): void {
  try {
    applyFontSet(getFontSetSetting());
  } catch {
    applyFontSet('bricolage');
  }
}
