// Spec 6.6 step 4 and "Fetching". Fetches a shared recipe link on the server without letting it
// reach anything private: http(s) only, every hop's addresses checked (at most 5 redirects), a
// 10 s timeout and text/html only. A body over 1 MB is cut there, not refused: on a big recipe page
// it's the comments after the recipe that run long. Returns the page's title, JSON-LD blocks,
// readable text and photo candidates. DNS and fetch are injected so tests need no network.
//
// Each hop connects to the addresses its check passed (`pinned-fetch.ts`), never resolving the host
// again, so a DNS server that answers differently a moment later (rebinding) can't reach a private one.
//
// Relative import, not `@shared/`: this file is tested from `_shared/`, which has no import map.
import { cleanImageUrl, decodeHtmlEntities, jsonLdImageCandidates } from '../../../src/shared/recipe-jsonld.ts';
import { type Connect, createPinnedFetch, type PinnedFetch } from './pinned-fetch.ts';

export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const MAX_TEXT_CHARS = 30_000;

export type FetchPageFailure =
  | 'invalid_url'
  | 'blocked_address'
  | 'dns_failed'
  | 'too_many_redirects'
  | 'http_status'
  | 'not_html'
  | 'timeout';

/** Every way a fetch can fail. import-recipe maps them all to `fetch_failed`. */
export class FetchPageError extends Error {
  constructor(
    readonly reason: FetchPageFailure,
    message: string,
  ) {
    super(message);
    this.name = 'FetchPageError';
  }
}

/** Returns every address (IPv4 and IPv6) the host name resolves to. */
export type ResolveHost = (hostname: string) => Promise<string[]>;

export type FetchPageDeps = {
  resolve?: ResolveHost;
  /** Must connect only to `init.addresses`. Defaults to `createPinnedFetch(connect)`. */
  fetch?: PinnedFetch;
  /** The pinned fetch's connection opener; tests inject one to see where it connects. */
  connect?: Connect;
  timeoutMs?: number;
};

export type ReadablePage = {
  title: string | null;
  jsonLd: string[];
  text: string;
  /** The first of `imageCandidates`; null when the page has no usable photo. */
  imageUrl: string | null;
  /** `readImageCandidates`: the page's photos, best first, at most 12. */
  imageCandidates: string[];
};

export type FetchedPage = ReadablePage & { finalUrl: string };

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const USER_AGENT = 'Mozilla/5.0 (compatible; ThePerfectBite/1.0; recipe import)';

/** A and AAAA records together; a host with neither resolves to []. */
export async function resolveHostDns(hostname: string): Promise<string[]> {
  const results = await Promise.allSettled([Deno.resolveDns(hostname, 'A'), Deno.resolveDns(hostname, 'AAAA')]);
  return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
}

// --- Addresses ---

function parseIPv4(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
}

/** Eight 16-bit groups, or null. Accepts `::`, a dotted IPv4 tail and a `%zone` suffix. */
function parseIPv6(address: string): number[] | null {
  let text = address.replace(/%.*$/, '');
  const tail = /:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const v4 = parseIPv4(tail[1]);
    if (v4 === null) return null;
    text = `${text.slice(0, tail.index)}:${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (half: string) => (half === '' ? [] : half.split(':'));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (!all.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return null;
  return all.map((group) => parseInt(group, 16));
}

// [network, prefix length]: private, loopback, link-local (incl. 169.254.169.254 metadata),
// carrier-grade NAT (incl. 100.100.100.200 metadata), documentation, multicast and reserved.
const BLOCKED_IPV4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function isBlockedIPv4(value: number): boolean {
  return BLOCKED_IPV4.some(([network, bits]) => {
    const shift = 32 - bits;
    return Math.floor(value / 2 ** shift) === Math.floor(parseIPv4(network)! / 2 ** shift);
  });
}

function isBlockedIPv6(g: number[]): boolean {
  const embeddedV4 = (high: number, low: number) => isBlockedIPv4(high * 65536 + low);
  const zeros = (from: number, to: number) => g.slice(from, to).every((group) => group === 0);
  // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d
  if (zeros(0, 6)) return true;
  // IPv4-mapped ::ffff:a.b.c.d and NAT64 64:ff9b::a.b.c.d carry an IPv4 address
  if (zeros(0, 5) && g[5] === 0xffff) return embeddedV4(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return embeddedV4(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // local-use NAT64
  if (g[0] === 0x2002) return embeddedV4(g[1], g[2]); // 6to4
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local, incl. fd00:ec2::254 metadata
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // link- and site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0100 && zeros(1, 4)) return true; // discard
  return false;
}

/** True for any address a shared link mustn't reach, and for anything that isn't an IP address. */
export function isBlockedAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4 !== null) return isBlockedIPv4(v4);
  const v6 = parseIPv6(address);
  return v6 === null || isBlockedIPv6(v6);
}

/** The host's addresses, all public, for the fetch to connect to. Throws if any isn't. */
async function assertPublicHost(hostname: string, resolve: ResolveHost): Promise<string[]> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  let addresses: string[];
  if (parseIPv4(host) !== null || host.includes(':')) {
    addresses = [host];
  } else if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new FetchPageError('blocked_address', `${hostname} is not a public host`);
  } else {
    try {
      addresses = await resolve(host);
    } catch {
      addresses = [];
    }
    if (addresses.length === 0) throw new FetchPageError('dns_failed', `${hostname} did not resolve`);
  }
  // Every address must be public, so a host can't mix a private answer in with public ones.
  if (addresses.some(isBlockedAddress)) {
    throw new FetchPageError('blocked_address', `${hostname} resolves to a non-public address`);
  }
  return addresses;
}

// --- Fetching ---

function parseHttpUrl(url: string, base?: URL): URL {
  let parsed: URL;
  try {
    parsed = new URL(url, base);
  } catch {
    throw new FetchPageError('invalid_url', 'Not a URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new FetchPageError('invalid_url', `${parsed.protocol} links can't be fetched`);
  }
  return parsed;
}

function charsetOf(contentType: string): string {
  const match = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType);
  return match ? match[1] : 'utf-8';
}

type Body = { bytes: Uint8Array; truncated: boolean };

/** The body's first MAX_BODY_BYTES, whatever Content-Length says. The rest is never read. */
async function readBody(response: Response, signal: AbortSignal): Promise<Body> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const cancel = () => reader.cancel().catch(() => {});
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > MAX_BODY_BYTES) {
        chunks.push(value.subarray(0, MAX_BODY_BYTES - total));
        total = MAX_BODY_BYTES;
        truncated = true;
        await cancel();
        break;
      }
      total += value.byteLength;
      chunks.push(value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes: body, truncated };
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

function decodeBody({ bytes, truncated }: Body, contentType: string): string {
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charsetOf(contentType));
  } catch {
    decoder = new TextDecoder();
  }
  if (!truncated) return decoder.decode(bytes);
  // `stream` holds back a multi-byte character cut off at the end, and with no final call it's
  // dropped. A tag cut in half is dropped too, so it doesn't turn up in the text.
  return decoder.decode(bytes, { stream: true }).replace(/<[^>]*$/, '');
}

async function load(url: string, resolve: ResolveHost, fetchFn: PinnedFetch, signal: AbortSignal) {
  let current = parseHttpUrl(url);
  for (let redirects = 0; ; redirects++) {
    const addresses = await assertPublicHost(current.hostname, resolve);
    const response = await fetchFn(current.href, {
      addresses,
      redirect: 'manual',
      signal,
      headers: { accept: 'text/html', 'user-agent': USER_AGENT },
    });
    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get('location');
      if (!location) throw new FetchPageError('http_status', `HTTP ${response.status} without a Location`);
      if (redirects === MAX_REDIRECTS) {
        throw new FetchPageError('too_many_redirects', `More than ${MAX_REDIRECTS} redirects`);
      }
      current = parseHttpUrl(location, current);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new FetchPageError('http_status', `HTTP ${response.status}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.split(';')[0].trim().toLowerCase() !== 'text/html') {
      await response.body?.cancel().catch(() => {});
      throw new FetchPageError('not_html', `Not an HTML page (${contentType || 'no content type'})`);
    }
    const html = decodeBody(await readBody(response, signal), contentType);
    return { finalUrl: current.href, ...readPage(html, current.href) };
  }
}

/** Fetches a recipe page under spec 6.6's fetching rules. Throws FetchPageError on any failure. */
export async function fetchPage(url: string, deps: FetchPageDeps = {}): Promise<FetchedPage> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The timeout covers DNS, every hop and the body, even if a step ignores the abort signal.
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new FetchPageError('timeout', 'The page took too long to load'));
    }, deps.timeoutMs ?? FETCH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      load(url, deps.resolve ?? resolveHostDns, deps.fetch ?? createPinnedFetch(deps.connect), controller.signal),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// --- Readable text ---

// A tag, with quoted attribute values allowed to contain `>`.
const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

// Comments, and the raw-text elements whose content isn't markup, in one left-to-right pass. The
// fourth group is the close tag, missing when a truncated body ends inside the element.
const COMMENT_OR_RAW = /<!--[\s\S]*?(?:-->|$)|<(script|style)\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)(?:(<\/\1\s*>)|$)/gi;

const REMOVED = new Set(['head', 'nav', 'header', 'footer', 'aside', 'noscript', 'template', 'svg']);

// Comment sections (WordPress and recipe plugins), dropped like REMOVED elements whatever their tag.
const COMMENT_IDS = new Set(['comments', 'respond']);
const COMMENT_CLASSES = new Set(['comments', 'comment-list', 'commentlist', 'wprm-comments']);

const BLOCK = new Set([
  'address', 'article', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul',
]);

const RECIPE_CARD_CLASSES = new Set(['recipe-card', 'wprm-recipe-container', 'tasty-recipes', 'mv-create-card']);

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  return match ? (match[1] ?? match[2] ?? match[3]) : null;
}

function isRecipeCard(attrs: string): boolean {
  const itemtype = attribute(attrs, 'itemtype') ?? '';
  if (/(^|\s)https?:\/\/schema\.org\/Recipe(\s|$)/i.test(itemtype)) return true;
  const classes = (attribute(attrs, 'class') ?? '').toLowerCase().split(/\s+/);
  return classes.some((token) => RECIPE_CARD_CLASSES.has(token));
}

function isRemoved(name: string, attrs: string): boolean {
  if (REMOVED.has(name)) return true;
  if (COMMENT_IDS.has((attribute(attrs, 'id') ?? '').toLowerCase())) return true;
  const classes = (attribute(attrs, 'class') ?? '').toLowerCase().split(/\s+/);
  return classes.some((token) => COMMENT_CLASSES.has(token));
}

function isSelfClosing(attrs: string): boolean {
  return attrs.trimEnd().endsWith('/');
}

/** The inner HTML of the first element whose open tag passes `test`, up to its matching close. */
function innerHtmlOf(html: string, test: (name: string, attrs: string) => boolean): string | null {
  const tags = new RegExp(TAG.source, 'g');
  let open: { name: string; start: number } | null = null;
  let depth = 0;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    const [whole, slash, rawName, attrs] = m;
    const name = rawName.toLowerCase();
    if (!open) {
      if (!slash && !isSelfClosing(attrs) && test(name, attrs)) {
        open = { name, start: m.index + whole.length };
        depth = 1;
      }
    } else if (name === open.name) {
      depth += slash ? -1 : isSelfClosing(attrs) ? 0 : 1;
      if (depth === 0) return html.slice(open.start, m.index);
    }
  }
  return open ? html.slice(open.start) : null;
}

/**
 * Drops each REMOVED element and comment section with its content. A REMOVED element that's never
 * closed loses only its tag; a comment section that's never closed (the usual place for a truncated
 * body to end) is dropped through to the end.
 */
function removeElements(html: string): string {
  const tags = new RegExp(TAG.source, 'g');
  let out = '';
  let kept = 0;
  let skipping: { name: string; start: number; resume: number; toEnd: boolean } | null = null;
  let depth = 0;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    const [whole, slash, rawName, attrs] = m;
    const name = rawName.toLowerCase();
    if (!skipping) {
      if (!slash && isRemoved(name, attrs)) {
        if (isSelfClosing(attrs)) {
          out += html.slice(kept, m.index);
          kept = m.index + whole.length;
          continue;
        }
        skipping = { name, start: m.index, resume: m.index + whole.length, toEnd: !REMOVED.has(name) };
        depth = 1;
      }
    } else if (name === skipping.name) {
      depth += slash ? -1 : isSelfClosing(attrs) ? 0 : 1;
      if (depth === 0) {
        out += html.slice(kept, skipping.start);
        kept = m.index + whole.length;
        skipping = null;
      }
    }
  }
  if (skipping) {
    out += html.slice(kept, skipping.start);
    return skipping.toEnd ? out : out + removeElements(html.slice(skipping.resume));
  }
  return out + html.slice(kept);
}

function toText(html: string): string {
  // Newlines in the source are just whitespace; only block elements start a new line.
  const source = removeElements(html).replace(/\s+/g, ' ');
  const flat = source.replace(new RegExp(TAG.source, 'g'), (_, _slash, name: string) => {
    const tag = name.toLowerCase();
    if (BLOCK.has(tag)) return '\n';
    return tag === 'td' || tag === 'th' ? ' ' : '';
  });
  return decodeHtmlEntities(flat)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

function capText(text: string): string {
  if (text.length <= MAX_TEXT_CHARS) return text;
  const cut = text.slice(0, MAX_TEXT_CHARS);
  // Don't leave half of a surrogate pair at the end.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * Title, JSON-LD blocks and readable text from a page's HTML. The text prefers the recipe card
 * (schema.org Recipe microdata or a recipe plugin's card), then the `<article>`, then `<body>`, and
 * drops scripts, styles, comments, `nav`, `header`, `footer` and `aside` (and `head`, `noscript`,
 * `template`, `svg`) and comment sections (`#comments`, `#respond`, `.comments`, `.comment-list`,
 * `.commentlist`, `.wprm-comments`). Lines are kept, other whitespace collapsed, and it's capped at
 * 30,000 characters. A JSON-LD block counts only if its `</script>` is there: one cut off by a
 * truncated body can't be whole. The photos are `readImageCandidates`'s, resolved against `pageUrl`
 * (without it only absolute URLs are kept); `imageUrl` is the first.
 */
export function readPage(html: string, pageUrl?: string): ReadablePage {
  const jsonLd: string[] = [];
  const markup = html.replace(COMMENT_OR_RAW, (_match, element: string | undefined, attrs: string, content: string, closed: string | undefined) => {
    if (closed && element?.toLowerCase() === 'script' && /(?:^|\s)type\s*=\s*["']?\s*application\/ld\+json/i.test(attrs)) {
      const block = content.trim();
      if (block !== '') jsonLd.push(block);
    }
    return element ? '\n' : '';
  });

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(markup);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() || null : null;

  const candidates = [
    innerHtmlOf(markup, (_name, attrs) => isRecipeCard(attrs)),
    innerHtmlOf(markup, (name) => name === 'article'),
    innerHtmlOf(markup, (name) => name === 'body'),
    markup,
  ];
  let text = '';
  for (const candidate of candidates) {
    if (candidate === null) continue;
    text = toText(candidate);
    if (text !== '') break;
  }
  const imageCandidates = readImageCandidates(markup, jsonLd, pageUrl);
  return { title, jsonLd, text: capText(text), imageUrl: imageCandidates[0] ?? null, imageCandidates };
}

// --- Photo candidates ---

/** How many photos `readImageCandidates` returns at most. */
export const MAX_IMAGE_CANDIDATES = 12;

/** Images smaller than this (a declared `width` or `height`, in pixels) aren't a recipe's photo. */
export const MIN_CONTENT_IMAGE_SIZE = 300;

const OG_IMAGE_KEYS = ['og:image', 'og:image:secure_url', 'og:image:url'];
const TWITTER_IMAGE_KEYS = ['twitter:image', 'twitter:image:src'];

/** Words in an image's `src`, `class`, `id` or `alt` that mean it isn't the recipe's photo. */
const NOT_A_PHOTO = /^(?:logos?|avatars?|icons?|favicons?|sprites?|badges?|gravatar|ads?|adverts?|advertisements?|pixels?|tracking|tracker|beacons?|spacer)$/;

type Tag = { name: string; attrs: string };

/** Every open tag in `markup`, in document order. */
function openTags(markup: string): Tag[] {
  const tags = new RegExp(TAG.source, 'g');
  const out: Tag[] = [];
  for (let m = tags.exec(markup); m; m = tags.exec(markup)) {
    if (!m[1]) out.push({ name: m[2].toLowerCase(), attrs: m[3] });
  }
  return out;
}

/** `<meta>` `content` for each key in order, matched on `property` or `name` (sites use either). */
function metaContents(tags: Tag[], keys: readonly string[]): (string | null)[] {
  const metas = tags.filter((tag) => tag.name === 'meta');
  return keys.flatMap((key) =>
    metas
      .filter((tag) => [attribute(tag.attrs, 'property'), attribute(tag.attrs, 'name')].some((v) => v?.trim().toLowerCase() === key))
      .map((tag) => attribute(tag.attrs, 'content')),
  );
}

/** `<link rel="image_src" href>`. */
function linkImageSrc(tags: Tag[]): (string | null)[] {
  return tags
    .filter((tag) => tag.name === 'link' && (attribute(tag.attrs, 'rel') ?? '').toLowerCase().split(/\s+/).includes('image_src'))
    .map((tag) => attribute(tag.attrs, 'href'));
}

/** Microdata `itemprop="image"`: its `content`, else `src`, else `href`. */
function microdataImages(tags: Tag[]): (string | null)[] {
  return tags
    .filter((tag) => (attribute(tag.attrs, 'itemprop') ?? '').split(/\s+/).includes('image'))
    .map((tag) => attribute(tag.attrs, 'content') ?? attribute(tag.attrs, 'src') ?? attribute(tag.attrs, 'href'));
}

/** True when a word of `value` (split on anything but letters and digits) says it isn't a photo. */
function saysNotAPhoto(value: string | null): boolean {
  return (value ?? '').toLowerCase().split(/[^a-z0-9]+/).some((word) => NOT_A_PHOTO.test(word));
}

/** A declared `width`/`height` in pixels under the minimum. A missing, relative ("100%") or unreadable one doesn't count. */
function isDeclaredSmall(attrs: string): boolean {
  return ['width', 'height'].some((key) => {
    const match = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(attribute(attrs, key) ?? '');
    return match !== null && Number(match[1]) < MIN_CONTENT_IMAGE_SIZE;
  });
}

/** svg and gif files and `data:` URLs aren't photos (a gif is a spinner or a pixel). */
function isPhotoUrl(url: string): boolean {
  if (/^\s*data:/i.test(url)) return false;
  return !/\.(?:svg|gif)(?:$|[?#])/i.test(url.trim());
}

/** The URL of the largest candidate in a `srcset` (by its `w`, else `x`, descriptor; none is 1x). */
export function largestSrcsetUrl(srcset: string | null): string | null {
  if (!srcset) return null;
  let best: string | null = null;
  let bestSize = -1;
  let i = 0;
  while (i < srcset.length) {
    while (i < srcset.length && /[\s,]/.test(srcset[i])) i++;
    let end = i;
    while (end < srcset.length && !/\s/.test(srcset[end])) end++;
    let url = srcset.slice(i, end);
    i = end;
    let descriptor = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      while (end < srcset.length && srcset[end] !== ',') end++;
      descriptor = srcset.slice(i, end).trim();
      i = end;
    }
    if (url === '') continue;
    const match = /^(\d+(?:\.\d+)?)([wx])$/i.exec(descriptor);
    const size = match ? Number(match[1]) : 1;
    if (size > bestSize) {
      best = url;
      bestSize = size;
    }
  }
  return best;
}

/**
 * The first `<img>` that looks like the recipe's photo, inside `<article>`, else `<main>`, else
 * `<body>`: not one whose `src`, `class`, `id` or `alt` says logo, avatar, icon, sprite, badge, ad,
 * gravatar or tracking pixel, nor one declared under 300 px. Its URL is `src`, else a lazy loader's
 * `data-src`, `data-lazy-src` or `data-original`, else the largest `srcset`/`data-srcset`; an svg,
 * gif or `data:` URL is skipped for the next.
 */
function contentImage(markup: string, pageUrl: string | undefined): string | null {
  const container =
    innerHtmlOf(markup, (name) => name === 'article') ??
    innerHtmlOf(markup, (name) => name === 'main') ??
    innerHtmlOf(markup, (name) => name === 'body') ??
    markup;
  for (const { name, attrs } of openTags(container)) {
    if (name !== 'img') continue;
    if (['src', 'class', 'id', 'alt'].some((key) => saysNotAPhoto(attribute(attrs, key)))) continue;
    if (isDeclaredSmall(attrs)) continue;
    const urls = [
      attribute(attrs, 'src'),
      attribute(attrs, 'data-src'),
      attribute(attrs, 'data-lazy-src'),
      attribute(attrs, 'data-original'),
      largestSrcsetUrl(attribute(attrs, 'srcset')),
      largestSrcsetUrl(attribute(attrs, 'data-srcset')),
    ];
    for (const url of urls) {
      if (url === null || !isPhotoUrl(url) || saysNotAPhoto(url)) continue;
      const cleaned = cleanImageUrl(url, pageUrl);
      if (cleaned !== null) return cleaned;
    }
  }
  return null;
}

/**
 * The page's photos, best first, de-duplicated, at most 12 (spec 6.6 step 5): (1) the JSON-LD
 * Recipe's `image` and `thumbnailUrl`, (2) the `@graph`'s `WebPage` `primaryImageOfPage` and
 * `Article` `image` (`@id` references resolved, `jsonLdImageCandidates`), (3) `og:image`,
 * `og:image:secure_url`, `og:image:url`, (4) `twitter:image`, `twitter:image:src`, (5)
 * `<link rel="image_src">`, (6) microdata `itemprop="image"`, (7) the first content `<img>` that
 * looks like a photo (`contentImage`). Each goes through `cleanImageUrl` against `pageUrl` (without
 * it only absolute URLs are kept). Scripts and comments in `markup` are ignored.
 */
export function readImageCandidates(markup: string, jsonLd: readonly string[], pageUrl?: string): string[] {
  const html = markup.replace(COMMENT_OR_RAW, (_match, element: string | undefined) => (element ? '\n' : ''));
  const tags = openTags(html);
  const urls = [
    ...jsonLdImageCandidates(jsonLd, pageUrl),
    ...[...metaContents(tags, OG_IMAGE_KEYS), ...metaContents(tags, TWITTER_IMAGE_KEYS), ...linkImageSrc(tags), ...microdataImages(tags)].map(
      (raw) => cleanImageUrl(raw, pageUrl),
    ),
    contentImage(html, pageUrl),
  ].filter((url): url is string => url !== null);
  return [...new Set(urls)].slice(0, MAX_IMAGE_CANDIDATES);
}
