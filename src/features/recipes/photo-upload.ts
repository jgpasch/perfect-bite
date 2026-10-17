// A household's own recipe photo (spec 4.5): picking it from the library or the camera, shrinking it
// on the device, uploading it to the private recipe-photos bucket, and setting `photo_path` through
// the usual recipe update. While it uploads, the recipe screen shows the photo from the device with
// a spinner; a failure leaves the recipe as it was and the screen offers Try again. A stock photo
// (from the sheet's Search photos) is downloaded first and then goes the same way, with its credit.
import { File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { useSyncExternalStore } from 'react';

import { newId } from '@/lib/id';
import { supabase } from '@/lib/supabase';
import type { PhotoCredit } from '@/shared/photo-credit';
import type { PhotoSearchResult } from '@/shared/schemas/photo-search';

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
    const body = await new File(localUri).arrayBuffer();
    const { error } = await supabase.storage
      .from(RECIPE_PHOTOS_BUCKET)
      .upload(path, body, { contentType: 'image/jpeg', upsert: false });
    if (error) throw error;
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
}
