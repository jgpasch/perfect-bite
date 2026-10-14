// The Recipes tab's photo size (spec 4.5): small photos in rows, or large photos in a grid. Pure: no React or SQLite.

import { i18n } from '@/i18n';

export type RecipePhotoSize = 'small' | 'large';

/** The toggle's segments, in order. */
export const RECIPE_PHOTO_SIZES: readonly RecipePhotoSize[] = ['small', 'large'];
export const DEFAULT_RECIPE_PHOTO_SIZE: RecipePhotoSize = 'small';

/** The device setting that remembers the choice on this device. */
export const RECIPE_PHOTO_SIZE_KEY = 'recipes.photoSize';

/** A stored choice, or the default for anything else (never set, or from a newer app version). */
export function readRecipePhotoSize(value: unknown): RecipePhotoSize {
  return RECIPE_PHOTO_SIZES.includes(value as RecipePhotoSize) ? (value as RecipePhotoSize) : DEFAULT_RECIPE_PHOTO_SIZE;
}

/** A segment's VoiceOver label: "Small photos", "Large photos". */
export function recipePhotoSizeLabel(size: RecipePhotoSize): string {
  return i18n.t(`recipes.photoSize.${size}`);
}

/**
 * The text scale from which large photos go one per row: iOS's three largest accessibility sizes
 * (AX3 is about 2.35×; AX2, about 1.95×, still fits two).
 */
export const ONE_COLUMN_FONT_SCALE = 2;

/** How many tiles a row of large photos holds: two, or one at the largest accessibility text sizes. */
export function recipeGridColumns(fontScale: number): 1 | 2 {
  return fontScale >= ONE_COLUMN_FONT_SCALE ? 1 : 2;
}

/** `items` in rows of `columns`, the last row short if they don't divide evenly. */
export function gridRows<T>(items: readonly T[], columns: number): T[][] {
  const per = Math.max(1, Math.floor(columns));
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += per) rows.push(items.slice(i, i + per));
  return rows;
}
