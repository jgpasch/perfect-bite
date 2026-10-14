import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';

import { MAX_JSON_LD_BLOCK_BYTES, MAX_JSON_LD_BLOCKS, MAX_PAGE_TEXT_BYTES } from '@/shared/schemas/recipe-import';

import {
  CAPTURE_INTERVAL_MS,
  CAPTURE_SCRIPT,
  CAPTURE_TIMEOUT_MS,
  capturePage,
  createCaptureSession,
  isBotCheckPage,
  isCaptureReady,
  parseCapturedPage,
  setPageCapturer,
  toRequestPage,
  type CapturedPage,
  type CaptureResult,
} from '../page-capture';

const CHALLENGE_DIR = join(__dirname, 'fixtures', 'challenge-pages');
const EVAL_DIR = join(__dirname, '..', '..', '..', '..', 'supabase', 'functions', 'import-recipe', 'eval', 'fixtures');

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** The page's title and roughly what `document.body.innerText` gives before any script runs. */
function pageOf(file: string): { title: string; text: string } {
  const html = readFileSync(file, 'utf8');
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1].trim() ?? '';
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const text = body
    .replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { title, text };
}

describe('isBotCheckPage', () => {
  test.each([
    'allrecipes-simple-page.html',
    'cloudflare-just-a-moment.html',
    'security-verification.html',
    'vercel-security-checkpoint.html',
  ])('is true for the saved challenge page %s', (file) => {
    expect(isBotCheckPage(pageOf(join(CHALLENGE_DIR, file)))).toBe(true);
  });

  test.each([
    'jsonld-natashaskitchen-beef-broccoli.html',
    'jsonld-delish-shrimp-asparagus-spaghetti.html',
    'jsonld-recipetineats-bbq-pork-ribs.html',
    'nojsonld-smittenkitchen-strawberry-chiffon-shortcake.html',
    'nojsonld-wikibooks-pad-thai.html',
  ])('is false for the recipe page %s', (file) => {
    const page = pageOf(join(EVAL_DIR, file));
    expect(page.text.length).toBeGreaterThan(1000);
    expect(isBotCheckPage(page)).toBe(false);
  });

  test('a challenge is recognised by its text alone', () => {
    expect(isBotCheckPage({ title: 'thewoksoflife.com', text: 'Performing security verification. Please wait.' })).toBe(true);
    expect(isBotCheckPage({ title: '', text: "We're verifying your browser" })).toBe(true);
    expect(isBotCheckPage({ text: 'Enable JavaScript and cookies to continue' })).toBe(true);
  });

  test('titles match whole, so a recipe that mentions one isn’t a bot check', () => {
    expect(isBotCheckPage({ title: 'A Simple Page of Pancakes', text: 'Pancakes' })).toBe(false);
    expect(isBotCheckPage({ title: 'Access Denied Brownies', text: 'Brownies' })).toBe(false);
    expect(isBotCheckPage({ title: '  Just a   moment... ', text: '' })).toBe(true);
  });

  test('a phrase far down a long page doesn’t count', () => {
    const text = `${'Stir the sauce. '.repeat(200)} Our site is verifying you are human.`;
    expect(isBotCheckPage({ title: 'Tikka masala', text })).toBe(false);
  });

  test('nothing at all isn’t a bot check', () => {
    expect(isBotCheckPage({})).toBe(false);
  });
});

describe('isCaptureReady', () => {
  test('a real page with text or JSON-LD is ready', () => {
    expect(isCaptureReady({ title: 'Tikka', jsonLd: [], text: '2 lb chicken' })).toBe(true);
    expect(isCaptureReady({ title: 'Tikka', jsonLd: ['{}'], text: '' })).toBe(true);
  });

  test('a bot check or an empty page isn’t', () => {
    expect(isCaptureReady({ title: 'Just a moment...', jsonLd: [], text: 'Checking your browser' })).toBe(false);
    expect(isCaptureReady({ title: 'Tikka', jsonLd: [], text: '   ' })).toBe(false);
  });
});

describe('CAPTURE_SCRIPT', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  /**
   * Runs the script against a fake page and returns every page it posted. `meta` maps a selector
   * (`meta[property="og:image"]`) to its tag's `content`; `null` is a tag without one.
   */
  function runScript(page: {
    title?: string;
    blocks?: string[];
    text?: string | null;
    meta?: Record<string, string | null>;
    noQuerySelector?: boolean;
  }) {
    const posted: unknown[] = [];
    const meta = page.meta ?? {};
    const document = {
      title: page.title ?? '',
      body: page.text === null ? null : { innerText: page.text ?? '' },
      querySelectorAll: (selector: string) => {
        expect(selector).toBe('script[type="application/ld+json"]');
        return (page.blocks ?? []).map((textContent) => ({ textContent }));
      },
      ...(page.noQuerySelector
        ? {}
        : {
            querySelector: (selector: string) =>
              selector in meta ? { getAttribute: (name: string) => (name === 'content' ? meta[selector] : null) } : null,
          }),
    };
    const window = { ReactNativeWebView: { postMessage: (data: string) => posted.push(JSON.parse(data)) } };
    new Function('document', 'window', CAPTURE_SCRIPT)(document, window);
    return { posted };
  }

  test('posts the title, JSON-LD blocks, text and image at once', () => {
    const { posted } = runScript({
      title: 'Tikka',
      blocks: ['{"@type":"Recipe"}'],
      text: '2 lb chicken',
      meta: { 'meta[property="og:image"]': 'https://cdn.example.com/tikka.jpg' },
    });
    expect(posted).toEqual([
      { title: 'Tikka', jsonLd: ['{"@type":"Recipe"}'], text: '2 lb chicken', imageUrl: 'https://cdn.example.com/tikka.jpg' },
    ]);
  });

  test('the image is og:image, else twitter:image, trimmed and as written', () => {
    const image = (meta: Record<string, string | null>) => (runScript({ meta }).posted[0] as CapturedPage).imageUrl;
    const og = 'meta[property="og:image"]';
    const twitter = 'meta[name="twitter:image"]';
    expect(image({ [og]: ' /images/og.jpg ', [twitter]: 'https://cdn.example.com/tw.jpg' })).toBe('/images/og.jpg');
    expect(image({ [twitter]: 'https://cdn.example.com/tw.jpg' })).toBe('https://cdn.example.com/tw.jpg');
    // An og:image tag with no content falls back too.
    expect(image({ [og]: null, [twitter]: 'https://cdn.example.com/tw.jpg' })).toBe('https://cdn.example.com/tw.jpg');
    expect(image({ [og]: '  ' })).toBe('');
    expect(image({})).toBe('');
  });

  test('a page whose meta tags can’t be read still posts, with no image', () => {
    const { posted } = runScript({ title: 'Tikka', text: 'x', noQuerySelector: true });
    expect(posted).toEqual([{ title: 'Tikka', jsonLd: [], text: 'x', imageUrl: '' }]);
  });

  test('ends with `true`, as react-native-webview asks of injected scripts', () => {
    expect(CAPTURE_SCRIPT.trimEnd().endsWith('true;')).toBe(true);
  });

  test('posts again every interval, so a reload or a late render is seen', () => {
    const { posted } = runScript({ title: 'Tikka', text: 'x' });
    jest.advanceTimersByTime(CAPTURE_INTERVAL_MS * 3);
    expect(posted).toHaveLength(4);
  });

  test('keeps at most 10 blocks and drops empty and oversized ones', () => {
    const big = `"${'a'.repeat(MAX_JSON_LD_BLOCK_BYTES)}"`;
    const blocks = ['{"n":0}', '  ', big, ...Array.from({ length: 12 }, (_, i) => `{"n":${i + 1}}`)];
    const { posted } = runScript({ blocks });
    const jsonLd = (posted[0] as CapturedPage).jsonLd;
    expect(jsonLd).toHaveLength(MAX_JSON_LD_BLOCKS);
    expect(jsonLd[0]).toBe('{"n":0}');
    expect(jsonLd[9]).toBe('{"n":9}');
    expect(jsonLd).not.toContain(big);
  });

  test('a block exactly at the cap is kept', () => {
    const atCap = 'b'.repeat(MAX_JSON_LD_BLOCK_BYTES);
    const { posted } = runScript({ blocks: [atCap] });
    expect((posted[0] as CapturedPage).jsonLd).toEqual([atCap]);
  });

  test('cuts the text to 50 KB without splitting a character', () => {
    const text = 'é'.repeat(MAX_PAGE_TEXT_BYTES); // two bytes each
    const { posted } = runScript({ text });
    const captured = (posted[0] as CapturedPage).text;
    expect(bytes(captured)).toBe(MAX_PAGE_TEXT_BYTES);
    expect(captured).toBe('é'.repeat(MAX_PAGE_TEXT_BYTES / 2));

    const odd = `a${'€'.repeat(MAX_PAGE_TEXT_BYTES)}`; // 1 + 3 bytes each: the cut lands mid-character
    const cut = (runScript({ text: odd }).posted[0] as CapturedPage).text;
    expect(bytes(cut)).toBeLessThanOrEqual(MAX_PAGE_TEXT_BYTES);
    expect(bytes(cut)).toBeGreaterThan(MAX_PAGE_TEXT_BYTES - 3);
    expect(cut).not.toContain('�');
  });

  test('a page with no body posts empty text', () => {
    expect(runScript({ title: 'Loading', text: null }).posted).toEqual([{ title: 'Loading', jsonLd: [], text: '', imageUrl: '' }]);
  });
});

describe('parseCapturedPage', () => {
  test('reads a message from the script', () => {
    expect(parseCapturedPage(JSON.stringify({ title: 'Tikka', jsonLd: ['{}'], text: 'chicken' }))).toEqual({
      title: 'Tikka',
      jsonLd: ['{}'],
      text: 'chicken',
    });
  });

  test('applies the caps again', () => {
    const blocks = ['x'.repeat(MAX_JSON_LD_BLOCK_BYTES + 1), '', ...Array.from({ length: 11 }, (_, i) => `${i}`)];
    const page = parseCapturedPage(JSON.stringify({ title: 'T', jsonLd: blocks, text: 'é'.repeat(MAX_PAGE_TEXT_BYTES) }))!;
    expect(page.jsonLd).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(bytes(page.text)).toBe(MAX_PAGE_TEXT_BYTES);
  });

  test('wrong types fall back to empty parts', () => {
    expect(parseCapturedPage(JSON.stringify({ title: 3, jsonLd: [1, '{}', null], text: {} }))).toEqual({
      title: '',
      jsonLd: ['{}'],
      text: '',
    });
    expect(parseCapturedPage('{}')).toEqual({ title: '', jsonLd: [], text: '' });
  });

  test('keeps the image URL trimmed; leaves out an empty, non-string or over-2048-character one', () => {
    const image = (imageUrl: unknown) => parseCapturedPage(JSON.stringify({ title: 'T', imageUrl }))!;
    expect(image(' /tikka.jpg ')).toEqual({ title: 'T', jsonLd: [], text: '', imageUrl: '/tikka.jpg' });
    const atCap = `https://cdn.example.com/${'a'.repeat(2048 - 'https://cdn.example.com/'.length)}`;
    expect(image(atCap).imageUrl).toBe(atCap);
    for (const bad of ['', '   ', 42, null, `${atCap}a`]) {
      expect(image(bad)).not.toHaveProperty('imageUrl');
    }
  });

  test('anything that isn’t a JSON object is null', () => {
    expect(parseCapturedPage('not json')).toBeNull();
    expect(parseCapturedPage('null')).toBeNull();
    expect(parseCapturedPage('"text"')).toBeNull();
  });
});

describe('toRequestPage', () => {
  test('leaves out empty parts', () => {
    expect(toRequestPage({ title: 'Tikka', jsonLd: ['{}'], text: 'chicken' })).toEqual({
      title: 'Tikka',
      jsonLd: ['{}'],
      text: 'chicken',
    });
    expect(toRequestPage({ title: ' ', jsonLd: [], text: '' })).toEqual({});
    expect(toRequestPage({ title: ' ', jsonLd: [], text: '', imageUrl: ' ' })).toEqual({});
  });

  test('passes the image URL on as written, for the server to clean', () => {
    expect(toRequestPage({ title: 'Tikka', jsonLd: [], text: 'chicken', imageUrl: '/tikka.jpg' })).toEqual({
      title: 'Tikka',
      text: 'chicken',
      imageUrl: '/tikka.jpg',
    });
  });
});

describe('createCaptureSession', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const challenge = JSON.stringify({ title: 'Just a moment...', jsonLd: [], text: '' });
  const real = JSON.stringify({ title: 'Tikka', jsonLd: ['{"@type":"Recipe"}'], text: '2 lb chicken' });

  test('waits through a challenge page for the real one', () => {
    const done = jest.fn<(r: CaptureResult) => void>();
    const session = createCaptureSession(done);
    session.receive(challenge);
    session.receive('garbage');
    jest.advanceTimersByTime(CAPTURE_TIMEOUT_MS - 1);
    expect(done).not.toHaveBeenCalled();
    session.receive(real);
    expect(done).toHaveBeenCalledWith({
      ok: true,
      page: { title: 'Tikka', jsonLd: ['{"@type":"Recipe"}'], text: '2 lb chicken' },
    });
  });

  test('gives up after 20 s with a timeout', () => {
    expect(CAPTURE_TIMEOUT_MS).toBe(20_000);
    const done = jest.fn<(r: CaptureResult) => void>();
    const session = createCaptureSession(done);
    session.receive(challenge);
    jest.advanceTimersByTime(CAPTURE_TIMEOUT_MS);
    expect(done).toHaveBeenCalledWith({ ok: false, reason: 'timeout' });
  });

  test('a page that fails to load is unreachable', () => {
    const done = jest.fn<(r: CaptureResult) => void>();
    createCaptureSession(done).fail();
    expect(done).toHaveBeenCalledWith({ ok: false, reason: 'unreachable' });
  });

  test('finishes exactly once', () => {
    const done = jest.fn<(r: CaptureResult) => void>();
    const session = createCaptureSession(done, 1_000);
    session.receive(real);
    session.receive(real);
    session.fail();
    jest.advanceTimersByTime(5_000);
    expect(done).toHaveBeenCalledTimes(1);
    expect(done.mock.calls[0][0].ok).toBe(true);
  });
});

describe('capturePage', () => {
  afterEach(() => setPageCapturer(null));

  test('with nothing mounted to capture, the page is unreachable', async () => {
    expect(await capturePage('https://example.com/tikka')).toEqual({ ok: false, reason: 'unreachable' });
  });

  test('uses the registered capturer', async () => {
    const page: CapturedPage = { title: 'Tikka', jsonLd: [], text: 'chicken' };
    const capturer = jest.fn((_url: string) => Promise.resolve<CaptureResult>({ ok: true, page }));
    setPageCapturer(capturer);
    expect(await capturePage('https://example.com/tikka')).toEqual({ ok: true, page });
    expect(capturer).toHaveBeenCalledWith('https://example.com/tikka');
  });

  test('a capturer that throws is unreachable', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    setPageCapturer(() => Promise.reject(new Error('boom')));
    expect(await capturePage('https://example.com/tikka')).toEqual({ ok: false, reason: 'unreachable' });
    warn.mockRestore();
  });
});
