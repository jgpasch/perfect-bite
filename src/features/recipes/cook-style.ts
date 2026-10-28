// Settings > Design trials > Cook view (spec 4.5): how the cook screen lays out its steps on this device.
import { useSyncExternalStore } from 'react';

import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';

export const COOK_VIEW_STYLE_KEY = 'cook.viewStyle';

/**
 * `cards`: board 5A of the cook screen canvas, every unticked step a `surface` card on the ground. `sheet`: board 5B,
 * the whole page `surface`, steps between hairlines under big numerals.
 */
export const COOK_VIEW_STYLES = ['cards', 'sheet'] as const;
export type CookViewStyle = (typeof COOK_VIEW_STYLES)[number];

/** A saved value as a style: `cards` for anything else, never-set included. */
export function readCookViewStyle(value: unknown): CookViewStyle {
  return COOK_VIEW_STYLES.find((style) => style === value) ?? 'cards';
}

const listeners = new Set<() => void>();

export function getCookViewStyle(): CookViewStyle {
  return readCookViewStyle(getDeviceSetting<unknown>(COOK_VIEW_STYLE_KEY, null));
}

/** Saves the style; an open cook screen follows at once. */
export function setCookViewStyle(style: CookViewStyle): void {
  setDeviceSetting(COOK_VIEW_STYLE_KEY, style);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The device's cook view style, kept current while it's changed. */
export function useCookViewStyle(): CookViewStyle {
  return useSyncExternalStore(subscribe, getCookViewStyle);
}
