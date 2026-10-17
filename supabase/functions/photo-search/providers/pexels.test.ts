// The Pexels provider (not the default; see pexels.ts): the request, the mapping, bad photos
// dropped, hasMore and its errors, over a fake Pexels. The handler's own behaviour is tested over
// the default provider in ../handler.test.ts.
import { assertEquals, assertRejects } from '@std/assert';

import { PEXELS_SEARCH_URL, pexelsProvider } from './pexels.ts';
import { PhotoProviderError } from './types.ts';

const KEY = 'test-pexels-key';

/** A Pexels photo as the API returns it. */
function pexelsPhoto(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    width: 6000,
    height: 4000,
    url: `https://www.pexels.com/photo/lemon-cake-${id}/`,
    photographer: 'Jane Doe',
    photographer_url: 'https://www.pexels.com/@jane-doe',
    photographer_id: 77,
    src: {
      original: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg`,
      large2x: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?w=1880`,
      medium: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?h=350`,
    },
    alt: 'Lemon cake on a white plate',
    ...overrides,
  };
}

function pexelsPage(photos: unknown[], page = 1, nextPage = true) {
  return {
    page,
    per_page: 20,
    photos,
    ...(nextPage ? { next_page: `https://api.pexels.com/v1/search/?page=${page + 1}` } : {}),
  };
}

function setup(answer: Response | 'network_error' = Response.json(pexelsPage([pexelsPhoto(1)]))) {
  const calls: { url: URL; auth: string | null }[] = [];
  const fakeFetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), auth: new Headers(init?.headers).get('authorization') });
    if (answer === 'network_error') return Promise.reject(new TypeError('connection refused'));
    return Promise.resolve(answer.clone());
  }) as typeof fetch;
  return { calls, provider: pexelsProvider({ apiKey: KEY, fetch: fakeFetch, timeoutMs: 50 }) };
}

Deno.test('Pexels: names itself, sends the key as the Authorization header, and maps a photo', async () => {
  const { provider, calls } = setup();
  assertEquals(provider.id, 'pexels');
  assertEquals(provider.info, { name: 'Pexels', url: 'https://www.pexels.com' });
  assertEquals(await provider.search('lemon cake', 2, 'es'), {
    photos: [
      {
        id: '1',
        thumb: 'https://images.pexels.com/photos/1/pexels-photo-1.jpeg?h=350',
        full: 'https://images.pexels.com/photos/1/pexels-photo-1.jpeg?w=1880',
        width: 6000,
        height: 4000,
        author: 'Jane Doe',
        authorUrl: 'https://www.pexels.com/@jane-doe',
        pageUrl: 'https://www.pexels.com/photo/lemon-cake-1/',
        alt: 'Lemon cake on a white plate',
      },
    ],
    hasMore: true,
  });
  assertEquals(calls[0].auth, KEY);
  assertEquals(`${calls[0].url.origin}${calls[0].url.pathname}`, PEXELS_SEARCH_URL);
  assertEquals(Object.fromEntries(calls[0].url.searchParams), {
    query: 'lemon cake',
    page: '2',
    per_page: '20',
    orientation: 'landscape',
  });
});

Deno.test('Pexels: photos with a non-https URL or a missing field are dropped; an empty alt is null', async () => {
  const { provider } = setup(
    Response.json(
      pexelsPage([
        pexelsPhoto(1),
        pexelsPhoto(2, { url: 'http://www.pexels.com/photo/2/' }),
        pexelsPhoto(3, { photographer_url: 'http://www.pexels.com/@someone' }),
        pexelsPhoto(4, { src: { ...pexelsPhoto(4).src, medium: 'http://images.pexels.com/4.jpeg' } }),
        pexelsPhoto(5, { src: undefined }),
        pexelsPhoto(6, { photographer: '   ' }),
        pexelsPhoto(7, { width: 0 }),
        pexelsPhoto(8, { alt: '' }),
        null,
      ]),
    ),
  );
  const { photos } = await provider.search('cake', 1, 'en');
  assertEquals(
    photos.map((p) => p.id),
    ['1', '8'],
  );
  assertEquals(photos[1].alt, null);
});

Deno.test('Pexels: hasMore follows next_page, and is false on page 10', async () => {
  assertEquals((await setup(Response.json(pexelsPage([], 1, false))).provider.search('cake', 1, 'en')).hasMore, false);
  assertEquals((await setup(Response.json(pexelsPage([], 9))).provider.search('cake', 9, 'en')).hasMore, true);
  assertEquals((await setup(Response.json(pexelsPage([], 10))).provider.search('cake', 10, 'en')).hasMore, false);
});

Deno.test('Pexels: 429 is rate_limited; another status, a network error or no photos array is failed', async () => {
  const reason = async (answer: Response | 'network_error') =>
    (await assertRejects(() => setup(answer).provider.search('cake', 1, 'en'), PhotoProviderError)).reason;
  assertEquals(await reason(new Response('', { status: 429 })), 'rate_limited');
  assertEquals(await reason(new Response('', { status: 500 })), 'failed');
  assertEquals(await reason('network_error'), 'failed');
  assertEquals(await reason(Response.json({ error: 'nope' })), 'failed');
});
