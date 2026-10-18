// A household's own recipe photo (spec 4.5): picking it from the library or the camera, shrinking it
// on the device, uploading it to the private recipe-photos bucket, and setting `photo_path` through
// the usual recipe update. While it uploads, the recipe screen shows the photo from the device with
// a spinner; a failure leaves the recipe as it was and the screen offers Try again. A stock photo
// (from the sheet's Search photos) is downloaded first and then goes the same way, with its credit.
// A photo import's pages (spec 4.10) upload the same way to the private recipe-pages bucket.
// Generate with AI asks the server for the recipe's one AI photo and sets `photo_path` to it.
import { File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useSyncExternalStore } from 'react';

import { lostFeature } from '@/features/plans/load';
import { newId } from '@/lib/id';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { PhotoCredit } from '@/shared/photo-credit';
import { GenerateRecipePhotoErrorSchema, GenerateRecipePhotoResponseSchema } from '@/shared/schemas/generate-recipe-photo';
import type { PhotoSearchResult } from '@/shared/schemas/photo-search';

import { downscalePhoto, UPLOAD_PHOTO } from './downscale-photo';
import { RECIPE_PAGES_BUCKET, RECIPE_PHOTOS_BUCKET } from './recipe-photo-source';
import { chooseRecipePhoto } from './recipe-photos';
import { getRecipe } from './recipes';

export type PhotoSource = 'library' | 'camera';

/**
 * Where a new photo goes: `<household_id>/<recipe_id>/<uuid>.jpg`, the shape `recipes.photo_path`
 * and the bucket's policies allow. Every photo is a new object.
 */
export function recipePhotoPath(householdId: string, recipeId: string, id: string = newId()): string {
  return `${householdId}/${recipeId}/${id}.jpg`;
}

/** `cancelled`: the user backed out; `denied`: no camera access. */
export type PickResult = { ok: true; uri: string } | { ok: false; reason: 'cancelled' | 'denied' };

/**
 * Lets the user pick a photo (cropping to 4:3 allowed) and returns it as picked, full size. The
 * library needs no permission (the system picker); the camera asks. An item's photo (spec 4.4)
 * is shrunk as it uploads.
 */
export async function pickPhoto(from: PhotoSource): Promise<PickResult> {
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: 'images', allowsEditing: true, aspect: [4, 3], quality: 1 };
  let result: ImagePicker.ImagePickerResult;
  if (from === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return { ok: false, reason: 'denied' };
    result = await ImagePicker.launchCameraAsync(options);
  } else {
    result = await ImagePicker.launchImageLibraryAsync(options);
  }
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return { ok: false, reason: 'cancelled' };
  return { ok: true, uri: asset.uri };
}

/** `pickPhoto`, returning the photo shrunk for upload (`UPLOAD_PHOTO`). */
export async function pickRecipePhoto(from: PhotoSource): Promise<PickResult> {
  const picked = await pickPhoto(from);
  if (!picked.ok) return picked;
  const photo = await downscalePhoto(picked.uri, UPLOAD_PHOTO);
  return { ok: true, uri: photo.uri };
}

// --- The upload ----------------------------------------------------------------------------------

/** Stores the JPEG at `localUri` as a new object at `path` in `bucket`. Throws on failure. */
async function uploadJpeg(bucket: string, path: string, localUri: string): Promise<void> {
  const body = await new File(localUri).arrayBuffer();
  const { error } = await supabase.storage.from(bucket).upload(path, body, { contentType: 'image/jpeg', upsert: false });
  if (error) throw error;
}

/**
 * A photo import's pages (spec 4.10): uploads each (already shrunk) to `recipe-pages` at a new path,
 * one at a time and in order, and returns the paths for `source_pages`. Best effort: if one fails,
 * removes those that went up and resolves null. Never throws.
 */
export async function uploadRecipePages(householdId: string, recipeId: string, uris: readonly string[]): Promise<string[] | null> {
  const uploaded: string[] = [];
  try {
    for (const uri of uris) {
      const path = recipePhotoPath(householdId, recipeId);
      await uploadJpeg(RECIPE_PAGES_BUCKET, path, uri);
      uploaded.push(path);
    }
    return uploaded;
  } catch (e) {
    console.warn('[pages] upload failed', e);
    if (uploaded.length > 0) {
      try {
        const { error } = await supabase.storage.from(RECIPE_PAGES_BUCKET).remove(uploaded);
        if (error) throw error;
      } catch (removeError) {
        // Nothing points at them; they stay until the recipe or household goes.
        console.warn('[pages] removing the uploaded pages failed', removeError);
      }
    }
    return null;
  }
}

/**
 * What a stock pick needs: the photo to download (`full`), one to show meanwhile (`thumb`), and the
 * credit's names and links, `provider` being the name the search answer gave for its service.
 */
export type StockPhoto = Pick<PhotoSearchResult, 'thumb' | 'full' | 'author' | 'authorUrl' | 'pageUrl'> & { provider: string };

/** A stock photo's `recipes.photo_credit`. */
export function stockPhotoCredit(photo: StockPhoto): PhotoCredit {
  return { provider: photo.provider, author: photo.author, authorUrl: photo.authorUrl, pageUrl: photo.pageUrl };
}

/**
 * An upload the recipe screen shows: the photo (`localUri`, from the device; a stock photo's
 * `thumb` while it downloads) and its credit, uploading or failed. `stock` is set for a stock pick,
 * so Try again downloads it again.
 */
export type PhotoUpload = {
  recipeId: string;
  localUri: string;
  credit: PhotoCredit | null;
  stock: StockPhoto | null;
  status: 'uploading' | 'failed';
  key: number;
};

let upload: PhotoUpload | null = null;
let nextKey = 1;
const listeners = new Set<() => void>();

function emit(next: PhotoUpload | null) {
  upload = next;
  for (const listener of [...listeners]) listener();
}

/**
 * Shows `shown` as uploading, gets the file to upload (`prepare`), uploads it and, once it's stored,
 * sets `photo_path` to it and `photo_credit` to `credit`, with the usual "Photo updated" change (the
 * site photo stays, for Remove). Resolves false on failure, leaving the recipe as it was and the
 * upload `failed` for the screen's toast. Never throws.
 */
async function runUpload(
  recipeId: string,
  shown: string,
  credit: PhotoCredit | null,
  stock: StockPhoto | null,
  prepare: () => Promise<string>,
): Promise<boolean> {
  const key = nextKey++;
  emit({ recipeId, localUri: shown, credit, stock, status: 'uploading', key });
  try {
    const recipe = getRecipe(recipeId);
    if (!recipe) throw new Error('recipe gone');
    const localUri = await prepare();
    const path = recipePhotoPath(recipe.householdId, recipeId);
    await uploadJpeg(RECIPE_PHOTOS_BUCKET, path, localUri);
    // Read again: the recipe may have changed while it uploaded.
    const now = getRecipe(recipeId);
    if (now) {
      const previous = { imageUrl: now.imageUrl, photoPath: now.photoPath, photoCredit: now.photoCredit };
      chooseRecipePhoto(recipeId, previous, { imageUrl: now.imageUrl, photoPath: path, photoCredit: credit });
    }
    if (upload?.key === key) emit(null);
    return true;
  } catch (e) {
    console.warn('[photo] upload failed', e);
    if (upload?.key === key) emit({ recipeId, localUri: shown, credit, stock, status: 'failed', key });
    return false;
  }
}

/**
 * Uploads the photo at `localUri` (already shrunk) for the recipe and sets `photo_path` to it, and
 * `photo_credit` to `credit` (a stock photo's; a library or camera photo has none). Never throws.
 */
export function uploadRecipePhoto(recipeId: string, localUri: string, credit: PhotoCredit | null = null): Promise<boolean> {
  return runUpload(recipeId, localUri, credit, null, async () => localUri);
}

/**
 * A stock photo picked in Search photos: downloads `full` to the cache directory, shrinks it for
 * upload (`UPLOAD_PHOTO`) and uploads it as the household's own photo with the photo's credit. While
 * it downloads, the screen shows the `thumb` the sheet already loaded. A failed download or upload
 * leaves the recipe as it was, and Try again starts over from the download. Never throws.
 */
export function uploadStockPhoto(recipeId: string, photo: StockPhoto): Promise<boolean> {
  return runUpload(recipeId, photo.thumb, stockPhotoCredit(photo), photo, async () => {
    const downloaded = await File.downloadFileAsync(photo.full, new File(Paths.cache, `stock-${newId()}.jpg`), {
      idempotent: true,
    });
    try {
      return (await downscalePhoto(downloaded.uri, UPLOAD_PHOTO)).uri;
    } finally {
      // The shrunk copy is what's uploaded; the full-size download isn't needed again.
      try {
        downloaded.delete();
      } catch {}
    }
  });
}

/** Try again on the failure toast: uploads the same photo (with its credit) again; a stock photo is downloaded again. */
export function retryPhotoUpload(u: PhotoUpload): Promise<boolean> {
  return u.stock ? uploadStockPhoto(u.recipeId, u.stock) : uploadRecipePhoto(u.recipeId, u.localUri, u.credit);
}

/** Ends a failed upload's toast (dismissed, timed out, or the screen closed). Leaves one in flight alone. */
export function dismissPhotoUpload(key?: number): void {
  if (upload && upload.status === 'failed' && (key === undefined || upload.key === key)) emit(null);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The upload for `recipeId`, if any. */
export function usePhotoUpload(recipeId: string): PhotoUpload | null {
  const current = useSyncExternalStore(subscribe, () => upload);
  return current?.recipeId === recipeId ? current : null;
}

/** For tests. */
export function resetPhotoUpload(): void {
  emit(null);
  generations = new Map();
  for (const listener of [...listeners]) listener();
  watchers.clear();
}

// --- Generate with AI (spec 4.5, 6.11) -----------------------------------------------------------

/**
 * Why a generation failed: `not_food` (the server wouldn't make a photo for this recipe),
 * `already_generated` (it has had its one AI photo), `failed` (anything else; the server released
 * the slot, so it can be tried again).
 */
export type PhotoGenerationError = 'not_food' | 'already_generated' | 'failed';

/** A generation the recipe screen shows: running, or failed with why. */
export type PhotoGeneration =
  | { recipeId: string; status: 'generating'; key: number }
  | { recipeId: string; status: 'failed'; error: PhotoGenerationError; key: number };

// One per recipe; replaced (not changed) on every update, for useSyncExternalStore.
let generations: ReadonlyMap<string, PhotoGeneration> = new Map();
// How many recipe screens show each recipe, so a failure nobody is looking at is dropped.
const watchers = new Map<string, number>();

function emitGeneration(recipeId: string, next: PhotoGeneration | null) {
  const map = new Map(generations);
  if (next) map.set(recipeId, next);
  else map.delete(recipeId);
  generations = map;
  for (const listener of [...listeners]) listener();
}

/** Asks `generate-recipe-photo` for the recipe's photo: its path, or why not. Never throws. */
async function requestGeneratedPhoto(recipeId: string): Promise<{ ok: true; path: string } | { ok: false; error: PhotoGenerationError }> {
  if (!isSupabaseConfigured) return { ok: false, error: 'failed' };
  try {
    const { data: auth } = await supabase.auth.getSession();
    if (!auth.session) return { ok: false, error: 'failed' };
    const { data, error } = await supabase.functions.invoke('generate-recipe-photo', { body: { recipeId } });
    if (error) return { ok: false, error: await generationError(error) };
    const parsed = GenerateRecipePhotoResponseSchema.safeParse(data);
    if (!parsed.success) {
      console.warn('generate-recipe-photo: unexpected response', parsed.error);
      return { ok: false, error: 'failed' };
    }
    return { ok: true, path: parsed.data.path };
  } catch (e) {
    console.warn('generate-recipe-photo failed', e);
    return { ok: false, error: 'failed' };
  }
}

/** Maps a `functions.invoke` error by its code, else its status. */
async function generationError(error: unknown): Promise<PhotoGenerationError> {
  const response = (error as { context?: unknown } | null)?.context as
    | { status?: number; json?: () => Promise<unknown> }
    | undefined;
  let code: string | undefined;
  try {
    const parsed = GenerateRecipePhotoErrorSchema.safeParse(await response?.json?.());
    if (parsed.success) code = parsed.data.error;
  } catch {
    // Not a JSON body; fall back to the status.
  }
  const status = response?.status;
  if (code === 'not_food' || (!code && status === 422)) return 'not_food';
  if (code === 'already_generated' || (!code && status === 409)) return 'already_generated';
  // The plan has no AI photos: hide the row now and reload the plan (spec 4.12).
  if (code === 'not_entitled' || (!code && status === 403)) void lostFeature('recipe_photo_ai');
  console.warn('generate-recipe-photo returned an error', error);
  return 'failed';
}

/**
 * Generate with AI (spec 4.5): asks the server for the recipe's one AI photo and, once it answers,
 * sets `photo_path` to it and `photo_credit` to null through the usual recipe update, with "Photo
 * updated" and Undo. Runs outside the sheet and the screen, so leaving the recipe doesn't drop it.
 * A failure is kept for the recipe screen's toast if one shows the recipe, else dropped. Resolves
 * whether it worked; never throws.
 */
export async function generateRecipePhoto(recipeId: string): Promise<boolean> {
  if (generations.get(recipeId)?.status === 'generating') return false;
  const key = nextKey++;
  emitGeneration(recipeId, { recipeId, status: 'generating', key });
  const result = await requestGeneratedPhoto(recipeId);
  const now = getRecipe(recipeId);
  if (result.ok && now) {
    const previous = { imageUrl: now.imageUrl, photoPath: now.photoPath, photoCredit: now.photoCredit };
    chooseRecipePhoto(recipeId, previous, { imageUrl: now.imageUrl, photoPath: result.path, photoCredit: null });
  }
  if (generations.get(recipeId)?.key === key) {
    const shown = (watchers.get(recipeId) ?? 0) > 0;
    emitGeneration(recipeId, result.ok || !now || !shown ? null : { recipeId, status: 'failed', error: result.error, key });
  }
  return result.ok && now !== undefined;
}

/** Ends a failed generation's toast for the recipe (dismissed, timed out, or the screen closed). Leaves one in flight alone. */
export function dismissPhotoGeneration(recipeId: string, key?: number): void {
  const current = generations.get(recipeId);
  if (current?.status === 'failed' && (key === undefined || current.key === key)) emitGeneration(recipeId, null);
}

/**
 * The generation for `recipeId`, if any. The recipe screen calls it, which also marks the recipe as
 * shown, so a failure that comes back while it's open is kept for its toast.
 */
export function usePhotoGeneration(recipeId: string): PhotoGeneration | null {
  useEffect(() => {
    watchers.set(recipeId, (watchers.get(recipeId) ?? 0) + 1);
    return () => {
      const left = (watchers.get(recipeId) ?? 1) - 1;
      if (left > 0) watchers.set(recipeId, left);
      else watchers.delete(recipeId);
    };
  }, [recipeId]);
  return useSyncExternalStore(subscribe, () => generations.get(recipeId) ?? null);
}
