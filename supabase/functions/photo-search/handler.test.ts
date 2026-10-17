// photo-search (spec 6.11) end to end over the default provider's real client (Pixabay), with a
// fake Pixabay and a fake store: the mapping, bad photos dropped, hasMore, the language, the cache,
// each error and no provider. The other providers' mappings are tested next to them (providers/).
import type { PhotoSearchResponse } from '@shared/index.ts';
import { assertEquals } from '@std/assert';

import type { LimitResult } from '../categorize-ingredients/handler.ts';
import { photoSearch, photoSearchCacheKey, type PhotoSearchStore } from './handler.ts';
import type { PhotoProvider } from './providers/index.ts';
import { PIXABAY_SEARCH_URL, pixabayProvider } from './providers/pixabay.ts';
import { handleRequest, PAUSED_RETRY_AFTER } from './request.ts';

const ENDPOINT = 'http://localhost/functions/v1/photo-search';
const KEY = 'test-pixabay-key';
const PIXABAY = { name: 'Pixabay', url: 'https://pixabay.com' };

/** A Pixabay hit as the API returns it. */
function pixabayHit(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    pageURL: `https://pixabay.com/photos/lemon-cake-dessert-${id}/`,
    type: 'photo',
    tags: 'lemon cake, dessert, baking',
    previewURL: `https://cdn.pixabay.com/photo/2026/01/01/00/00/lemon-cake-${id}_150.jpg`,
    webformatURL: `https://pixabay.com/get/g${id}_640.jpg`,
    largeImageURL: `https://pixabay.com/get/g${id}_1280.jpg`,
    imageWidth: 6000,
    imageHeight: 4000,
    views: 100,
    downloads: 10,
    likes: 1,
    user_id: 77,
    user: 'JaneDoe',
    userImageURL: 'https://cdn.pixabay.com/user/2026/01/01/jane_250x250.jpg',
    ...overrides,
  };
}

function pixabayPage(hits: unknown[], totalHits = 500) {
  return { total: totalHits * 2, totalHits, hits };
}

class FakeStore implements PhotoSearchStore {
  limitCalls: boolean[] = [];
  cache = new Map<string, PhotoSearchResponse>();
  saves: string[] = [];
  constructor(
    private readonly limits: LimitResult[] = [],
    private readonly failSave = false,
  ) {}
  checkLimit(cached: boolean): Promise<LimitResult> {
    const result = this.limits[this.limitCalls.length] ?? 'ok';
    this.limitCalls.push(cached);
    return Promise.resolve(result);
  }
  getCached(queryKey: string, page: number) {
    return Promise.resolve(this.cache.get(`${queryKey}#${page}`) ?? null);
  }
  saveCached(queryKey: string, page: number, answer: PhotoSearchResponse) {
    if (this.failSave) return Promise.reject(new Error('db down'));
    this.saves.push(`${queryKey}#${page}`);
    this.cache.set(`${queryKey}#${page}`, answer);
    return Promise.resolve();
  }
}

type FakeAnswer = Response | (() => Promise<Response>) | 'network_error' | 'hang';

function setup(
  answer: FakeAnswer = Response.json(pixabayPage([pixabayHit(1)])),
  opts: { limits?: LimitResult[]; noProvider?: boolean; failSave?: boolean; store?: FakeStore } = {},
) {
  const store = opts.store ?? new FakeStore(opts.limits, opts.failSave);
  const calls: URL[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(new URL(String(input)));
    if (answer === 'network_error') throw new TypeError('connection refused');
    if (answer === 'hang') {
      return await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    }
    return typeof answer === 'function' ? answer() : answer.clone();
  }) as typeof fetch;
  const provider = opts.noProvider ? null : pixabayProvider({ apiKey: KEY, fetch: fakeFetch, timeoutMs: 50 });
  const post = (body: unknown) =>
    handleRequest(
      new Request(ENDPOINT, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      { photoSearch: (request) => photoSearch(request, { store, provider }) },
    );
  return { store, calls, post };
}

async function expectError(res: Response, status: number, code: string) {
  assertEquals(res.status, status);
  assertEquals((await res.json()).error, code);
}

Deno.test('happy path: Pixabay hits mapped to PhotoSearchResult, named as the provider, the key sent from the server', async () => {
  const { post, calls, store } = setup();
  const res = await post({ query: 'Lemon cake' });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    provider: PIXABAY,
    photos: [
      {
        id: '1',
        thumb: 'https://pixabay.com/get/g1_640.jpg',
        full: 'https://pixabay.com/get/g1_1280.jpg',
        width: 6000,
        height: 4000,
        author: 'JaneDoe',
        authorUrl: 'https://pixabay.com/users/JaneDoe-77/',
        pageUrl: 'https://pixabay.com/photos/lemon-cake-dessert-1/',
        alt: 'lemon cake, dessert, baking',
      },
    ],
    hasMore: true,
  });
  assertEquals(calls.length, 1);
  assertEquals(`${calls[0].origin}${calls[0].pathname}`, PIXABAY_SEARCH_URL);
  assertEquals(Object.fromEntries(calls[0].searchParams), {
    key: KEY,
    q: 'lemon cake',
    lang: 'en',
    image_type: 'photo',
    orientation: 'horizontal',
    safesearch: 'true',
    page: '1',
    per_page: '20',
  });
  assertEquals(store.limitCalls, [false]);
  assertEquals(store.saves, ['pixabay:en:lemon cake#1']);
});

Deno.test('the page and language are passed through, and the query is normalised', async () => {
  const { post, calls, store } = setup();
  assertEquals((await post({ query: '  Pollo \t ASADO\n ', page: 4, lang: 'es' })).status, 200);
  assertEquals(calls[0].searchParams.get('q'), 'pollo asado');
  assertEquals(calls[0].searchParams.get('page'), '4');
  assertEquals(calls[0].searchParams.get('lang'), 'es');
  assertEquals(store.saves, ['pixabay:es:pollo asado#4']);
});

Deno.test('a language Pixabay does not search in is sent as English, but cached under its own', async () => {
  const { post, calls, store } = setup();
  await post({ query: 'cake', lang: 'xx' });
  assertEquals(calls[0].searchParams.get('lang'), 'en');
  assertEquals(store.saves, ['pixabay:xx:cake#1']);
});

Deno.test('hits whose URLs are not https, or that miss a field, are dropped; no tags is a null alt', async () => {
  const { post } = setup(
    Response.json(
      pixabayPage([
        pixabayHit(1),
        pixabayHit(2, { pageURL: 'http://pixabay.com/photos/2/' }),
        pixabayHit(3, { webformatURL: 'http://pixabay.com/get/3_640.jpg' }),
        pixabayHit(4, { largeImageURL: 'ftp://pixabay.com/get/4_1280.jpg' }),
        pixabayHit(5, { largeImageURL: undefined }),
        pixabayHit(6, { user: '   ' }),
        pixabayHit(7, { user: 'x'.repeat(201) }),
        pixabayHit(8, { user_id: undefined }),
        pixabayHit(9, { imageWidth: 0 }),
        pixabayHit(10, { id: null }),
        pixabayHit(11, { tags: '' }),
        pixabayHit(12, { tags: undefined, user: '  Sam Lee ', user_id: 5 }),
        'not a hit',
        null,
      ]),
    ),
  );
  const body = await (await post({ query: 'cake' })).json();
  assertEquals(
    body.photos.map((p: { id: string }) => p.id),
    ['1', '11', '12'],
  );
  assertEquals(body.photos[1].alt, null);
  assertEquals(body.photos[2].author, 'Sam Lee');
  assertEquals(body.photos[2].authorUrl, 'https://pixabay.com/users/Sam%20Lee-5/');
});

Deno.test('hasMore while totalHits goes past this page, and false on page 10 even when Pixabay has more', async () => {
  const more = async (totalHits: number, page: number) =>
    (await (await setup(Response.json(pixabayPage([pixabayHit(1)], totalHits))).post({ query: 'cake', page })).json()).hasMore;
  assertEquals(await more(20, 1), false);
  assertEquals(await more(21, 1), true);
  assertEquals(await more(500, 9), true);
  assertEquals(await more(500, 10), false);
});

Deno.test('no results is 200 with no photos, and is cached', async () => {
  const { post, store } = setup(Response.json(pixabayPage([], 0)));
  const res = await post({ query: 'zzzzqx' });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { provider: PIXABAY, photos: [], hasMore: false });
  assertEquals(store.saves, ['pixabay:en:zzzzqx#1']);
});

Deno.test('a repeat search is answered from the cache: Pixabay is not called, and the global cap is not counted', async () => {
  const { post, calls, store } = setup();
  const first = await (await post({ query: 'Lemon cake' })).json();
  const second = await post({ query: 'lemon   CAKE' });
  assertEquals(second.status, 200);
  assertEquals(await second.json(), first);
  assertEquals(calls.length, 1);
  assertEquals(store.limitCalls, [false, true]);
});

Deno.test('another page or language of the same search is not a cache hit', async () => {
  const { post, calls } = setup();
  await post({ query: 'cake' });
  await post({ query: 'cake', page: 2 });
  await post({ query: 'cake', lang: 'es' });
  assertEquals(calls.length, 3);
});

Deno.test('another provider never answers from the first one’s cache', async () => {
  const store = new FakeStore();
  await setup(undefined, { store }).post({ query: 'cake' });
  let searched = 0;
  const other: PhotoProvider = {
    id: 'other',
    info: { name: 'Other', url: 'https://other.example' },
    search: () => {
      searched++;
      return Promise.resolve({ photos: [], hasMore: false });
    },
  };
  const res = await photoSearch({ query: 'cake', page: 1, lang: 'en' }, { store, provider: other });
  assertEquals(searched, 1);
  assertEquals(res.provider, other.info);
  assertEquals(store.saves, ['pixabay:en:cake#1', 'other:en:cake#1']);
});

Deno.test('photoSearchCacheKey: provider, language and the normalised query', () => {
  assertEquals(photoSearchCacheKey('pixabay', 'es', '  Pollo   ASADO '), 'pixabay:es:pollo asado');
});

Deno.test('a cache hit still counts against the user: rate_limited, and nothing is answered', async () => {
  const { post, calls, store } = setup(undefined, { limits: ['ok', 'user_limit'] });
  await post({ query: 'cake' });
  await expectError(await post({ query: 'cake' }), 429, 'rate_limited');
  assertEquals(store.limitCalls, [false, true]);
  assertEquals(calls.length, 1);
});

Deno.test('the per-user limit is 429 rate_limited, and the provider is not called', async () => {
  const { post, calls } = setup(undefined, { limits: ['user_limit'] });
  await expectError(await post({ query: 'cake' }), 429, 'rate_limited');
  assertEquals(calls.length, 0);
});

Deno.test('the global cap is 503 unavailable with Retry-After, and the provider is not called', async () => {
  const { post, calls } = setup(undefined, { limits: ['global_cap'] });
  const res = await post({ query: 'cake' });
  assertEquals(res.headers.get('Retry-After'), String(PAUSED_RETRY_AFTER));
  await expectError(res, 503, 'unavailable');
  assertEquals(calls.length, 0);
});

Deno.test('no provider (unknown, or no key) is 503 unavailable before anything is read or counted', async () => {
  const { post, store } = setup(undefined, { noProvider: true });
  const res = await post({ query: 'cake' });
  assertEquals(res.headers.get('Retry-After'), String(PAUSED_RETRY_AFTER));
  await expectError(res, 503, 'unavailable');
  assertEquals(store.limitCalls, []);
});

Deno.test('the provider answering 429 is 503 unavailable with Retry-After, and nothing is cached', async () => {
  const { post, store } = setup(new Response('Too many', { status: 429 }));
  const res = await post({ query: 'cake' });
  assertEquals(res.headers.get('Retry-After'), String(PAUSED_RETRY_AFTER));
  await expectError(res, 503, 'unavailable');
  assertEquals(store.saves, []);
});

Deno.test('the provider failing is 502 search_failed: an error status, a network error, bad JSON, no hits array', async () => {
  for (const answer of [
    new Response('oops', { status: 500 }),
    new Response('[ERROR 400] "key" is invalid', { status: 400 }),
    'network_error' as const,
    new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    Response.json({ error: 'nope' }),
  ]) {
    const { post, store } = setup(answer);
    await expectError(await post({ query: 'cake' }), 502, 'search_failed');
    assertEquals(store.saves, []);
  }
});

Deno.test('the provider not answering within the timeout is 502 search_failed', async () => {
  const { post, calls } = setup('hang');
  await expectError(await post({ query: 'cake' }), 502, 'search_failed');
  assertEquals(calls.length, 1);
});

Deno.test('a failure to save the cache still answers the search', async () => {
  const { post } = setup(undefined, { failSave: true });
  const res = await post({ query: 'cake' });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).photos.length, 1);
});

Deno.test('a bad query, page or language is 400 invalid_request before the limit is counted', async () => {
  const { post, store, calls } = setup();
  for (const body of [{}, { query: '' }, { query: '   ' }, { query: 'a'.repeat(101) }, { query: 'cake', page: 0 }, { query: 'cake', page: 11 }, {
    query: 'cake',
    page: 1.5,
  }, { query: 'cake', page: '2' }, { query: 42 }, { query: 'cake', lang: 'ES' }, { query: 'cake', lang: 'spa' }, { query: 'cake', lang: 2 }]) {
    await expectError(await post(body), 400, 'invalid_request');
  }
  assertEquals(store.limitCalls, []);
  assertEquals(calls.length, 0);
});
