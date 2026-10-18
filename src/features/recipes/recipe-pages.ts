// A photo import's original pages (spec 4.5, `recipes.source_pages`): sharing one from the pages screen,
// deleting them all, and the "Pages deleted" toast the recipe screen shows after.
import { Image } from 'expo-image';
import { File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { Share } from 'react-native';

import { newId } from '@/lib/id';

import { updateRecipeSourcePages } from './recipes';

/**
 * Shares the page at `path` through the system share sheet, from the copy `expo-image` cached when the
 * screen showed it (keyed by its path). It's copied to a `.jpg` first, as the cached file has no
 * extension. False when the page isn't in the cache (it never loaded) or the copy fails.
 */
export async function shareRecipePage(path: string): Promise<boolean> {
  try {
    const cached = await Image.getCachePathAsync(path);
    if (!cached) return false;
    const copy = new File(Paths.cache, `page-${newId()}.jpg`);
    await new File(cached.startsWith('file://') ? cached : `file://${cached}`).copy(copy);
    await Share.share({ url: copy.uri });
    return true;
  } catch (err) {
    console.warn('Sharing a recipe page failed', err);
    return false;
  }
}

// --- Delete pages --------------------------------------------------------------------------------

/** The "Pages deleted" toast on the recipe screen; no Undo. */
export type PagesDeleted = { recipeId: string; key: number };

let deleted: PagesDeleted | null = null;
let nextKey = 1;
const listeners = new Set<() => void>();

function emit(next: PagesDeleted | null) {
  deleted = next;
  for (const listener of [...listeners]) listener();
}

/** Clears the recipe's `source_pages` through the usual recipe update (the server deletes the files), and posts the toast. */
export function deleteRecipePages(recipeId: string): void {
  updateRecipeSourcePages(recipeId, null);
  emit({ recipeId, key: nextKey++ });
}

/** Hides the toast (only `key`'s, when given). */
export function dismissPagesDeleted(key?: number): void {
  if (deleted && (key === undefined || deleted.key === key)) emit(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The recipe's "Pages deleted" toast, while it shows. */
export function usePagesDeleted(recipeId: string): PagesDeleted | null {
  const current = useSyncExternalStore(subscribe, () => deleted);
  return current?.recipeId === recipeId ? current : null;
}
