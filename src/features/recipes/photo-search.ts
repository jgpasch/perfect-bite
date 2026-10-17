// The Choose a photo sheet's stock photo search (spec 4.5, 6.11), from the `photo-search` Edge
// Function, as `loadPagePhotos` is for the page's photos.
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import {
  MAX_PHOTO_SEARCH_PAGE,
  MAX_PHOTO_SEARCH_QUERY,
  PhotoSearchErrorSchema,
  PhotoSearchResponseSchema,
  type PhotoSearchResult,
} from '@/shared/schemas/photo-search';

import { knownOffline } from './suggest-tags';

/**
 * `offline`: no connection, session or config. `rate_limited`: the user's minute or day limit.
 * `failed`: anything else (no Pexels key or the global cap, Pexels failing, a bad answer).
 */
export type PhotoSearchFailure = 'offline' | 'rate_limited' | 'failed';

export type PhotoSearchOutcome =
  | { ok: true; photos: PhotoSearchResult[]; hasMore: boolean }
  | { ok: false; error: PhotoSearchFailure };

/**
 * The words the sheet searches for: trimmed and cut to the server's 100 characters, so a long
 * recipe name still searches. Empty means there's nothing to search.
 */
export function photoSearchQuery(text: string): string {
  return text.trim().slice(0, MAX_PHOTO_SEARCH_QUERY).trim();
}

/** Asks the server for page `page` (1 to 10) of stock photos for `query`. Never throws. */
export async function searchPhotos(query: string, page = 1): Promise<PhotoSearchOutcome> {
  const words = photoSearchQuery(query);
  if (!words || !Number.isInteger(page) || page < 1 || page > MAX_PHOTO_SEARCH_PAGE) return { ok: false, error: 'failed' };
  if (!isSupabaseConfigured || (await knownOffline())) return { ok: false, error: 'offline' };
  try {
    const { data: auth } = await supabase.auth.getSession();
    if (!auth.session) return { ok: false, error: 'offline' };
    const { data, error } = await supabase.functions.invoke('photo-search', { body: { query: words, page } });
    if (error) return { ok: false, error: await errorCode(error) };
    const parsed = PhotoSearchResponseSchema.safeParse(data);
    if (!parsed.success) {
      console.warn('photo-search: unexpected response', parsed.error);
      return { ok: false, error: 'failed' };
    }
    // The last page never has more, whatever the answer says.
    return { ok: true, photos: parsed.data.photos, hasMore: parsed.data.hasMore && page < MAX_PHOTO_SEARCH_PAGE };
  } catch (e) {
    console.warn('photo-search failed', e);
    return { ok: false, error: 'offline' };
  }
}

/** Maps a `functions.invoke` error: a network failure is offline, the user's limit is rate_limited. */
async function errorCode(error: unknown): Promise<PhotoSearchFailure> {
  if ((error as { name?: unknown } | null)?.name === 'FunctionsFetchError') return 'offline';
  const response = (error as { context?: unknown } | null)?.context as { status?: number; json?: () => Promise<unknown> } | undefined;
  let code: string | undefined;
  try {
    const parsed = PhotoSearchErrorSchema.safeParse(await response?.json?.());
    if (parsed.success) code = parsed.data.error;
  } catch {
    // Not a JSON body; fall back to the status.
  }
  if (code === 'rate_limited' || (!code && response?.status === 429)) return 'rate_limited';
  return 'failed';
}

/** Appends a further page to the photos shown, leaving out any already there. */
export function appendPhotos(shown: PhotoSearchResult[], more: PhotoSearchResult[]): PhotoSearchResult[] {
  const seen = new Set(shown.map((p) => p.id));
  return [...shown, ...more.filter((p) => !seen.has(p.id) && seen.add(p.id))];
}
