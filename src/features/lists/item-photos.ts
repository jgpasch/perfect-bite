// An item's photo (spec 4.4): one per item, so whoever shops knows exactly what to get. It works
// like a recipe's own photo (spec 4.5): picked from the library or the camera, shrunk on the device,
// uploaded to the private item-photos bucket at a new path each time, and set in `photo_path`
// through the usual item update, so it syncs. While it uploads, the item sheet shows the photo from
// the device with a spinner; a failure leaves the item as it was and the sheet offers Try again. A
// change or removal leaves "Photo updated" / "Photo removed" with Undo.
import { File } from 'expo-file-system';
import { useSyncExternalStore } from 'react';

import { downscalePhoto, UPLOAD_PHOTO } from '@/features/recipes/downscale-photo';
import {
  ownPhotoSource,
  usePhotoFallback,
  usePhotoSession,
  type PhotoSession,
} from '@/features/recipes/recipe-photo-source';
import { newId } from '@/lib/id';
import { supabase } from '@/lib/supabase';

import { getItemPhoto, setItemPhoto } from './items';

export const ITEM_PHOTOS_BUCKET = 'item-photos';

/**
 * Where a new photo goes: `<household_id>/<list_item_id>/<uuid>.jpg`, the shape
 * `list_items.photo_path` and the bucket's policies allow. Every photo is a new object.
 */
export function itemPhotoPath(householdId: string, itemId: string, id: string = newId()): string {
  return `${householdId}/${itemId}/${id}.jpg`;
}

/** The `expo-image` source for an item's photo (keyed by its path, so it shows offline once seen); null for none. */
export function itemPhotoSource(photoPath: string | null | undefined, session: PhotoSession) {
  return photoPath ? ownPhotoSource(ITEM_PHOTOS_BUCKET, photoPath, session) : null;
}

/**
 * An item's photo for a view: its source, and whether it failed for good in this view. One the
 * server turns away gets one retry with a refreshed session, as a recipe's own photo does.
 */
export function useItemPhoto(photoPath: string | null | undefined) {
  const session = usePhotoSession();
  const { failed, onError } = usePhotoFallback(photoPath ?? null, true);
  const source = failed ? null : itemPhotoSource(photoPath, session);
  return { source, failed, onError };
}

// --- The upload ----------------------------------------------------------------------------------

/** An upload the item sheet shows: the photo from the device (`localUri`), uploading or failed. */
export type ItemPhotoUpload = { itemId: string; localUri: string; status: 'uploading' | 'failed'; key: number };

let upload: ItemPhotoUpload | null = null;
let nextUploadKey = 1;
const uploadListeners = new Set<() => void>();

function emitUpload(next: ItemPhotoUpload | null) {
  upload = next;
  for (const listener of [...uploadListeners]) listener();
}

/**
 * Shrinks the photo at `localUri` (`UPLOAD_PHOTO`), uploads it as a new object and, once it's
 * stored, sets the item's `photo_path` to it, leaving "Photo updated" with Undo. Resolves false on
 * failure, leaving the item as it was and the upload `failed` for the sheet's toast. Never throws.
 */
export async function uploadItemPhoto(itemId: string, localUri: string): Promise<boolean> {
  const key = nextUploadKey++;
  emitUpload({ itemId, localUri, status: 'uploading', key });
  try {
    const item = getItemPhoto(itemId);
    if (!item) throw new Error('item gone');
    const shrunk = await downscalePhoto(localUri, UPLOAD_PHOTO);
    const path = itemPhotoPath(item.householdId, itemId);
    const body = await new File(shrunk.uri).arrayBuffer();
    const { error } = await supabase.storage
      .from(ITEM_PHOTOS_BUCKET)
      .upload(path, body, { contentType: 'image/jpeg', upsert: false });
    if (error) throw error;
    // Read again: the photo may have changed while it uploaded.
    const now = getItemPhoto(itemId);
    if (now && setItemPhoto(itemId, path)) emitChange({ itemId, previous: now.photoPath, next: path, key: nextChangeKey++ });
    if (upload?.key === key) emitUpload(null);
    return true;
  } catch (e) {
    console.warn('[item photo] upload failed', e);
    if (upload?.key === key) emitUpload({ itemId, localUri, status: 'failed', key });
    return false;
  }
}

/** Try again on the failure toast: uploads the same photo again. */
export function retryItemPhotoUpload(u: ItemPhotoUpload): Promise<boolean> {
  return uploadItemPhoto(u.itemId, u.localUri);
}

/** Ends a failed upload's toast (dismissed, timed out, or the sheet closed). Leaves one in flight alone. */
export function dismissItemPhotoUpload(key?: number): void {
  if (upload && upload.status === 'failed' && (key === undefined || upload.key === key)) emitUpload(null);
}

function subscribeUpload(listener: () => void): () => void {
  uploadListeners.add(listener);
  return () => void uploadListeners.delete(listener);
}

/** The upload for `itemId`, if any. */
export function useItemPhotoUpload(itemId: string): ItemPhotoUpload | null {
  const current = useSyncExternalStore(subscribeUpload, () => upload);
  return current?.itemId === itemId ? current : null;
}

// --- The change and its Undo ---------------------------------------------------------------------

/** A photo change for the item sheet's toast: what it was before, for Undo. `next` null = removed. */
export type ItemPhotoChange = { itemId: string; previous: string | null; next: string | null; key: number };

let change: ItemPhotoChange | null = null;
let nextChangeKey = 1;
const changeListeners = new Set<() => void>();

function emitChange(next: ItemPhotoChange | null) {
  change = next;
  for (const listener of [...changeListeners]) listener();
}

/**
 * Remove photo: clears the item's `photo_path`, leaving "Photo removed" with Undo. The object is
 * deleted on the server later (`photo-cleanup`), so Undo can still point at it. False when the
 * item has no photo or is gone.
 */
export function removeItemPhoto(itemId: string): boolean {
  const item = getItemPhoto(itemId);
  if (!item?.photoPath) return false;
  if (!setItemPhoto(itemId, null)) return false;
  emitChange({ itemId, previous: item.photoPath, next: null, key: nextChangeKey++ });
  return true;
}

/** The toast's Undo: puts the photo back as it was and ends the toast. */
export function undoItemPhotoChange(c: ItemPhotoChange): void {
  setItemPhoto(c.itemId, c.previous);
  if (change?.key === c.key) emitChange(null);
}

/** Ends the toast (it timed out, or the sheet closed). */
export function dismissItemPhotoChange(key?: number): void {
  if (change && (key === undefined || change.key === key)) emitChange(null);
}

function subscribeChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => void changeListeners.delete(listener);
}

/** The pending photo change for `itemId`, if any. */
export function useItemPhotoChange(itemId: string): ItemPhotoChange | null {
  const current = useSyncExternalStore(subscribeChange, () => change);
  return current?.itemId === itemId ? current : null;
}

/** For tests. */
export function resetItemPhotos(): void {
  emitUpload(null);
  emitChange(null);
}
