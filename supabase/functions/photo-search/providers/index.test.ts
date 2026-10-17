import { assertEquals } from '@std/assert';

import { photoProviderFromEnv } from './index.ts';

const env = (vars: Record<string, string>) => (name: string) => vars[name];

Deno.test('PHOTO_SEARCH_PROVIDER unset is Pixabay, with PIXABAY_API_KEY', () => {
  assertEquals(photoProviderFromEnv(env({ PIXABAY_API_KEY: 'k' }))?.id, 'pixabay');
});

Deno.test('PHOTO_SEARCH_PROVIDER picks the provider, any case, with its own key', () => {
  assertEquals(photoProviderFromEnv(env({ PHOTO_SEARCH_PROVIDER: ' Pexels ', PEXELS_API_KEY: 'k' }))?.id, 'pexels');
  assertEquals(photoProviderFromEnv(env({ PHOTO_SEARCH_PROVIDER: 'pexels', PIXABAY_API_KEY: 'k' })), null);
});

Deno.test('no key, a blank key, or an unknown provider is null', () => {
  assertEquals(photoProviderFromEnv(env({})), null);
  assertEquals(photoProviderFromEnv(env({ PIXABAY_API_KEY: '  ' })), null);
  assertEquals(photoProviderFromEnv(env({ PHOTO_SEARCH_PROVIDER: 'flickr', PIXABAY_API_KEY: 'k' })), null);
});
