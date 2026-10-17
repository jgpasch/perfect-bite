// expo-image's caches hold recipe photos, the household's own included (spec 4.5), and item photos
// (spec 4.4). Clearing them whole covers both buckets. When the device
// loses a household (left, removed, deleted) or the user's data is wiped, they're cleared, so a
// former member's phone doesn't keep the photos. The site photos and the rest load again as needed.
import { Image } from 'expo-image';

/** Clears expo-image's disk and memory caches. Never throws; a failure is logged. */
export function clearPhotoCache(): Promise<void> {
  return Promise.all([Image.clearDiskCache(), Image.clearMemoryCache()]).then(
    () => {},
    (err) => console.warn('[photos] clearing the image cache failed', err),
  );
}
