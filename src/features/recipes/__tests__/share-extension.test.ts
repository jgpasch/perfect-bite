import { describe, expect, jest, test } from '@jest/globals';
import plist from '@expo/plist';
import { readFileSync } from 'fs';
import { join } from 'path';

import { Palette } from '@/constants/theme';
import { MAX_IMAGE_URL_LENGTH } from '@/shared/recipe-jsonld';
import {
  MAX_JSON_LD_BLOCK_BYTES,
  MAX_JSON_LD_BLOCKS,
  MAX_PAGE_TEXT_BYTES,
  RecipeImportPageSchema,
} from '@/shared/schemas/recipe-import';

import { PAGE_IMAGE_SOURCES } from '../page-capture';
import { NO_LISTS_IN_HOUSEHOLD, saveButtonTitle, shareSavedMessage } from '../save-choice';

jest.mock('@/global.css', () => ({}));

// The share extension (spec 4.10) is Swift and can't run here; these check the parts that can:
// Safari's Preprocess.js, the target's config and activation rule, and that the sheet's colours
// match the theme.

const TARGET_DIR = join(__dirname, '..', '..', '..', '..', 'targets', 'share-recipe');
const PREPROCESS = readFileSync(join(TARGET_DIR, 'Preprocess.js'), 'utf8');

const bytes = (s: string) => new TextEncoder().encode(s).length;

type Results = { url: string; title: string; jsonLd: string[]; text: string; imageUrl: string };

/**
 * Runs Preprocess.js as Safari does, against a fake page, and returns what it hands the extension.
 * `tags` maps a selector to the attributes of its first match.
 */
function preprocess(page: {
  url?: string;
  title?: string;
  blocks?: string[];
  text?: string | null;
  tags?: Record<string, Record<string, string>>;
  throwOnQuery?: boolean;
}): Results {
  const tags = page.tags ?? {};
  const document = {
    URL: page.url ?? 'https://example.com/tikka',
    title: page.title ?? '',
    body: page.text === null ? null : { innerText: page.text ?? '' },
    querySelectorAll: (selector: string) => {
      if (page.throwOnQuery) throw new Error('blocked');
      expect(selector).toBe('script[type="application/ld+json"]');
      return (page.blocks ?? []).map((textContent) => ({ textContent }));
    },
    querySelector: (selector: string) => {
      if (page.throwOnQuery) throw new Error('blocked');
      const attrs = tags[selector];
      return attrs ? { getAttribute: (name: string) => attrs[name] ?? null } : null;
    },
  };
  const js = new Function('document', `${PREPROCESS}\nreturn ExtensionPreprocessingJS;`)(document) as {
    run: (args: { completionFunction: (r: Results) => void }) => void;
  };
  const results: Results[] = [];
  js.run({ completionFunction: (r) => results.push(r) });
  expect(results).toHaveLength(1);
  return results[0];
}

describe('Preprocess.js', () => {
  test('returns the URL, title, JSON-LD blocks and text', () => {
    const results = preprocess({
      url: 'https://www.bbcgoodfood.com/recipes/chicken-tikka-masala',
      title: 'Chicken tikka masala',
      blocks: ['{"@type":"Recipe","name":"Chicken tikka masala"}'],
      text: '2 lb chicken\n1 cup yogurt',
    });
    expect(results).toEqual({
      url: 'https://www.bbcgoodfood.com/recipes/chicken-tikka-masala',
      title: 'Chicken tikka masala',
      jsonLd: ['{"@type":"Recipe","name":"Chicken tikka masala"}'],
      text: '2 lb chicken\n1 cup yogurt',
      imageUrl: '',
    });
  });

  // The lost photo (spec 6.6 step 5): Safari shares sent no image, so a page whose JSON-LD has none
  // (a Yoast @graph without a Recipe) imported with no photo though it had an og:image.
  test('returns the page’s og:image as imageUrl, as written and trimmed', () => {
    const photo = 'https://snacks.webxo.xyz/wp-content/uploads/2026/05/Screenshot-2026-03-23-112812.png';
    const results = preprocess({ title: 'Bread', text: '1 cup cottage cheese', tags: { 'meta[property="og:image"]': { content: ` ${photo} ` } } });
    expect(results.imageUrl).toBe(photo);
  });

  test('falls back through the same tags as CAPTURE_SCRIPT, in order', () => {
    const image = (tags: Record<string, Record<string, string>>) => preprocess({ tags }).imageUrl;
    expect(image({ 'meta[property="og:image"]': { content: '' }, 'meta[name="twitter:image"]': { content: '/tw.jpg' } })).toBe('/tw.jpg');
    expect(image({ 'meta[name="twitter:image:src"]': { content: '/src.jpg' }, 'link[rel~="image_src"]': { href: '/l.jpg' } })).toBe('/src.jpg');
    expect(image({ 'link[rel~="image_src"]': { href: '/l.jpg' }, '[itemprop~="image"]': { content: '/m.jpg' } })).toBe('/l.jpg');
    expect(image({ '[itemprop~="image"]': { src: '/s.jpg', href: '/h.jpg' } })).toBe('/s.jpg');
    expect(image({})).toBe('');
  });

  test('its list of photo tags is PAGE_IMAGE_SOURCES', () => {
    expect(PREPROCESS).toContain(`var IMAGE_SOURCES = ${JSON.stringify(PAGE_IMAGE_SOURCES)};`);
  });

  test('leaves out an image URL too long for the request', () => {
    const long = `https://cdn.example.com/${'a'.repeat(MAX_IMAGE_URL_LENGTH)}`;
    expect(preprocess({ tags: { 'meta[property="og:image"]': { content: long } } }).imageUrl).toBe('');
    const atCap = `https://cdn.example.com/${'a'.repeat(MAX_IMAGE_URL_LENGTH - 24)}`;
    expect(atCap.length).toBe(MAX_IMAGE_URL_LENGTH);
    expect(preprocess({ tags: { 'meta[property="og:image"]': { content: atCap } } }).imageUrl).toBe(atCap);
  });

  test('uses the same caps as the import request', () => {
    expect(PREPROCESS).toContain(`var MAX_BLOCKS = ${MAX_JSON_LD_BLOCKS};`);
    expect(PREPROCESS).toContain(`var MAX_BLOCK_BYTES = ${MAX_JSON_LD_BLOCK_BYTES};`);
    expect(PREPROCESS).toContain(`var MAX_TEXT_BYTES = ${MAX_PAGE_TEXT_BYTES};`);
  });

  test('keeps at most 10 blocks and drops empty and oversized ones', () => {
    const big = `"${'a'.repeat(MAX_JSON_LD_BLOCK_BYTES)}"`;
    const blocks = ['{"n":0}', '  ', '', big, ...Array.from({ length: 12 }, (_, i) => `{"n":${i + 1}}`)];
    const { jsonLd } = preprocess({ blocks });
    expect(jsonLd).toHaveLength(10);
    expect(jsonLd[0]).toBe('{"n":0}');
    expect(jsonLd[1]).toBe('{"n":1}');
    expect(jsonLd[9]).toBe('{"n":9}');
    expect(jsonLd).not.toContain(big);
  });

  test('keeps a block exactly at the cap and drops one a byte over, counting UTF-8 bytes', () => {
    const atCap = 'b'.repeat(MAX_JSON_LD_BLOCK_BYTES);
    // 'é' is 2 bytes: one character fewer than the cap, but a byte over it.
    const overByMultibyte = `${'b'.repeat(MAX_JSON_LD_BLOCK_BYTES - 1)}é`;
    expect(overByMultibyte.length).toBe(MAX_JSON_LD_BLOCK_BYTES);
    const { jsonLd } = preprocess({ blocks: [atCap, overByMultibyte] });
    expect(jsonLd).toEqual([atCap]);
  });

  test('cuts the text at 50 KB of UTF-8 without splitting a character', () => {
    const text = '🍅'.repeat(MAX_PAGE_TEXT_BYTES); // 4 bytes each
    const results = preprocess({ text });
    expect(bytes(results.text)).toBe(MAX_PAGE_TEXT_BYTES);
    expect(results.text).toBe('🍅'.repeat(MAX_PAGE_TEXT_BYTES / 4));

    const odd = `a${'🍅'.repeat(MAX_PAGE_TEXT_BYTES)}`; // the cap falls inside a tomato
    const cut = preprocess({ text: odd }).text;
    expect(bytes(cut)).toBe(MAX_PAGE_TEXT_BYTES - 3);
    expect(cut.endsWith('🍅')).toBe(true);
    expect(cut).not.toContain('�');
  });

  test('keeps text at the cap whole', () => {
    const text = 'x'.repeat(MAX_PAGE_TEXT_BYTES);
    expect(preprocess({ text }).text).toBe(text);
  });

  test('a page with no body, title or JSON-LD still returns its URL', () => {
    expect(preprocess({ url: 'https://example.com/a', text: null })).toEqual({
      url: 'https://example.com/a',
      title: '',
      jsonLd: [],
      text: '',
      imageUrl: '',
    });
  });

  test('a page that throws while being read still returns its URL and title', () => {
    expect(preprocess({ title: 'Tikka', text: 'x', throwOnQuery: true })).toEqual({
      url: 'https://example.com/tikka',
      title: 'Tikka',
      jsonLd: [],
      text: '',
      imageUrl: '',
    });
  });

  test('what it returns at the caps passes the share envelope page schema', () => {
    const { title, jsonLd, text, imageUrl } = preprocess({
      title: 'Tikka',
      blocks: Array.from({ length: 12 }, () => 'c'.repeat(MAX_JSON_LD_BLOCK_BYTES)),
      text: 'é'.repeat(MAX_PAGE_TEXT_BYTES),
      tags: { 'meta[property="og:image"]': { content: `https://cdn.example.com/${'a'.repeat(MAX_IMAGE_URL_LENGTH - 24)}` } },
    });
    const parsed = RecipeImportPageSchema.safeParse({ title, jsonLd, text, imageUrl });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.imageUrl).toBe(imageUrl);
  });
});

describe('share-recipe target', () => {
  test('is a share extension named The Perfect Bite with the App Group', () => {
    const configure = require(join(TARGET_DIR, 'expo-target.config.js')) as (config: unknown) => Record<string, unknown>;
    const appJson = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'app.json'), 'utf8'));
    expect(configure(appJson.expo)).toEqual({
      type: 'share',
      name: 'ShareRecipe',
      displayName: 'The Perfect Bite',
      bundleIdentifier: '.share',
      frameworks: ['SwiftUI', 'UniformTypeIdentifiers'],
      entitlements: { 'com.apple.security.application-groups': ['group.com.jgp.perfectbite'] },
    });
  });

  test('activates for one web URL, one web page or text, never images, and preprocesses Safari pages', () => {
    const info = plist.parse(readFileSync(join(TARGET_DIR, 'Info.plist'), 'utf8'));
    const extension = info.NSExtension;
    expect(extension.NSExtensionPointIdentifier).toBe('com.apple.share-services');
    expect(extension.NSExtensionPrincipalClass).toBe('$(PRODUCT_MODULE_NAME).ShareViewController');
    expect(extension.NSExtensionAttributes.NSExtensionJavaScriptPreprocessingFile).toBe('Preprocess');
    expect(extension.NSExtensionAttributes.NSExtensionActivationRule).toEqual({
      NSExtensionActivationSupportsText: true,
      NSExtensionActivationSupportsWebURLWithMaxCount: 1,
      NSExtensionActivationSupportsWebPageWithMaxCount: 1,
    });
  });

  test("the sheet's copy and envelope rule match save-choice.ts", () => {
    const swift = readFileSync(join(TARGET_DIR, 'ShareChoice.swift'), 'utf8');
    const view = readFileSync(join(TARGET_DIR, 'ShareViewController.swift'), 'utf8');
    expect(swift).toContain(`"${saveButtonTitle(false, null)}"`);
    expect(saveButtonTitle(true, 'X')).toBe('Save & add to X');
    expect(swift).toContain('"Save & add to \\(listName ?? "list")"');
    expect(swift).toContain(`"${shareSavedMessage(true)}"`);
    expect(swift).toContain(`"${shareSavedMessage(false)}"`);
    expect(swift).toContain(`static let noListsMessage = "${NO_LISTS_IN_HOUSEHOLD}"`);
    expect(swift).toContain('let on = addToList && listId != nil');
    expect(swift).toContain('static let path = "share/prefs.json"');
    // Set up shows with no households, not with no lists.
    expect(view).toContain('} else if model.households.isEmpty {\n      Message(text: "Open The Perfect Bite once to set up")');
    expect(view).toContain('"Also add ingredients to a list"');
    expect(view).toContain('"Adds the recipe\'s ingredients to the chosen list"');
  });

  test("the sheet's colours match the theme in both schemes", () => {
    const swift = readFileSync(join(TARGET_DIR, 'ShareViewController.swift'), 'utf8');
    const colours = [...swift.matchAll(/static let (\w+) = dynamic\(light: 0x([0-9A-F]{6}), dark: 0x([0-9A-F]{6})\)/g)];
    expect(colours.length).toBeGreaterThanOrEqual(10);
    for (const [, token, light, dark] of colours) {
      const name = token as keyof typeof Palette.light;
      expect([token, `#${light}`, `#${dark}`]).toEqual([token, Palette.light[name], Palette.dark[name]]);
    }
  });
});
