// Picking the photos for a photo import (spec 4.10): up to three pages of one recipe, in order,
// from the library or the camera, each shrunk on the device before it's sent.
import * as ImagePicker from 'expo-image-picker';

import { MAX_PHOTO_IMPORT_IMAGES } from '@/shared/schemas/recipe-photo-import';

import { downscalePhoto, type DownscaleOptions } from './downscale-photo';
import type { PhotoSource } from './photo-upload';

/** A page for photo import: big enough to read small print, far under the function's 2 MB cap. */
export const IMPORT_PHOTO: DownscaleOptions = { longEdge: 2000, quality: 0.8 };

/** `cancelled`: the user backed out; `denied`: no camera access. */
export type PickPagesResult = { ok: true; uris: string[] } | { ok: false; reason: 'cancelled' | 'denied' };

/**
 * Lets the user pick pages and returns them shrunk (`IMPORT_PHOTO`), in the order picked. The
 * library allows up to `limit` (at most three) in one go; the camera takes one. No cropping.
 */
export async function pickImportPhotos(from: PhotoSource, limit: number = MAX_PHOTO_IMPORT_IMAGES): Promise<PickPagesResult> {
  const max = Math.min(limit, MAX_PHOTO_IMPORT_IMAGES);
  if (max < 1) return { ok: false, reason: 'cancelled' };
  let result: ImagePicker.ImagePickerResult;
  if (from === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return { ok: false, reason: 'denied' };
    result = await ImagePicker.launchCameraAsync({ mediaTypes: 'images', quality: 1 });
  } else {
    result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: 'images',
      allowsMultipleSelection: max > 1,
      selectionLimit: max,
      orderedSelection: true,
      quality: 1,
    });
  }
  const assets = result.canceled ? [] : result.assets.slice(0, from === 'camera' ? 1 : max);
  if (assets.length === 0) return { ok: false, reason: 'cancelled' };
  // One at a time, so the pages keep their order and the phone isn't decoding three at once.
  const uris: string[] = [];
  for (const asset of assets) uris.push((await downscalePhoto(asset.uri, IMPORT_PHOTO)).uri);
  return { ok: true, uris };
}

/**
 * The From photo… flow after the user chose where from: the library's pick, or camera shots one
 * at a time, asking after each (`askForAnother`) whether to add another page, until three. A
 * cancelled shot after the first keeps the pages so far. Null when nothing was picked.
 */
export async function collectImportPhotos(
  from: PhotoSource,
  {
    pick = pickImportPhotos,
    askForAnother,
    onDenied,
  }: {
    pick?: typeof pickImportPhotos;
    /** Resolves true for Add another page, false for Use photos. */
    askForAnother: (pages: number) => Promise<boolean>;
    onDenied: () => void;
  },
): Promise<string[] | null> {
  const pages: string[] = [];
  for (;;) {
    const picked = await pick(from, MAX_PHOTO_IMPORT_IMAGES - pages.length);
    if (!picked.ok) {
      if (picked.reason === 'denied') onDenied();
      break;
    }
    pages.push(...picked.uris);
    if (from === 'library' || pages.length >= MAX_PHOTO_IMPORT_IMAGES) break;
    if (!(await askForAnother(pages.length))) break;
  }
  return pages.length > 0 ? pages.slice(0, MAX_PHOTO_IMPORT_IMAGES) : null;
}

/** The import sheet's `photos` param: the page URIs as JSON. */
export function photosParam(uris: readonly string[]): string {
  return JSON.stringify(uris);
}

/** Reads the `photos` param back: one to three strings, else null (a link import). */
export function photosFromParam(param: string | undefined): string[] | null {
  if (!param) return null;
  try {
    const value: unknown = JSON.parse(param);
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PHOTO_IMPORT_IMAGES) return null;
    return value.every((v) => typeof v === 'string' && v !== '') ? (value as string[]) : null;
  } catch {
    return null;
  }
}
