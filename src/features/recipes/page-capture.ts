// Device capture of a recipe page (spec 4.10, 6.6). Many recipe sites answer a server fetch with a
// bot check; a real WebKit view on the phone gets through. When `import-recipe` answers
// `fetch_failed`, the page is loaded in a hidden WebView (`PageCaptureHost`), `CAPTURE_SCRIPT` reads
// `{ title, jsonLd, text }` from it, and the import is retried with that `page`.

import {
  MAX_JSON_LD_BLOCK_BYTES,
  MAX_JSON_LD_BLOCKS,
  MAX_PAGE_TEXT_BYTES,
  type RecipeImportRequest,
} from '@/shared/schemas/recipe-import';

export type CapturedPage = { title: string; jsonLd: string[]; text: string };

/** How long a capture waits for the real page behind a bot check before giving up. */
export const CAPTURE_TIMEOUT_MS = 20_000;

/** How often the script re-reads the page, so a JS-rendered page or a challenge's reload gets seen. */
export const CAPTURE_INTERVAL_MS = 1_000;

/**
 * Injected at document end of every page the hidden WebView loads, so it runs again when a
 * challenge reloads into the real page. It posts `{ title, jsonLd, text }` as JSON now and every
 * second. The caps are those of `RecipeImportRequest.page` (each JSON-LD block ≤ 200 KB, at most 10;
 * `document.body.innerText` ≤ 50 KB, UTF-8 bytes); a block over its cap is dropped, since cut JSON
 * doesn't parse. Self-contained plain ES2017 so the share extension's `Preprocess.js` can copy it.
 */
export const CAPTURE_SCRIPT = `(function () {
  var MAX_BLOCKS = ${MAX_JSON_LD_BLOCKS};
  var MAX_BLOCK_BYTES = ${MAX_JSON_LD_BLOCK_BYTES};
  var MAX_TEXT_BYTES = ${MAX_PAGE_TEXT_BYTES};
  var encoder = new TextEncoder();
  var decoder = new TextDecoder();
  function bytes(s) { return encoder.encode(s).length; }
  function cut(s, max) {
    var encoded = encoder.encode(s);
    if (encoded.length <= max) return s;
    return decoder.decode(encoded.slice(0, max)).replace(/\\uFFFD+$/, '');
  }
  function capture() {
    var jsonLd = [];
    var scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < scripts.length && jsonLd.length < MAX_BLOCKS; i++) {
      var block = scripts[i].textContent || '';
      if (block.trim() && bytes(block) <= MAX_BLOCK_BYTES) jsonLd.push(block);
    }
    var text = document.body ? document.body.innerText || '' : '';
    return { title: document.title || '', jsonLd: jsonLd, text: cut(text, MAX_TEXT_BYTES) };
  }
  function post() {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify(capture()));
    } catch (e) {}
  }
  post();
  setInterval(post, ${CAPTURE_INTERVAL_MS});
})();
true;`;

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Cuts `s` to at most `max` UTF-8 bytes without splitting a character. */
function cutToBytes(s: string, max: number): string {
  const encoded = new TextEncoder().encode(s);
  if (encoded.length <= max) return s;
  return new TextDecoder().decode(encoded.slice(0, max)).replace(/�+$/, '');
}

/**
 * A message from `CAPTURE_SCRIPT` as a page within the request caps, or null if it isn't one. The
 * caps are applied again here, since the message comes from whatever page the WebView loaded.
 */
export function parseCapturedPage(data: string): CapturedPage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const { title, jsonLd, text } = raw as Record<string, unknown>;
  return {
    title: typeof title === 'string' ? title : '',
    jsonLd: (Array.isArray(jsonLd) ? jsonLd : [])
      .filter((b): b is string => typeof b === 'string' && b.trim() !== '' && utf8Bytes(b) <= MAX_JSON_LD_BLOCK_BYTES)
      .slice(0, MAX_JSON_LD_BLOCKS),
    text: typeof text === 'string' ? cutToBytes(text, MAX_PAGE_TEXT_BYTES) : '',
  };
}

/** Titles bot checks use, whole. */
const BOT_CHECK_TITLES = [
  /^just a moment/i, // Cloudflare
  /^attention required/i, // Cloudflare
  /^security verification$/i,
  /^vercel security checkpoint$/i,
  /^simple page$/i, // AllRecipes' JS-only stand-in
  /^access denied$/i,
  /^checking your browser/i,
  /^ddos-guard$/i,
];

/** What bot checks say on the page. */
const BOT_CHECK_TEXT = [
  /verif(?:y|ies|ying) (?:that )?you are (?:not a bot|(?:a )?human)/i,
  /verifying your browser/i,
  /checking (?:if the site connection is secure|your browser)/i,
  /enable javascript and cookies to continue/i,
  /performing security verification/i,
];

/**
 * True when the page is a bot check rather than the site's page, so the capture keeps waiting: a
 * challenge page often reloads into the real one.
 */
export function isBotCheckPage({ title, text }: { title?: string; text?: string }): boolean {
  const t = (title ?? '').trim().replace(/\s+/g, ' ');
  if (BOT_CHECK_TITLES.some((re) => re.test(t))) return true;
  // Bot checks are short; a recipe page that mentions a phrase further down isn't one.
  const head = (text ?? '').slice(0, 2_000);
  return BOT_CHECK_TEXT.some((re) => re.test(head));
}

/** True once the page is worth sending: past any bot check, with text or JSON-LD to read. */
export function isCaptureReady(page: CapturedPage): boolean {
  return !isBotCheckPage(page) && (page.text.trim() !== '' || page.jsonLd.length > 0);
}

/** The capture as `RecipeImportRequest.page`, empty parts left out. */
export function toRequestPage(page: CapturedPage): NonNullable<RecipeImportRequest['page']> {
  return {
    ...(page.title.trim() ? { title: page.title } : {}),
    ...(page.jsonLd.length ? { jsonLd: page.jsonLd } : {}),
    ...(page.text.trim() ? { text: page.text } : {}),
  };
}

/**
 * The page, or why there's none: `timeout` when it never got past a bot check in time (the site
 * blocked it), `unreachable` when the page didn't load at all or nothing can capture right now.
 */
export type CaptureResult = { ok: true; page: CapturedPage } | { ok: false; reason: 'timeout' | 'unreachable' };

export type CaptureSession = {
  /** Hands the session a message from the WebView. */
  receive: (data: string) => void;
  /** Ends the session early: the page didn't load. */
  fail: () => void;
};

/**
 * Waits for the first message that's a ready page and calls `done` with it, or with a `timeout`
 * after `timeoutMs`. `done` is called exactly once.
 */
export function createCaptureSession(
  done: (result: CaptureResult) => void,
  timeoutMs: number = CAPTURE_TIMEOUT_MS,
): CaptureSession {
  let finished = false;
  const finish = (result: CaptureResult) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    done(result);
  };
  const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs);
  return {
    receive: (data) => {
      const page = parseCapturedPage(data);
      if (page && isCaptureReady(page)) finish({ ok: true, page });
    },
    fail: () => finish({ ok: false, reason: 'unreachable' }),
  };
}

/** Loads `url` in a hidden WebView and captures it. */
export type PageCapturer = (url: string) => Promise<CaptureResult>;

let capturer: PageCapturer | null = null;

/** Set by `PageCaptureHost` while it's mounted (and by tests). */
export function setPageCapturer(next: PageCapturer | null): void {
  capturer = next;
}

/** Captures `url` on the device. Never throws. */
export async function capturePage(url: string): Promise<CaptureResult> {
  if (!capturer) return { ok: false, reason: 'unreachable' };
  try {
    return await capturer(url);
  } catch (e) {
    console.warn('Page capture failed', e);
    return { ok: false, reason: 'unreachable' };
  }
}
