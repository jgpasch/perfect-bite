// Run from this folder: deno test --allow-read fetch-page.test.ts
// `_shared/` has no import map, so @std/assert is imported by its jsr: specifier.
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';

import {
  FETCH_TIMEOUT_MS,
  fetchPage,
  FetchPageError,
  isBlockedAddress,
  MAX_BODY_BYTES,
  MAX_TEXT_CHARS,
  readPage,
  type FetchPageFailure,
  type ResolveHost,
} from './fetch-page.ts';

const PUBLIC_IP = '93.184.216.34';

type Call = { url: string; init: RequestInit | undefined };

/** A fetch that answers from `routes` by URL and records every call. */
function fakeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return Promise.resolve(route());
  }) as typeof fetch;
  return { fn, calls };
}

/** A resolver answering from `hosts` (anything else is public) and recording every lookup. */
function fakeResolve(hosts: Record<string, string[]> = {}) {
  const lookups: string[] = [];
  const fn: ResolveHost = (hostname) => {
    lookups.push(hostname);
    return Promise.resolve(hosts[hostname] ?? [PUBLIC_IP]);
  };
  return { fn, lookups };
}

function html(body: BodyInit | null, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

async function assertFails(promise: Promise<unknown>, reason: FetchPageFailure): Promise<void> {
  const error = await assertRejects(() => promise, FetchPageError);
  assertEquals(error.reason, reason);
}

const PAGE = '<html><head><title>Soup</title></head><body><p>Hello</p></body></html>';

// --- Addresses ---

Deno.test('isBlockedAddress refuses private, loopback, link-local and metadata IPv4', () => {
  for (const address of [
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '169.254.0.1',
    '100.64.0.1',
    '100.100.100.200',
    '0.0.0.0',
    '192.0.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
  ]) {
    assertEquals(isBlockedAddress(address), true, address);
  }
});

Deno.test('isBlockedAddress allows public IPv4, including just outside the private ranges', () => {
  for (const address of [PUBLIC_IP, '8.8.8.8', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '11.0.0.1', '169.253.255.255']) {
    assertEquals(isBlockedAddress(address), false, address);
  }
});

Deno.test('isBlockedAddress refuses private, loopback, link-local and metadata IPv6', () => {
  for (const address of [
    '::1',
    '::',
    '0:0:0:0:0:0:0:1',
    'fe80::1',
    'fe80::1%en0',
    'febf:ffff::1',
    'fec0::1',
    'fc00::1',
    'fd12:3456::1',
    'fd00:ec2::254',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:a9fe:a9fe',
    '::ffff:10.0.0.1',
    '::127.0.0.1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::1',
    '2002:a9fe:a9fe::1',
    '2001:db8::1',
    '100::1',
  ]) {
    assertEquals(isBlockedAddress(address), true, address);
  }
});

Deno.test('isBlockedAddress allows public IPv6, including mapped and NAT64 public IPv4', () => {
  for (const address of ['2606:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1', 'fbff::1', 'fe7f::1']) {
    assertEquals(isBlockedAddress(address), false, address);
  }
});

Deno.test('isBlockedAddress refuses anything that is not an IP address', () => {
  for (const address of ['', 'example.com', '1.2.3', '1.2.3.256', '1.2.3.4.5', '1::2::3', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7', 'gggg::1', '12345::1']) {
    assertEquals(isBlockedAddress(address), true, address);
  }
});

// --- Fetching ---

Deno.test('fetchPage returns the final URL, title, JSON-LD and text of an HTML page', async () => {
  const fetch = fakeFetch({ 'https://kitchen.example/soup': () => html(PAGE) });
  const resolve = fakeResolve();
  const page = await fetchPage('https://kitchen.example/soup', { fetch: fetch.fn, resolve: resolve.fn });
  assertEquals(page, { finalUrl: 'https://kitchen.example/soup', title: 'Soup', jsonLd: [], text: 'Hello' });
  assertEquals(resolve.lookups, ['kitchen.example']);
  const init = fetch.calls[0].init!;
  assertEquals(init.redirect, 'manual');
  assert(init.signal instanceof AbortSignal);
});

Deno.test('fetchPage refuses literal private, loopback, link-local and metadata hosts without fetching', async () => {
  for (const url of [
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://0x7f.1/',
    'http://10.0.0.5:8080/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[fd00:ec2::254]/latest/meta-data/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://localhost:54321/',
    'http://api.localhost/',
  ]) {
    const fetch = fakeFetch({});
    const resolve = fakeResolve();
    await assertFails(fetchPage(url, { fetch: fetch.fn, resolve: resolve.fn }), 'blocked_address');
    assertEquals(fetch.calls, [], url);
    assertEquals(resolve.lookups, [], url);
  }
});

Deno.test('fetchPage refuses a host whose DNS answer is private (IPv4 or IPv6), even mixed with public', async () => {
  for (const addresses of [['10.1.2.3'], ['::1'], ['fd00::1'], [PUBLIC_IP, '169.254.169.254'], ['2606:4700::1111', 'fe80::1']]) {
    const fetch = fakeFetch({});
    const resolve = fakeResolve({ 'evil.example': addresses });
    await assertFails(fetchPage('https://evil.example/recipe', { fetch: fetch.fn, resolve: resolve.fn }), 'blocked_address');
    assertEquals(fetch.calls, [], addresses.join());
  }
});

Deno.test('fetchPage refuses a redirect to a private address and never fetches it', async () => {
  for (const target of ['http://169.254.169.254/latest/meta-data/', 'http://[::1]:8080/', 'https://internal.example/']) {
    const fetch = fakeFetch({ 'https://kitchen.example/r': () => redirect(target) });
    const resolve = fakeResolve({ 'internal.example': ['192.168.0.10'] });
    await assertFails(fetchPage('https://kitchen.example/r', { fetch: fetch.fn, resolve: resolve.fn }), 'blocked_address');
    assertEquals(fetch.calls.map((c) => c.url), ['https://kitchen.example/r'], target);
  }
});

Deno.test('fetchPage re-checks DNS on every redirect hop', async () => {
  const fetch = fakeFetch({
    'https://a.example/': () => redirect('https://b.example/x', 301),
    'https://b.example/x': () => redirect('/y', 307),
    'https://b.example/y': () => html(PAGE),
  });
  const resolve = fakeResolve();
  const page = await fetchPage('https://a.example/', { fetch: fetch.fn, resolve: resolve.fn });
  assertEquals(page.finalUrl, 'https://b.example/y');
  assertEquals(resolve.lookups, ['a.example', 'b.example', 'b.example']);
});

Deno.test('fetchPage follows 5 redirects and refuses the 6th', async () => {
  const chain = (hops: number) => {
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i < hops; i++) routes[`https://kitchen.example/${i}`] = () => redirect(`https://kitchen.example/${i + 1}`);
    routes[`https://kitchen.example/${hops}`] = () => html(PAGE);
    return fakeFetch(routes);
  };
  const five = chain(5);
  const page = await fetchPage('https://kitchen.example/0', { fetch: five.fn, resolve: fakeResolve().fn });
  assertEquals(page.finalUrl, 'https://kitchen.example/5');
  assertEquals(five.calls.length, 6);

  const six = chain(6);
  await assertFails(fetchPage('https://kitchen.example/0', { fetch: six.fn, resolve: fakeResolve().fn }), 'too_many_redirects');
  assertEquals(six.calls.length, 6);
});

Deno.test('fetchPage refuses a redirect to a non-http scheme or without a Location', async () => {
  for (const location of ['file:///etc/passwd', 'ftp://kitchen.example/x', 'javascript:alert(1)']) {
    const fetch = fakeFetch({ 'https://kitchen.example/': () => redirect(location) });
    await assertFails(fetchPage('https://kitchen.example/', { fetch: fetch.fn, resolve: fakeResolve().fn }), 'invalid_url');
    assertEquals(fetch.calls.length, 1);
  }
  const fetch = fakeFetch({ 'https://kitchen.example/': () => new Response(null, { status: 302 }) });
  await assertFails(fetchPage('https://kitchen.example/', { fetch: fetch.fn, resolve: fakeResolve().fn }), 'http_status');
});

Deno.test('fetchPage refuses non-http(s) and unparseable URLs', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://kitchen.example/', 'data:text/html,<p>x</p>', 'javascript:alert(1)', 'not a url', '']) {
    const fetch = fakeFetch({});
    await assertFails(fetchPage(url, { fetch: fetch.fn, resolve: fakeResolve().fn }), 'invalid_url');
    assertEquals(fetch.calls, []);
  }
});

Deno.test('fetchPage reports a host that does not resolve', async () => {
  const empty = fakeResolve({ 'gone.example': [] });
  await assertFails(fetchPage('https://gone.example/', { fetch: fakeFetch({}).fn, resolve: empty.fn }), 'dns_failed');
  const failing: ResolveHost = () => Promise.reject(new Error('NXDOMAIN'));
  await assertFails(fetchPage('https://gone.example/', { fetch: fakeFetch({}).fn, resolve: failing }), 'dns_failed');
});

Deno.test('fetchPage refuses a non-HTML content type', async () => {
  for (const contentType of ['application/json', 'image/png', 'application/xhtml+xml', 'text/plain; charset=utf-8', 'text/htmlx', null]) {
    const headers: HeadersInit = contentType ? { 'content-type': contentType } : {};
    const fetch = fakeFetch({ 'https://kitchen.example/': () => new Response('<p>x</p>', { headers }) });
    await assertFails(fetchPage('https://kitchen.example/', { fetch: fetch.fn, resolve: fakeResolve().fn }), 'not_html');
  }
});

Deno.test('fetchPage accepts text/html in any case, and decodes the declared charset', async () => {
  const latin1 = new Uint8Array([0x3c, 0x70, 0x3e, 0x43, 0x72, 0xe8, 0x6d, 0x65, 0x3c, 0x2f, 0x70, 0x3e]); // <p>Crème</p>
  const fetch = fakeFetch({
    'https://kitchen.example/': () => new Response(latin1, { headers: { 'content-type': 'TEXT/HTML; Charset=ISO-8859-1' } }),
  });
  const page = await fetchPage('https://kitchen.example/', { fetch: fetch.fn, resolve: fakeResolve().fn });
  assertEquals(page.text, 'Crème');

  const unknown = fakeFetch({ 'https://kitchen.example/': () => html('<p>Crème</p>', { 'content-type': 'text/html; charset=nonsense' }) });
  assertEquals((await fetchPage('https://kitchen.example/', { fetch: unknown.fn, resolve: fakeResolve().fn })).text, 'Crème');
});

Deno.test('fetchPage refuses an error status', async () => {
  for (const status of [403, 404, 500]) {
    const fetch = fakeFetch({ 'https://kitchen.example/': () => html('<p>nope</p>', {}, status) });
    await assertFails(fetchPage('https://kitchen.example/', { fetch: fetch.fn, resolve: fakeResolve().fn }), 'http_status');
  }
});

/**
 * A body streamed in `chunkSize` pieces, pulled only on demand (highWaterMark 0), recording how many
 * bytes were pulled and whether the reader cancelled.
 */
function pulledBody(bytes: Uint8Array, chunkSize = 64 * 1024) {
  const state = { pulledBytes: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        if (state.pulledBytes >= bytes.byteLength) return c.close();
        const chunk = bytes.subarray(state.pulledBytes, state.pulledBytes + chunkSize);
        state.pulledBytes += chunk.byteLength;
        c.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, state };
}

const encode = (text: string) => new TextEncoder().encode(text);

/** `head`, padded with `filler` characters up to exactly `bytes` UTF-8 bytes, then `tail`. */
function padTo(head: string, bytes: number, tail: string, filler = 'x'): string {
  return head + filler.repeat(bytes - encode(head).byteLength) + tail;
}

Deno.test('fetchPage cuts a big body at 1 MB and parses what arrived', async () => {
  assertEquals(MAX_BODY_BYTES, 1024 * 1024);
  const recipe = '{"@type":"Recipe","name":"Apple cake"}';
  const top =
    `<html><head><title>Mom's apple cake</title><script type="application/ld+json">${recipe}</script></head>` +
    '<body><h1>Mom’s apple cake</h1><ul><li>6 apples</li><li>2 cups flour</li></ul>' +
    '<div id="comments"><ol class="commentlist">';
  const comment = '<li class="comment"><p>Made this twice, so good!</p></li>';
  let page = top;
  while (page.length < 1.5 * 1024 * 1024) page += comment;
  page += '</ol></div></body></html>';
  assert(encode(top).byteLength < 100 * 1024);

  const body = pulledBody(encode(page));
  const fetch = fakeFetch({ 'https://kitchen.example/': () => html(body.stream) });
  const result = await fetchPage('https://kitchen.example/', { fetch: fetch.fn, resolve: fakeResolve().fn });
  assertEquals(result.title, "Mom's apple cake");
  assertEquals(result.jsonLd, [recipe]);
  assertEquals(result.text, 'Mom’s apple cake\n6 apples\n2 cups flour');
  // Stopped at the cap: the rest of the comments were never read.
  assertEquals(body.state.cancelled, true);
  assert(body.state.pulledBytes <= MAX_BODY_BYTES + 64 * 1024, `pulled ${body.state.pulledBytes}`);
});

Deno.test('fetchPage reads the first 1 MB when Content-Length declares more', async () => {
  // The declared length is all the reader sees up front; the body really is bigger than the cap.
  const page = padTo('<html><body><p>Start of the recipe</p><p>', MAX_BODY_BYTES - 4, '</p><p>After the cut</p>');
  const body = pulledBody(encode(page + 'y'.repeat(4 * 1024 * 1024)));
  const fetch = fakeFetch({
    'https://kitchen.example/': () => html(body.stream, { 'content-length': String(5 * 1024 * 1024) }),
  });
  const result = await fetchPage('https://kitchen.example/', { fetch: fetch.fn, resolve: fakeResolve().fn });
  assert(result.text.startsWith('Start of the recipe\nxxx'), result.text.slice(0, 40));
  assert(!result.text.includes('After the cut'));
  assertEquals(body.state.cancelled, true);
  assert(body.state.pulledBytes <= MAX_BODY_BYTES + 64 * 1024, `pulled ${body.state.pulledBytes}`);
});

Deno.test('fetchPage reads a body of exactly 1 MB whole', async () => {
  // Ends in a two-byte character: not truncated, so it's decoded, not held back.
  const page = padTo('<style>', MAX_BODY_BYTES - encode('</style><p>Crème</p>').byteLength, '</style><p>Crème</p>');
  assertEquals(encode(page).byteLength, MAX_BODY_BYTES);
  const body = pulledBody(encode(page));
  const fetch = fakeFetch({ 'https://kitchen.example/': () => html(body.stream) });
  const result = await fetchPage('https://kitchen.example/', { fetch: fetch.fn, resolve: fakeResolve().fn });
  assertEquals(result.text, 'Crème');
  assertEquals(body.state.cancelled, false);
});

Deno.test('fetchPage decodes a body cut in the middle of a multi-byte character', async () => {
  // è is 2 bytes and € is 3: cut after the first byte of each, and after the second byte of €.
  for (const [char, keep] of [['è', 1], ['€', 1], ['€', 2]] as const) {
    const page = padTo('<style>', MAX_BODY_BYTES - keep - encode('</style><p>Cr').byteLength, `</style><p>Cr${char}me</p>`);
    assertEquals(encode(page.slice(0, page.indexOf(char))).byteLength, MAX_BODY_BYTES - keep);
    for (const chunkSize of [64 * 1024, 1000]) {
      const body = pulledBody(encode(page + '<p>more</p>'.repeat(100)), chunkSize);
      const fetch = fakeFetch({ 'https://kitchen.example/': () => html(body.stream) });
      const result = await fetchPage('https://kitchen.example/', { fetch: fetch.fn, resolve: fakeResolve().fn });
      assertEquals(result.text, 'Cr', `${char} keep ${keep} chunks ${chunkSize}`);
    }
  }

  // A cut in a Latin-1 page has no partial character to drop.
  const latin1 = new Uint8Array(MAX_BODY_BYTES + 10).fill(0x61);
  latin1.set(encode('<p>'), 0);
  latin1[MAX_BODY_BYTES - 1] = 0xe8; // è
  const body = pulledBody(latin1);
  const fetch = fakeFetch({
    'https://kitchen.example/': () => html(body.stream, { 'content-type': 'text/html; charset=iso-8859-1' }),
  });
  const result = await fetchPage('https://kitchen.example/', { fetch: fetch.fn, resolve: fakeResolve().fn });
  assertEquals(result.text.length, MAX_TEXT_CHARS);
  assert(!result.text.includes('�'));
});

Deno.test('fetchPage drops a tag cut in half at the end of a truncated body', async () => {
  const lead = '</style><p>Soup</p><p>Salt';
  const page = padTo('<style>', MAX_BODY_BYTES - 3 - encode(lead).byteLength, `${lead}<div class="later">Later</div>`);
  const body = pulledBody(encode(page));
  const fetch = fakeFetch({ 'https://kitchen.example/': () => html(body.stream) });
  const result = await fetchPage('https://kitchen.example/', { fetch: fetch.fn, resolve: fakeResolve().fn });
  // The body ends at `Salt<di`: the half tag isn't text.
  assertEquals(result.text, 'Soup\nSalt');
});

Deno.test('fetchPage keeps only the JSON-LD blocks that end before the cut', async () => {
  const before = '{"@type":"WebPage","name":"Apple cake"}';
  const page =
    padTo(
      `<html><head><script type="application/ld+json">${before}</script><style>`,
      MAX_BODY_BYTES - 100,
      '</style><script type="application/ld+json">{"@type":"Recipe","name":"Cut off",',
    ) +
    '"recipeIngredient":["' +
    'apple '.repeat(100) +
    '"]}</script>' +
    '<script type="application/ld+json">{"@type":"Recipe","name":"After"}</script></head><body><p>Hi</p></body></html>';
  const body = pulledBody(encode(page));
  const fetch = fakeFetch({ 'https://kitchen.example/': () => html(body.stream) });
  const result = await fetchPage('https://kitchen.example/', { fetch: fetch.fn, resolve: fakeResolve().fn });
  assertEquals(result.jsonLd, [before]);
  assertEquals(result.text, '');
});

Deno.test('fetchPage times out a fetch that never answers, and aborts it', async () => {
  assertEquals(FETCH_TIMEOUT_MS, 10_000);
  let aborted = false;
  const hanging = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init!.signal!.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('aborted', 'AbortError'));
      });
    })) as typeof fetch;
  await assertFails(fetchPage('https://kitchen.example/', { fetch: hanging, resolve: fakeResolve().fn, timeoutMs: 20 }), 'timeout');
  assertEquals(aborted, true);
});

Deno.test('fetchPage times out a body that stops sending, and cancels it', async () => {
  let cancelled = false;
  const fetch = fakeFetch({
    'https://kitchen.example/': () =>
      html(
        new ReadableStream({
          start: (c) => c.enqueue(new TextEncoder().encode('<p>partial')),
          cancel: () => {
            cancelled = true;
          },
        }),
      ),
  });
  await assertFails(fetchPage('https://kitchen.example/', { fetch: fetch.fn, resolve: fakeResolve().fn, timeoutMs: 20 }), 'timeout');
  assertEquals(cancelled, true);
});

Deno.test('fetchPage times out a DNS lookup that never answers', async () => {
  const stuck: ResolveHost = () => new Promise(() => {});
  const fetch = fakeFetch({});
  await assertFails(fetchPage('https://kitchen.example/', { fetch: fetch.fn, resolve: stuck, timeoutMs: 20 }), 'timeout');
  assertEquals(fetch.calls, []);
});

// --- Readable text ---

Deno.test('readPage extracts the title, JSON-LD and recipe-card text from a fixture page', async () => {
  const page = readPage(await Deno.readTextFile(new URL('./fixtures/recipe-page.html', import.meta.url)));
  assertEquals(page.title, 'Weeknight Chickpea Curry & Rice | Example Kitchen');
  assertEquals(page.jsonLd, [
    '{"@context":"https://schema.org","@type":"WebSite","name":"Example Kitchen","url":"https://kitchen.example/"}',
    '{"@context":"https://schema.org","@graph":[{"@type":"Recipe","name":"Weeknight Chickpea Curry","recipeYield":["4","4 servings"],"recipeIngredient":["1 (15 oz) can chickpeas","2 cloves garlic, minced","1 cup basmati rice"]}]}',
  ]);
  assertEquals(
    page.text,
    [
      'Weeknight Chickpea Curry',
      'Ingredients',
      '1 (15 oz) can chickpeas',
      '2 cloves garlic, minced',
      '1 cup basmati rice',
      'Salt & pepper, to taste',
      'Instructions',
      'Rinse the rice.',
      'Simmer everything for 20–25 minutes.',
    ].join('\n'),
  );
});

Deno.test('fetchPage returns the fixture page end to end', async () => {
  const body = await Deno.readFile(new URL('./fixtures/recipe-page.html', import.meta.url));
  const fetch = fakeFetch({ 'https://kitchen.example/curry/': () => html(body) });
  const page = await fetchPage('https://kitchen.example/curry/', { fetch: fetch.fn, resolve: fakeResolve().fn });
  assertEquals(page.finalUrl, 'https://kitchen.example/curry/');
  assertEquals(page.title, 'Weeknight Chickpea Curry & Rice | Example Kitchen');
  assertEquals(page.jsonLd.length, 2);
  assert(page.text.startsWith('Weeknight Chickpea Curry\nIngredients\n1 (15 oz) can chickpeas'));
});

Deno.test('readPage prefers schema.org Recipe microdata, then <article>, then <body>', () => {
  const microdata = readPage(
    '<body><article><p>Story</p><div itemscope itemtype="http://schema.org/Recipe"><p>Card</p></div></article></body>',
  );
  assertEquals(microdata.text, 'Card');
  const article = readPage('<body><p>Intro</p><article><p>Story</p></article><p>Comments</p></body>');
  assertEquals(article.text, 'Story');
  const body = readPage('<html><head><title>T</title></head><body><p>One</p><p>Two</p></body></html>');
  assertEquals(body.text, 'One\nTwo');
  const fragment = readPage('<p>Just a fragment</p>');
  assertEquals(fragment.text, 'Just a fragment');
});

Deno.test('readPage falls back when the preferred element has no text', () => {
  const page = readPage('<body><article><aside>Ad</aside></article><p>Real text</p></body>');
  assertEquals(page.text, 'Real text');
});

Deno.test('readPage keeps nested elements of the same name inside the preferred one', () => {
  const page = readPage(
    '<div class="recipe-card"><div><p>A</p></div><div>B</div></div><div>Outside</div><div class="recipe-card-title">X</div>',
  );
  assertEquals(page.text, 'A\nB');
});

Deno.test('readPage drops script, style, comments, nav, header, footer and aside, including nested ones', () => {
  const page = readPage(
    [
      '<body>',
      '<header><nav>Menu</nav><header>Inner header</header>Logo</header>',
      '<script>var x = "</div>";</script><style>p { color: red }</style>',
      '<!-- hidden <p>comment</p> -->',
      '<p>Keep me</p>',
      '<aside><aside>Nested</aside>Ad</aside>',
      '<footer>Copyright</footer>',
      '<SCRIPT type="text/javascript">alert(1)</SCRIPT>',
      '<p>And me</p>',
      '</body>',
    ].join(''),
  );
  assertEquals(page.text, 'Keep me\nAnd me');
});

Deno.test('readPage keeps the content after an element that is never closed', () => {
  assertEquals(readPage('<body><nav><p>Text after an unclosed nav</p></body>').text, 'Text after an unclosed nav');
});

Deno.test('readPage drops comment sections by id and class, keeping the article text around them', () => {
  const sections = [
    '<div id="comments"><div class="comment"><div>Nested</div>So good</div></div>',
    "<div id='respond'><form><p>Leave a reply</p></form></div>",
    '<section class="post-comments comments"><p>Two comments</p></section>',
    '<ul class="comment-list"><li>Loved it</li></ul>',
    '<ol class="commentlist"><li>Too sweet</li></ol>',
    '<ol class="comments"><li>Ordered list</li></ol>',
    '<div class="wprm-comments"><p>Rated 5 stars</p></div>',
    '<DIV ID="Comments"><p>Upper case</p></DIV>',
  ];
  const page = readPage(`<body><article><p>Step one</p>${sections.join('<p>Between</p>')}<p>Step two</p></article></body>`);
  assertEquals(page.text, ['Step one', ...Array<string>(sections.length - 1).fill('Between'), 'Step two'].join('\n'));
  // Names that only look similar are kept.
  assertEquals(
    readPage('<body><div id="comments-count">3 comments</div><p class="comment-intro">Say hi</p><div id="no-comments">None</div></body>').text,
    '3 comments\nSay hi\nNone',
  );
});

Deno.test('readPage drops an unclosed comment section to the end, unlike an unclosed nav', () => {
  assertEquals(readPage('<body><p>Recipe</p><div id="comments"><ol class="commentlist"><li>Yum').text, 'Recipe');
  assertEquals(readPage('<p>Recipe</p><div class="comments"><p>Cut off').text, 'Recipe');
});

Deno.test('readPage skips a JSON-LD block cut off by the end of the page', () => {
  const page = readPage('<script type="application/ld+json">{"a":1}</script><script type="application/ld+json">{"b":');
  assertEquals(page.jsonLd, ['{"a":1}']);
  assertEquals(page.text, '');
});

Deno.test('readPage collapses whitespace, keeps lines, decodes entities and joins inline tags', () => {
  const page = readPage(
    '<body><p>  Two\t\tcups&nbsp;&nbsp; <b>flour</b>,\n sifted  </p><br/><li>fl<i>ou</i>r &amp; salt&#x2014;&#189;</li><table><tr><td>a</td><td>b</td></tr></table></body>',
  );
  assertEquals(page.text, 'Two cups flour, sifted\nflour & salt—½\na b');
});

Deno.test('readPage ignores > inside quoted attribute values', () => {
  assertEquals(readPage('<body><div data-x="a > b" title=\'c>d\'>Text</div></body>').text, 'Text');
});

Deno.test('readPage collects every JSON-LD block, in any attribute style, skipping commented and empty ones', () => {
  const page = readPage(
    [
      '<script type="application/ld+json">{"a":1}</script>',
      "<script id='x' type='application/ld+json'>\n  {\"b\":2}\n</script>",
      '<script type=application/ld+json>{"c":3}</script>',
      '<script TYPE="Application/LD+JSON">{"d":4}</script>',
      '<!-- <script type="application/ld+json">{"commented":true}</script> -->',
      '<script type="application/ld+json">   </script>',
      '<script type="application/json">{"not":"ld"}</script>',
      '<script>{"plain":true}</script>',
    ].join(''),
  );
  assertEquals(page.jsonLd, ['{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}']);
  assertEquals(page.text, '');
});

Deno.test('readPage keeps markup-like text inside JSON-LD as written', () => {
  const block = '{"name":"Mac &amp; cheese","description":"<p>Creamy</p> <!-- not a comment -->"}';
  assertEquals(readPage(`<script type="application/ld+json">${block}</script>`).jsonLd, [block]);
});

Deno.test('readPage title: decoded and collapsed, null when missing or blank', () => {
  assertEquals(readPage('<title>\n  Fish &amp;\n Chips &#8211; Easy </title>').title, 'Fish & Chips – Easy');
  assertEquals(readPage('<p>No title</p>').title, null);
  assertEquals(readPage('<title>  </title>').title, null);
});

Deno.test('readPage caps the text at 30,000 characters', () => {
  assertEquals(MAX_TEXT_CHARS, 30_000);
  const exact = 'a'.repeat(MAX_TEXT_CHARS);
  assertEquals(readPage(`<p>${exact}</p>`).text, exact);
  const long = readPage(`<p>${'b'.repeat(MAX_TEXT_CHARS + 500)}</p><p>tail</p>`).text;
  assertEquals(long.length, MAX_TEXT_CHARS);
  assertEquals(long, 'b'.repeat(MAX_TEXT_CHARS));
});

Deno.test('readPage does not split a surrogate pair at the cap', () => {
  const text = readPage(`<p>${'a'.repeat(MAX_TEXT_CHARS - 1)}🍋 lemon</p>`).text;
  assertEquals(text, 'a'.repeat(MAX_TEXT_CHARS - 1));
});
