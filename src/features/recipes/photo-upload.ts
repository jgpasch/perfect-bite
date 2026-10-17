// A household's own recipe photo (spec 4.5): picking it from the library or the camera, shrinking it
// on the device, uploading it to the private recipe-photos bucket, and setting `photo_path` through
// the usual recipe update. While it uploads, the recipe screen shows the photo from the device with
// a spinner; a failure leaves the recipe as it was and the screen offers Try again.
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { useSyncExternalStore } from 'react';

import { newId } from '@/lib/id';
import { supabase } from '@/lib/supabase';

import { downscalePhoto, UPLOAD_PHOTO } from './downscale-photo';
import { RECIPE_PHOTOS_BUCKET } from './recipe-photo-source';
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
 * Lets the user pick a photo (cropping to 4:3 allowed) and returns it shrunk for upload
 * (`UPLOAD_PHOTO`). The library needs no permission (the system picker); the camera asks.
 */
export async function pickRecipePhoto(from: PhotoSource): Promise<PickResult> {
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
  const photo = await downscalePhoto(asset.uri, UPLOAD_PHOTO);
  return { ok: true, uri: photo.uri };
}

// --- The upload ----------------------------------------------------------------------------------

/** An upload the recipe screen shows: the photo from the device, uploading or failed. */
export type PhotoUpload = { recipeId: string; localUri: string; status: 'uploading' | 'failed'; key: number };

let upload: PhotoUpload | null = null;
let nextKey = 1;
const listeners = new Set<() => void>();

function emit(next: PhotoUpload | null) {
  upload = next;
  for (const listener of [...listeners]) listener();
}

/**
 * Uploads the photo at `localUri` (already shrunk) for the recipe and, once it's stored, sets
 * `photo_path` to it with the usual "Photo updated" change (the site photo stays, for Remove).
 * Resolves false on failure, leaving the recipe as it was and the upload `failed` for the
 * screen's toast. Never throws.
 */
export async function uploadRecipePhoto(recipeId: string, localUri: string): Promise<boolean> {
  const key = nextKey++;
  emit({ recipeId, localUri, status: 'uploading', key });
  try {
    const recipe = getRecipe(recipeId);
    if (!recipe) throw new Error('recipe gone');
    const path = recipePhotoPath(recipe.householdId, recipeId);
    const body = await new File(localUri).arrayBuffer();
    const { error } = await supabase.storage
      .from(RECIPE_PHOTOS_BUCKET)
      .upload(path, body, { contentType: 'image/jpeg', upsert: false });
    if (error) throw error;
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
}
