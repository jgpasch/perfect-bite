// The stock photo services photo-search can use (spec 6.11), by PHOTO_SEARCH_PROVIDER. Adding one:
// a file here implementing PhotoProvider, a line in PROVIDERS, its key in .env.example, and its
// Deno tests. Nothing else changes; the app and the database don't name providers.
import { pexelsProvider } from './pexels.ts';
import { pixabayProvider } from './pixabay.ts';
import type { PhotoProvider, ProviderOptions } from './types.ts';

export { PhotoProviderError, type PhotoProvider, type ProviderPage } from './types.ts';

/** Each provider: how to make it, and the env var holding its key. */
export const PROVIDERS: Record<string, { keyVar: string; make: (options: ProviderOptions) => PhotoProvider }> = {
  pixabay: { keyVar: 'PIXABAY_API_KEY', make: pixabayProvider },
  pexels: { keyVar: 'PEXELS_API_KEY', make: pexelsProvider },
};

/** Used when PHOTO_SEARCH_PROVIDER is unset. */
export const DEFAULT_PHOTO_PROVIDER = 'pixabay';

/**
 * The provider PHOTO_SEARCH_PROVIDER names (default pixabay) with its key, or null when the name
 * isn't one of PROVIDERS or its key isn't set; photo-search then answers 503.
 */
export function photoProviderFromEnv(env: (name: string) => string | undefined): PhotoProvider | null {
  const name = env('PHOTO_SEARCH_PROVIDER')?.trim().toLowerCase() || DEFAULT_PHOTO_PROVIDER;
  const entry = PROVIDERS[name];
  if (!entry) {
    console.error(`photo-search: unknown PHOTO_SEARCH_PROVIDER "${name}"`);
    return null;
  }
  const apiKey = env(entry.keyVar)?.trim();
  return apiKey ? entry.make({ apiKey }) : null;
}
