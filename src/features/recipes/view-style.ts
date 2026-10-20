// Settings > Design trials > Recipe view (spec 4.5): how the recipe screen lays itself out on this device.
import { useSyncExternalStore } from 'react';

import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';

export const RECIPE_VIEW_STYLE_KEY = 'recipe.viewStyle';

/**
 * `standard`: the photo header, band, switch and cards. `titleOnPhoto`: board E
 * (`docs/design/recipe-view/e-title-on-photo.png`), the name on the photo over a byline, then the same switch and cards.
 */
export const RECIPE_VIEW_STYLES = ['standard', 'titleOnPhoto'] as const;
export type RecipeViewStyle = (typeof RECIPE_VIEW_STYLES)[number];

/** A saved value as a style: `standard` for anything else, never-set included. */
export function readRecipeViewStyle(value: unknown): RecipeViewStyle {
  return RECIPE_VIEW_STYLES.find((style) => style === value) ?? 'standard';
}

const listeners = new Set<() => void>();

export function getRecipeViewStyle(): RecipeViewStyle {
  return readRecipeViewStyle(getDeviceSetting<unknown>(RECIPE_VIEW_STYLE_KEY, null));
}

/** Saves the style; an open recipe screen follows at once. */
export function setRecipeViewStyle(style: RecipeViewStyle): void {
  setDeviceSetting(RECIPE_VIEW_STYLE_KEY, style);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The device's recipe view style, kept current while it's changed. */
export function useRecipeViewStyle(): RecipeViewStyle {
  return useSyncExternalStore(subscribe, getRecipeViewStyle);
}
