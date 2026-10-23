// Choosing a recipe's photo (spec 4.5, 6.9): the photos on the recipe's page, from the
// `recipe-photos` Edge Function, and the change the sheet hands back to the recipe screen for its
// "Photo updated" toast and Undo.
import { useSyncExternalStore } from 'react';

import { reportError } from '@/lib/sentry';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import { RecipePhotosErrorSchema, RecipePhotosResponseSchema } from '@/shared/schemas/recipe-photos';


import type { RecipePhotoFields } from './recipe-photo-source';
import { updateRecipePhoto } from './recipes';
import { knownOffline } from './suggest-tags';

/**
 * `offline`: no connection, session or config. `none`: the page couldn't be fetched or isn't a
 * link that can be (`fetch_failed`, `invalid_url`), shown as "No photos found on the page", as an
 * empty list is. `failed`: the rate limit or anything else.
 */
export type PagePhotosError = 'offline' | 'none' | 'failed';

export type PagePhotosResult = { ok: true; images: string[] } | { ok: false; error: PagePhotosError };

/** Asks the server for the photos on `url`'s page, best first. Never throws. */
export async function loadPagePhotos(url: string): Promise<PagePhotosResult> {
  if (!isSupabaseConfigured || (await knownOffline())) return { ok: false, error: 'offline' };
  try {
    const { data: auth } = await supabase.auth.getSession();
    if (!auth.session) return { ok: false, error: 'offline' };
    const { data, error } = await supabase.functions.invoke('recipe-photos', { body: { url } });
    if (error) return { ok: false, error: await errorCode(error) };
    const parsed = RecipePhotosResponseSchema.safeParse(data);
    if (!parsed.success) {
      console.warn('recipe-photos: unexpected response', parsed.error);
      reportError(parsed.error, { area: 'functions', event: 'unexpected_response', function: 'recipe-photos' });
      return { ok: false, error: 'failed' };
    }
    return { ok: true, images: parsed.data.images };
  } catch (e) {
    console.warn('recipe-photos failed', e);
    return { ok: false, error: 'offline' };
  }
}

/** Maps a `functions.invoke` error: a network failure is offline, a page that can't be read is none. */
async function errorCode(error: unknown): Promise<PagePhotosError> {
  if ((error as { name?: unknown } | null)?.name === 'FunctionsFetchError') return 'offline';
  const response = (error as { context?: unknown } | null)?.context as { status?: number; json?: () => Promise<unknown> } | undefined;
  let code: string | undefined;
  try {
    const parsed = RecipePhotosErrorSchema.safeParse(await response?.json?.());
    if (parsed.success) code = parsed.data.error;
  } catch {
    // Not a JSON body; fall back to the status.
  }
  const status = response?.status;
  if (code === 'fetch_failed' || code === 'invalid_url' || (!code && (status === 502 || status === 400))) return 'none';
  return 'failed';
}

/** The photo a recipe has after picking a page photo: the site photo, and no own photo. */
export function pagePhoto(imageUrl: string): RecipePhotoFields {
  return { imageUrl, photoPath: null };
}

/**
 * The photo a recipe has after Remove photo: an own photo goes, so the site's (if any) shows again;
 * otherwise the site photo goes.
 */
export function photoAfterRemove(current: RecipePhotoFields): RecipePhotoFields {
  return { imageUrl: current.photoPath !== null ? current.imageUrl : null, photoPath: null };
}

/** A photo change the sheet made, for the recipe screen's toast: what it was before, for Undo. */
export type PhotoChange = { recipeId: string; previous: RecipePhotoFields; next: RecipePhotoFields; removed: boolean; key: number };

let change: PhotoChange | null = null;
let nextKey = 1;
const listeners = new Set<() => void>();

function emit(next: PhotoChange | null) {
  change = next;
  for (const listener of [...listeners]) listener();
}

/** The fields of `next` that differ from `from`, so an unchanged one keeps its clock. */
function changedFields(from: RecipePhotoFields, next: RecipePhotoFields): Partial<RecipePhotoFields> {
  return {
    ...(next.imageUrl !== from.imageUrl ? { imageUrl: next.imageUrl } : {}),
    ...(next.photoPath !== from.photoPath ? { photoPath: next.photoPath } : {}),
  };
}

/**
 * Sets the recipe's photo fields (`next`, from `previous`) through the usual recipe update, so they
 * sync, and leaves the change for the recipe screen's toast ("Photo removed" when `next` is what
 * Remove photo leaves). Picking the photo it already has writes nothing.
 */
export function chooseRecipePhoto(recipeId: string, previous: RecipePhotoFields, next: RecipePhotoFields): void {
  const patch = changedFields(previous, next);
  if (Object.keys(patch).length === 0) return;
  updateRecipePhoto(recipeId, patch);
  const afterRemove = photoAfterRemove(previous);
  const removed = next.imageUrl === afterRemove.imageUrl && next.photoPath === afterRemove.photoPath;
  emit({ recipeId, previous, next, removed, key: nextKey++ });
}

/** The toast's Undo: puts the photo fields back as they were and ends the toast. */
export function undoPhotoChange(c: PhotoChange): void {
  updateRecipePhoto(c.recipeId, changedFields(c.next, c.previous));
  if (change?.key === c.key) emit(null);
}

/** Ends the toast (it timed out, or the screen closed). */
export function dismissPhotoChange(key?: number): void {
  if (change && (key === undefined || change.key === key)) emit(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The pending photo change for `recipeId`, if any. */
export function usePhotoChange(recipeId: string): PhotoChange | null {
  const current = useSyncExternalStore(subscribe, () => change);
  return current?.recipeId === recipeId ? current : null;
}
