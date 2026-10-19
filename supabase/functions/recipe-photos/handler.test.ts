// recipe-photos (spec 6.9) end to end over the real fetchPage, with fake DNS, a fake fetch and a
// fake limit store: the happy path, blocked and bad URLs, fetch failures and the rate limit.
import { assertEquals } from '@std/assert';

import { fetchPage } from '../_shared/fetch-page.ts';
import type { LimitResult } from '../categorize-ingredients/handler.ts';
import { recipePhotos, type RecipePhotosDeps } from './handler.ts';
import { handleRequest } from './request.ts';

const ENDPOINT = 'http://localhost/functions/v1/recipe-photos';

const BREAD_URL = 'https://snacks.example.com/blueberry-bread/';
const BREAD_PAGE = `<html><head><title>Blueberry bread</title>
<meta property="og:image" content="https://snacks.example.com/img/bread-og.png">
<meta name="twitter:image" content="/img/bread-twitter.jpg">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
  {"@type":"WebPage","@id":"${BREAD_URL}#webpage","primaryImageOfPage":{"@id":"${BREAD_URL}#primaryimage"}},
  {"@type":"ImageObject","@id":"${BREAD_URL}#primaryimage","url":"https://snacks.example.com/img/bread-hero.jpg"}
]}</script></head>
<body><header><img src="/logo.png" class="site-logo"></header>
<article><img src="/a.png" class="avatar" width="48"><img data-src="/img/bread-slice.jpg" width="1200"></article></body></html>`;

const PLAIN_URL = 'https://plain.example.com/notes';
const PLAIN_PAGE = '<html><head><title>Notes</title></head><body><p>No photos here.</p><img src="/icon.svg"></body></html>';

const DNS: Record<string, string[]> = {
  'snacks.example.com': ['93.184.216.34'],
  'plain.example.com': ['93.184.216.35'],
  'missing.example.com': ['93.184.216.36'],
  'pdf.example.com': ['93.184.216.37'],
  'redirect.example.com': ['93.184.216.38'],
  'intranet.example.com': ['10.0.0.5'],
};

/** Counts calls; answers `limits` in turn (then 'ok'). */
class FakeLimitStore {
  calls = 0;
  constructor(private readonly limits: LimitResult[] = []) {}
  checkLimit(): Promise<LimitResult> {
    return Promise.resolve(this.limits[this.calls++] ?? 'ok');
  }
}

function setup(limits: LimitResult[] = []) {
  const store = new FakeLimitStore(limits);
  const fetched: string[] = [];
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    fetched.push(url);
    if (url === 'https://redirect.example.com/r') {
      return new Response(null, { status: 302, headers: { location: 'https://intranet.example.com/admin' } });
    }
    if (url === 'https://pdf.example.com/recipe.pdf') {
      return new Response('%PDF', { headers: { 'content-type': 'application/pdf' } });
    }
    const html = url === BREAD_URL ? BREAD_PAGE : url === PLAIN_URL ? PLAIN_PAGE : undefined;
    if (html === undefined) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/html' } });
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }) as typeof fetch;
  const deps: RecipePhotosDeps = {
    store,
    fetchPage: (url) => fetchPage(url, { resolve: async (host) => DNS[host] ?? [], fetch: fakeFetch }),
  };
  const post = (body: unknown) =>
    handleRequest(
      new Request(ENDPOINT, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      { recipePhotos: (request) => recipePhotos(request, deps) },
    );
  return { store, fetched, post };
}

async function expectError(res: Response, status: number, code: string) {
  assertEquals(res.status, status);
  assertEquals((await res.json()).error, code);
}

Deno.test('happy path: the page photos in readImageCandidates order, resolved, logos and avatars skipped', async () => {
  const { post, store, fetched } = setup();
  const res = await post({ url: BREAD_URL });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    images: [
      'https://snacks.example.com/img/bread-hero.jpg',
      'https://snacks.example.com/img/bread-og.png',
      'https://snacks.example.com/img/bread-twitter.jpg',
      'https://snacks.example.com/img/bread-slice.jpg',
    ],
  });
  assertEquals(store.calls, 1);
  assertEquals(fetched, [BREAD_URL]);
});

Deno.test('a page without usable photos answers an empty list, not an error', async () => {
  const { post } = setup();
  const res = await post({ url: PLAIN_URL });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { images: [] });
});

Deno.test('a URL to a private address is invalid_url, and nothing is fetched', async () => {
  const { post, fetched } = setup();
  await expectError(await post({ url: 'https://intranet.example.com/recipe' }), 400, 'invalid_url');
  assertEquals(fetched, []);
});

Deno.test('a redirect to a private address is invalid_url, and the private page is never fetched', async () => {
  const { post, fetched } = setup();
  await expectError(await post({ url: 'https://redirect.example.com/r' }), 400, 'invalid_url');
  assertEquals(fetched, ['https://redirect.example.com/r']);
});

Deno.test('a URL that is not http(s) is invalid_url before the limit is counted', async () => {
  const { post, store, fetched } = setup();
  for (const url of ['ftp://snacks.example.com/bread', 'javascript:alert(1)', 'not a url', '']) {
    await expectError(await post({ url }), 400, 'invalid_url');
  }
  assertEquals(store.calls, 0);
  assertEquals(fetched, []);
});

Deno.test('fetch failures are fetch_failed: a 404, a page that is not HTML, a host that does not resolve', async () => {
  const { post } = setup();
  await expectError(await post({ url: 'https://missing.example.com/gone' }), 502, 'fetch_failed');
  await expectError(await post({ url: 'https://pdf.example.com/recipe.pdf' }), 502, 'fetch_failed');
  await expectError(await post({ url: 'https://nowhere.example.org/x' }), 502, 'fetch_failed');
});

Deno.test('rate limit: the per-user limit is 429 and the page is not fetched; the next allowed request works', async () => {
  const { post, store, fetched } = setup(['user_limit']);
  await expectError(await post({ url: BREAD_URL }), 429, 'rate_limited');
  assertEquals(fetched, []);
  const res = await post({ url: BREAD_URL });
  assertEquals(res.status, 200);
  assertEquals(store.calls, 2);
});
