// photo-search (spec 6.11) end to end over the real Pexels client, with a fake Pexels and a fake
// store: the mapping, non-https photos dropped, hasMore, the cache, each error and no key.
import type { PhotoSearchResponse } from '@shared/index.ts';
import { assertEquals } from '@std/assert';

import type { LimitResult } from '../categorize-ingredients/handler.ts';
import { photoSearch, type PhotoSearchStore } from './handler.ts';
import { PEXELS_SEARCH_URL, searchPexels } from './pexels.ts';
import { handleRequest, PAUSED_RETRY_AFTER } from './request.ts';

const ENDPOINT = 'http://localhost/functions/v1/photo-search';
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
    avg_color: '#C8B49A',
    src: {
      original: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg`,
      large2x: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940`,
      large: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&h=650&w=940`,
      medium: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&h=350`,
      small: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&h=130`,
      tiny: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&dpr=1&fit=crop&h=200&w=280`,
    },
    liked: false,
    alt: 'Lemon cake on a white plate',
    ...overrides,
  };
}

function pexelsPage(photos: unknown[], page = 1, nextPage = true) {
  return {
    page,
    per_page: 20,
    total_results: 1000,
    photos,
    ...(nextPage ? { next_page: `https://api.pexels.com/v1/search/?page=${page + 1}&per_page=20&query=lemon+cake` } : {}),
  };
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
  answer: FakeAnswer = Response.json(pexelsPage([pexelsPhoto(1)])),
  opts: { limits?: LimitResult[]; noKey?: boolean; failSave?: boolean } = {},
) {
  const store = new FakeStore(opts.limits, opts.failSave);
  const calls: { url: URL; auth: string | null }[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), auth: new Headers(init?.headers).get('authorization') });
    if (answer === 'network_error') throw new TypeError('connection refused');
    if (answer === 'hang') {
      return await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    }
    return typeof answer === 'function' ? answer() : answer.clone();
  }) as typeof fetch;
  const search = opts.noKey
    ? null
    : (query: string, page: number) => searchPexels(query, page, { apiKey: KEY, fetch: fakeFetch, timeoutMs: 50 });
  const post = (body: unknown) =>
    handleRequest(
      new Request(ENDPOINT, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      { photoSearch: (request) => photoSearch(request, { store, searchPexels: search }) },
    );
  return { store, calls, post };
}

async function expectError(res: Response, status: number, code: string) {
  assertEquals(res.status, status);
  assertEquals((await res.json()).error, code);
}

Deno.test('happy path: Pexels photos mapped to PhotoSearchResult, with the key sent from the server', async () => {
  const { post, calls, store } = setup();
  const res = await post({ query: 'Lemon cake' });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    photos: [
      {
        id: 1,
        thumb: 'https://images.pexels.com/photos/1/pexels-photo-1.jpeg?auto=compress&cs=tinysrgb&h=350',
        full: 'https://images.pexels.com/photos/1/pexels-photo-1.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940',
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
  assertEquals(calls.length, 1);
  assertEquals(calls[0].auth, KEY);
  assertEquals(`${calls[0].url.origin}${calls[0].url.pathname}`, PEXELS_SEARCH_URL);
  assertEquals(Object.fromEntries(calls[0].url.searchParams), {
    query: 'lemon cake',
    page: '1',
    per_page: '20',
    orientation: 'landscape',
  });
  assertEquals(store.limitCalls, [false]);
  assertEquals(store.saves, ['lemon cake#1']);
});

Deno.test('the page is passed through, and the query is sent as its cache key', async () => {
  const { post, calls, store } = setup(Response.json(pexelsPage([pexelsPhoto(9)], 4)));
  assertEquals((await post({ query: '  Roast \t CHICKEN\n thighs ', page: 4 })).status, 200);
  assertEquals(calls[0].url.searchParams.get('query'), 'roast chicken thighs');
  assertEquals(calls[0].url.searchParams.get('page'), '4');
  assertEquals(store.saves, ['roast chicken thighs#4']);
});

Deno.test('photos whose URLs are not https, or that miss a field, are dropped; an empty alt is null', async () => {
  const { post } = setup(
    Response.json(
      pexelsPage([
        pexelsPhoto(1),
        pexelsPhoto(2, { url: 'http://www.pexels.com/photo/2/' }),
        pexelsPhoto(3, { photographer_url: 'http://www.pexels.com/@someone' }),
        pexelsPhoto(4, { src: { ...pexelsPhoto(4).src, medium: 'http://images.pexels.com/4.jpeg' } }),
        pexelsPhoto(5, { src: { ...pexelsPhoto(5).src, large2x: 'ftp://images.pexels.com/5.jpeg' } }),
        pexelsPhoto(6, { src: undefined }),
        pexelsPhoto(7, { photographer: '   ' }),
        pexelsPhoto(8, { photographer: 'x'.repeat(201) }),
        pexelsPhoto(9, { width: 0 }),
        pexelsPhoto(10, { id: 'ten' }),
        pexelsPhoto(11, { alt: '' }),
        pexelsPhoto(12, { alt: null, photographer: '  Sam Lee ' }),
        'not a photo',
        null,
      ]),
    ),
  );
  const body = await (await post({ query: 'cake' })).json();
  assertEquals(
    body.photos.map((p: { id: number }) => p.id),
    [1, 11, 12],
  );
  assertEquals(body.photos[1].alt, null);
  assertEquals(body.photos[2].alt, null);
  assertEquals(body.photos[2].author, 'Sam Lee');
});

Deno.test('hasMore follows next_page, and is false on page 10 even when Pexels has more', async () => {
  assertEquals((await (await setup(Response.json(pexelsPage([pexelsPhoto(1)], 1, false))).post({ query: 'cake' })).json()).hasMore, false);
  assertEquals((await (await setup(Response.json(pexelsPage([pexelsPhoto(1)], 9, true))).post({ query: 'cake', page: 9 })).json()).hasMore, true);
  assertEquals((await (await setup(Response.json(pexelsPage([pexelsPhoto(1)], 10, true))).post({ query: 'cake', page: 10 })).json()).hasMore, false);
});

Deno.test('no results is 200 with no photos, and is cached', async () => {
  const { post, store } = setup(Response.json({ page: 1, per_page: 20, total_results: 0, photos: [] }));
  const res = await post({ query: 'zzzzqx' });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { photos: [], hasMore: false });
  assertEquals(store.saves, ['zzzzqx#1']);
});

Deno.test('a repeat search is answered from the cache: Pexels is not called, and the global cap is not counted', async () => {
  const { post, calls, store } = setup();
  const first = await (await post({ query: 'Lemon cake' })).json();
  const second = await post({ query: 'lemon   CAKE' });
  assertEquals(second.status, 200);
  assertEquals(await second.json(), first);
  assertEquals(calls.length, 1);
  assertEquals(store.limitCalls, [false, true]);
});

Deno.test('another page of the same search is not a cache hit', async () => {
  const { post, calls } = setup();
  await post({ query: 'cake' });
  await post({ query: 'cake', page: 2 });
  assertEquals(calls.length, 2);
});

Deno.test('a cache hit still counts against the user: rate_limited, and nothing is answered', async () => {
  const { post, calls, store } = setup(undefined, { limits: ['ok', 'user_limit'] });
  await post({ query: 'cake' });
  await expectError(await post({ query: 'cake' }), 429, 'rate_limited');
  assertEquals(store.limitCalls, [false, true]);
  assertEquals(calls.length, 1);
});

Deno.test('the per-user limit is 429 rate_limited, and Pexels is not called', async () => {
  const { post, calls } = setup(undefined, { limits: ['user_limit'] });
  await expectError(await post({ query: 'cake' }), 429, 'rate_limited');
  assertEquals(calls.length, 0);
});

Deno.test('the global cap is 503 unavailable with Retry-After, and Pexels is not called', async () => {
  const { post, calls } = setup(undefined, { limits: ['global_cap'] });
  const res = await post({ query: 'cake' });
  assertEquals(res.headers.get('Retry-After'), String(PAUSED_RETRY_AFTER));
  await expectError(res, 503, 'unavailable');
  assertEquals(calls.length, 0);
});

Deno.test('no key is 503 unavailable before anything is read or counted', async () => {
  const { post, store } = setup(undefined, { noKey: true });
  const res = await post({ query: 'cake' });
  assertEquals(res.headers.get('Retry-After'), String(PAUSED_RETRY_AFTER));
  await expectError(res, 503, 'unavailable');
  assertEquals(store.limitCalls, []);
});

Deno.test('Pexels answering 429 is 503 unavailable with Retry-After, and nothing is cached', async () => {
  const { post, store } = setup(new Response('Too many', { status: 429 }));
  const res = await post({ query: 'cake' });
  assertEquals(res.headers.get('Retry-After'), String(PAUSED_RETRY_AFTER));
  await expectError(res, 503, 'unavailable');
  assertEquals(store.saves, []);
});

Deno.test('Pexels failing is 502 search_failed: an error status, a network error, bad JSON, no photos array', async () => {
  for (const answer of [
    new Response('oops', { status: 500 }),
    new Response('no', { status: 401 }),
    'network_error' as const,
    new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    Response.json({ error: 'nope' }),
  ]) {
    const { post, store } = setup(answer);
    await expectError(await post({ query: 'cake' }), 502, 'search_failed');
    assertEquals(store.saves, []);
  }
});

Deno.test('Pexels not answering within the timeout is 502 search_failed', async () => {
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

Deno.test('a bad query or page is 400 invalid_request before the limit is counted', async () => {
  const { post, store, calls } = setup();
  for (const body of [{}, { query: '' }, { query: '   ' }, { query: 'a'.repeat(101) }, { query: 'cake', page: 0 }, { query: 'cake', page: 11 }, {
    query: 'cake',
    page: 1.5,
  }, { query: 'cake', page: '2' }, { query: 42 }]) {
    await expectError(await post(body), 400, 'invalid_request');
  }
  assertEquals(store.limitCalls, []);
  assertEquals(calls.length, 0);
});
