// A household's own recipe photo (spec 4.5): picking it from the library or the camera, shrinking it
// on the device, uploading it to the private recipe-photos bucket, and setting `photo_path` through
// the usual recipe update. While it uploads, the recipe screen shows the photo from the device with
// a spinner; a failure leaves the recipe as it was and the screen offers Try again.
// A photo import's pages (spec 4.10) upload the same way to the private recipe-pages bucket.
// Generate with AI asks the server for the recipe's one AI photo and sets `photo_path` to it.
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useSyncExternalStore } from 'react';

import { limitResetsAt, resetDate } from '@/features/plans/limits';
import { lostFeature } from '@/features/plans/load';
import { i18n } from '@/i18n';
import { newId } from '@/lib/id';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import { GenerateRecipePhotoErrorSchema, GenerateRecipePhotoResponseSchema } from '@/shared/schemas/generate-recipe-photo';

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

/** An upload the recipe screen shows: the photo (`localUri`, from the device), uploading or failed. */
export type PhotoUpload = {
  recipeId: string;
  localUri: string;
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
 * Uploads the photo at `localUri` (already shrunk) for the recipe, showing it as uploading, and once
 * it's stored sets `photo_path` to it, with the usual "Photo updated" change (the site photo stays,
 * for Remove). Resolves false on failure, leaving the recipe as it was and the upload `failed` for
 * the screen's toast. Never throws.
 */
export async function uploadRecipePhoto(recipeId: string, localUri: string): Promise<boolean> {
  const key = nextKey++;
  emit({ recipeId, localUri, status: 'uploading', key });
  try {
    const recipe = getRecipe(recipeId);
    if (!recipe) throw new Error('recipe gone');
    const path = recipePhotoPath(recipe.householdId, recipeId);
    await uploadJpeg(RECIPE_PHOTOS_BUCKET, path, localUri);
    // Read again: the recipe may have changed while it uploaded.
    const now = getRecipe(recipeId);
    if (now) {
      const previous = { imageUrl: now.imageUrl, photoPath: now.photoPath };
      chooseRecipePhoto(recipeId, previous, { imageUrl: now.imageUrl, photoPath: path });
    }
    if (upload?.key === key) emit(null);
    return true;
  } catch (e) {
    console.warn('[photo] upload failed', e);
    if (upload?.key === key) emit({ recipeId, localUri, status: 'failed', key });
    return false;
  }
}

/** Try again on the failure toast: uploads the same photo again. */
export function retryPhotoUpload(u: PhotoUpload): Promise<boolean> {
  return uploadRecipePhoto(u.recipeId, u.localUri);
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
 * `already_generated` (it has had its one AI photo), `limit_reached` (the plan's AI photos this
 * month are made, spec 4.12; back at `resetsAt`), `failed` (anything else; the server released
 * the slot, so it can be tried again).
 */
export type PhotoGenerationError = 'not_food' | 'already_generated' | 'limit_reached' | 'failed';

type GenerationFailure = { error: Exclude<PhotoGenerationError, 'limit_reached'> } | { error: 'limit_reached'; resetsAt: string };

/** A generation the recipe screen shows: running, or failed with why. */
export type PhotoGeneration =
  | { recipeId: string; status: 'generating'; key: number }
  | ({ recipeId: string; status: 'failed'; key: number } & GenerationFailure);

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
async function requestGeneratedPhoto(recipeId: string): Promise<{ ok: true; path: string } | ({ ok: false } & GenerationFailure)> {
  if (!isSupabaseConfigured) return { ok: false, error: 'failed' };
  try {
    const { data: auth } = await supabase.auth.getSession();
    if (!auth.session) return { ok: false, error: 'failed' };
    const { data, error } = await supabase.functions.invoke('generate-recipe-photo', { body: { recipeId } });
    if (error) return { ok: false, ...(await generationError(error)) };
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
async function generationError(error: unknown): Promise<GenerationFailure> {
  const response = (error as { context?: unknown } | null)?.context as
    | { status?: number; json?: () => Promise<unknown> }
    | undefined;
  let code: string | undefined;
  let resetsAt: string | undefined;
  try {
    const parsed = GenerateRecipePhotoErrorSchema.safeParse(await response?.json?.());
    if (parsed.success) ({ error: code, resets_at: resetsAt } = parsed.data);
  } catch {
    // Not a JSON body; fall back to the status.
  }
  const status = response?.status;
  if (code === 'not_food' || (!code && status === 422)) return { error: 'not_food' };
  if (code === 'already_generated' || (!code && status === 409)) return { error: 'already_generated' };
  if (code === 'limit_reached') return { error: 'limit_reached', resetsAt: limitResetsAt(resetsAt) };
  // The plan has no AI photos: hide the row now and reload the plan (spec 4.12).
  if (code === 'not_entitled' || (!code && status === 403)) void lostFeature('recipe_photo_ai');
  console.warn('generate-recipe-photo returned an error', error);
  return { error: 'failed' };
}

function failureOf(result: { ok: false } & GenerationFailure): GenerationFailure {
  return result.error === 'limit_reached' ? { error: 'limit_reached', resetsAt: result.resetsAt } : { error: result.error };
}

/** A failed generation's toast (spec 4.5): "You've used this month's AI photos. They reset on Nov 1." for the monthly limit. */
export function photoGenerationMessage(failure: GenerationFailure): string {
  switch (failure.error) {
    case 'not_food':
      return i18n.t('recipes.photo.generateNotFood');
    case 'already_generated':
      return i18n.t('recipes.photo.generateAlready');
    case 'limit_reached':
      return i18n.t('recipes.photo.generateLimitReached', { date: resetDate(failure.resetsAt) });
    case 'failed':
      return i18n.t('recipes.photo.generateFailed');
  }
}

/**
 * Generate with AI (spec 4.5): asks the server for the recipe's one AI photo and, once it answers,
 * sets `photo_path` to it through the usual recipe update, with "Photo
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
    const previous = { imageUrl: now.imageUrl, photoPath: now.photoPath };
    chooseRecipePhoto(recipeId, previous, { imageUrl: now.imageUrl, photoPath: result.path });
  }
  if (generations.get(recipeId)?.key === key) {
    const shown = (watchers.get(recipeId) ?? 0) > 0;
    emitGeneration(recipeId, result.ok || !now || !shown ? null : { ...failureOf(result), recipeId, status: 'failed', key });
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
