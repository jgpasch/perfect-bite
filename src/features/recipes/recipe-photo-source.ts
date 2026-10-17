// Which photo a recipe shows, and how `expo-image` loads it (spec 4.5): the household's own photo
// (`photo_path`, in the private `recipe-photos` bucket) when set, else the site's (`image_url`).
//
// An own photo loads from Storage's authenticated endpoint with the session's token as a header
// (expo-image sends `headers` on iOS and Android), cached on disk by its path, so the cached copy
// survives token refreshes and shows offline.
import type { ImageSource } from 'expo-image';
import { useState, useSyncExternalStore } from 'react';

import { isSupabaseConfigured, supabase, supabaseUrl } from '@/lib/supabase';

export const RECIPE_PHOTOS_BUCKET = 'recipe-photos';

/** The two photo columns of a recipe. */
export type RecipePhotoFields = { imageUrl: string | null; photoPath: string | null };

/** What an own photo needs to load: the signed-in session's access token. */
export type PhotoSession = { accessToken: string } | null;

/** What `<Image source>` takes for a recipe: a site photo's URL, an own photo's request, or none. */
export type RecipeImageSource = string | ImageSource;

/** The Storage URL of an own photo, read with the caller's token (members only, by the bucket's policies). */
export function photoObjectUrl(path: string): string {
  return `${supabaseUrl}/storage/v1/object/authenticated/${RECIPE_PHOTOS_BUCKET}/${path}`;
}

/**
 * The `expo-image` source for a recipe's photo. An own photo is keyed by its path (`cacheKey`), so
 * a new token or no session at all still finds it on disk; without a session it's asked for
 * without the header, which only the cache can answer. Null when the recipe has no photo.
 */
export function recipePhotoSource(recipe: RecipePhotoFields, session: PhotoSession): RecipeImageSource | null {
  if (recipe.photoPath) {
    return {
      uri: photoObjectUrl(recipe.photoPath),
      cacheKey: recipe.photoPath,
      ...(session ? { headers: { Authorization: `Bearer ${session.accessToken}` } } : {}),
    };
  }
  return recipe.imageUrl ?? null;
}

// --- The session's token -------------------------------------------------------------------------

let token: string | null = null;
let started = false;
const listeners = new Set<() => void>();

function setToken(next: string | null) {
  if (next === token) return;
  token = next;
  for (const listener of [...listeners]) listener();
}

/** Follows the signed-in session's token, refreshes included. Safe to call repeatedly. */
function start() {
  if (started || !isSupabaseConfigured) return;
  started = true;
  supabase.auth.onAuthStateChange((_event, session) => setToken(session?.access_token ?? null));
  void supabase.auth
    .getSession()
    .then(({ data }) => {
      if (token === null) setToken(data.session?.access_token ?? null);
    })
    .catch(() => {});
}

function subscribe(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** The session own photos load with; null while signed out or not known yet. */
export function usePhotoSession(): PhotoSession {
  const current = useSyncExternalStore(subscribe, () => token);
  return current ? { accessToken: current } : null;
}

/** Refreshes the session for a photo the server turned away. False when it couldn't (offline, signed out). */
export async function refreshPhotoSession(): Promise<boolean> {
  try {
    const { data, error } = await supabase.auth.refreshSession();
    const next = data?.session?.access_token ?? null;
    if (error || !next) return false;
    setToken(next);
    return true;
  } catch {
    return false;
  }
}

/** For tests: forgets the token and the subscription. */
export function resetPhotoSession(): void {
  token = null;
  started = false;
  listeners.clear();
}

// --- Loading -------------------------------------------------------------------------------------

/**
 * Whether a failed load is worth one retry with a fresh token: Storage turned the request away
 * (400, 401 or 403, as it answers an expired or missing token), or the message names no status.
 */
export function isAuthFailure(message: string | undefined): boolean {
  const status = message?.match(/\b([1-5]\d\d)\b/)?.[1];
  return status === undefined || status === '400' || status === '401' || status === '403';
}

/**
 * A recipe's photo for a view: its source, whether it's the household's own (no source credit),
 * and whether it failed for good in this view. An own photo the server turns away gets one retry
 * after refreshing the session; then, or for any other failure, it falls back (`failed`), and the
 * caller shows the icon tile. A different photo gets its own try.
 */
export function useRecipePhoto(recipe: RecipePhotoFields | null) {
  const session = usePhotoSession();
  const key = recipe ? (recipe.photoPath ?? recipe.imageUrl) : null;
  const [state, setState] = useState<{ key: string | null; retried: boolean; failed: boolean }>({
    key,
    retried: false,
    failed: false,
  });
  const current = state.key === key ? state : { key, retried: false, failed: false };
  const own = recipe?.photoPath != null;
  const source = recipe && !current.failed ? recipePhotoSource(recipe, session) : null;

  const onError = (event?: { error?: string }) => {
    if (key === null) return;
    if (own && !current.retried && isAuthFailure(event?.error)) {
      setState({ key, retried: true, failed: false });
      void refreshPhotoSession().then((ok) => {
        if (!ok) setState((s) => (s.key === key ? { ...s, failed: true } : s));
      });
      return;
    }
    setState({ key, retried: current.retried, failed: true });
  };

  return { source, own, failed: key !== null && current.failed, onError };
}
