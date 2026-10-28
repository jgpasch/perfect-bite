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
import {
  MAX_PHOTO_IMPORT_BODY_BYTES,
  MAX_PHOTO_IMPORT_IMAGE_BYTES,
  MAX_PHOTO_IMPORT_IMAGES,
  RECIPE_PHOTO_MEDIA_TYPES,
} from '@/shared/schemas/recipe-photo-import';
import { ShareEnvelopeSchema, shareKind } from '@/shared/schemas/share';

import { PAGE_IMAGE_SOURCES } from '../page-capture';
import { NO_LISTS_IN_HOUSEHOLD, saveButtonTitle, SHARE_SAVED_MESSAGE } from '../save-choice';

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
      entitlements: {
        'com.apple.security.application-groups': ['group.com.jgp.perfectbite'],
        'keychain-access-groups': ['$(AppIdentifierPrefix)com.jgp.perfectbite.shared'],
      },
    });
  });

  test('activates for one web URL, one web page, text or up to 3 images, and preprocesses Safari pages', () => {
    const info = plist.parse(readFileSync(join(TARGET_DIR, 'Info.plist'), 'utf8'));
    const extension = info.NSExtension;
    expect(extension.NSExtensionPointIdentifier).toBe('com.apple.share-services');
    expect(extension.NSExtensionPrincipalClass).toBe('$(PRODUCT_MODULE_NAME).ShareViewController');
    expect(extension.NSExtensionAttributes.NSExtensionJavaScriptPreprocessingFile).toBe('Preprocess');
    expect(extension.NSExtensionAttributes.NSExtensionActivationRule).toEqual({
      NSExtensionActivationSupportsText: true,
      NSExtensionActivationSupportsWebURLWithMaxCount: 1,
      NSExtensionActivationSupportsWebPageWithMaxCount: 1,
      // 4 or more images don't offer the app (spec 4.10 step 1).
      NSExtensionActivationSupportsImageWithMaxCount: MAX_PHOTO_IMPORT_IMAGES,
    });
    expect(MAX_PHOTO_IMPORT_IMAGES).toBe(3);
  });

  test("the sheet's copy and envelope rule match save-choice.ts", () => {
    const swift = readFileSync(join(TARGET_DIR, 'ShareChoice.swift'), 'utf8');
    const view = readFileSync(join(TARGET_DIR, 'ShareViewController.swift'), 'utf8');
    expect(swift).toContain(`"${saveButtonTitle(false, null)}"`);
    expect(saveButtonTitle(true, 'X')).toBe('Save & add to X');
    expect(swift).toContain('"Save & add to \\(listName ?? "list")"');
    // One message whichever way the switch is: the server imports the share.
    expect(swift).toContain(`static let savedMessage = "${SHARE_SAVED_MESSAGE}"`);
    expect(view).toContain('SavedView(text: ShareChoice.savedMessage)');
    expect(swift).not.toContain('open The Perfect Bite');
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

// The background upload (spec 4.10 step 3) and the app's completion (modules/share-upload). Swift
// can't run here and the targets have no Swift tests, so this checks the contract between the files
// each side writes and reads, and that both sides use the same names.
describe('share background upload', () => {
  const ROOT = join(__dirname, '..', '..', '..', '..');
  const QUEUE = readFileSync(join(ROOT, 'targets', '_shared', 'ShareQueue.swift'), 'utf8');
  const VIEW = readFileSync(join(TARGET_DIR, 'ShareViewController.swift'), 'utf8');
  const MODULE_DIR = join(ROOT, 'modules', 'share-upload');
  const MODULE = readFileSync(join(MODULE_DIR, 'ios', 'ShareUploadAppDelegate.swift'), 'utf8');
  const APP_GROUP = readFileSync(join(ROOT, 'src', 'features', 'siri', 'app-group.ts'), 'utf8');
  const CREDENTIAL = readFileSync(join(ROOT, 'src', 'features', 'auth', 'device-credential.ts'), 'utf8');

  /** The string a TS `export const NAME = '…'` holds. */
  const tsConst = (source: string, name: string) => {
    const match = source.match(new RegExp(`export const ${name} = '([^']+)'`));
    expect(match).not.toBeNull();
    return match![1];
  };
  /** The string a Swift `static let name = "…"` holds. */
  const swiftConst = (source: string, name: string) => {
    const match = source.match(new RegExp(`static let ${name} = "([^"]+)"`));
    expect(match).not.toBeNull();
    return match![1];
  };

  test('the extension and the app module use the same session, App Group and paths as the app', () => {
    const appGroupId = tsConst(APP_GROUP, 'APP_GROUP_ID');
    const uploadDir = tsConst(APP_GROUP, 'SHARE_UPLOAD_DIR');
    const stateDir = tsConst(APP_GROUP, 'SHARE_UPLOAD_STATE_DIR');
    expect([appGroupId, uploadDir, stateDir]).toEqual(['group.com.jgp.perfectbite', 'share/upload', 'share/upload-state']);

    expect(swiftConst(QUEUE, 'sessionIdentifier')).toBe('com.jgp.perfectbite.share.upload');
    expect(swiftConst(QUEUE, 'uploadPath')).toBe(uploadDir);
    expect(swiftConst(QUEUE, 'uploadStatePath')).toBe(stateDir);
    expect(swiftConst(QUEUE, 'pendingPath')).toBe(tsConst(APP_GROUP, 'SHARE_PENDING_DIR'));
    expect(QUEUE).toContain('configuration.sharedContainerIdentifier = SiriQueue.appGroupId');

    expect(swiftConst(MODULE, 'sessionIdentifier')).toBe('com.jgp.perfectbite.share.upload');
    expect(swiftConst(MODULE, 'appGroupId')).toBe(appGroupId);
    expect(swiftConst(MODULE, 'uploadPath')).toBe(uploadDir);
    expect(swiftConst(MODULE, 'uploadStatePath')).toBe(stateDir);
    expect(MODULE).toContain('configuration.sharedContainerIdentifier = ShareUploadFiles.appGroupId');
  });

  test('the extension reads the credential where expo-secure-store writes it', () => {
    expect(swiftConst(QUEUE, 'accessGroup')).toBe(tsConst(CREDENTIAL, 'KEYCHAIN_ACCESS_GROUP'));
    expect(swiftConst(QUEUE, 'service')).toBe(`${tsConst(CREDENTIAL, 'KEYCHAIN_SERVICE')}:no-auth`);
    expect(swiftConst(QUEUE, 'account')).toBe(tsConst(CREDENTIAL, 'CREDENTIAL_KEY'));
    // The fields of `DeviceCredential`, all strings.
    expect(CREDENTIAL).toContain(
      'export type DeviceCredential = { token: string; userId: string; installationId: string; expiresAt: string };',
    );
    for (const field of ['token', 'userId', 'installationId', 'expiresAt']) {
      expect(QUEUE).toContain(`    let ${field}: String\n`);
    }
    // The same user (ignoring case) and not expired, else no upload.
    expect(QUEUE).toContain('credential.userId.lowercased() == userId.lowercased()');
    expect(QUEUE).toContain('let expires = parseDate(credential.expiresAt), expires > now');
  });

  test('the envelope carries v: 2 and the snapshot user', () => {
    expect(QUEUE).toContain('static let envelopeVersion = 2');
    expect(QUEUE).toContain('try c.encodeIfPresent(v, forKey: .v)');
    expect(QUEUE).toContain('try c.encodeIfPresent(userId, forKey: .userId)');
    expect(VIEW).toContain('page: page, userId: snapshot.userId)');
  });

  test('the upload starts after the atomic write, from the body file, with the bearer token and id', () => {
    const write = VIEW.indexOf('let body = try ShareQueue.enqueue(envelope)');
    const start = VIEW.indexOf('ShareUpload.start(envelope, body: body)');
    expect(write).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(write);
    expect(QUEUE).toContain('request.setValue("Bearer \\(token)", forHTTPHeaderField: "Authorization")');
    expect(QUEUE).toContain('request.setValue(id, forHTTPHeaderField: "Idempotency-Key")');
    expect(QUEUE).toContain('request.httpMethod = "POST"');
    expect(QUEUE).toContain('fromFile: uploads.appendingPathComponent(name))');
    expect(QUEUE).toContain('URLSessionConfiguration.background(withIdentifier: sessionIdentifier)');
    expect(QUEUE).toContain('Bundle.main.object(forInfoDictionaryKey: urlInfoKey)');
    // The state is { startedAt, attempts }, marked accepted on a 2xx.
    expect(QUEUE).toMatch(
      /struct State: Codable \{\n\s+var startedAt: String\n\s+var attempts: Int\n\s+var accepted: Bool\?\n\s+var acceptedAt: String\?\n/,
    );
    expect(QUEUE).toContain('State(startedAt: timestamp(), attempts: 1)');
  });

  test('a 2xx deletes the body and marks the state accepted; nothing there deletes the envelope', () => {
    const rule = 'guard error == nil, let status, (200..<300).contains(status) else { return }';
    expect(QUEUE).toContain(rule);
    expect(MODULE).toContain(rule);
    expect(QUEUE).toContain('state.accepted = true');
    expect(MODULE).toContain('state["accepted"] = true');
    // Only reconciliation deletes share/pending/<id>.json.
    const completion = (source: string) => source.slice(source.indexOf('static func complete('));
    expect(completion(QUEUE)).not.toMatch(/\bpendingPath\b|pendingDir|share\/pending/);
    expect(completion(MODULE)).not.toMatch(/\bpendingPath\b|pendingDir|share\/pending/);
  });

  test('the module is an AppDelegate subscriber that finishes only its own session', () => {
    const config = JSON.parse(readFileSync(join(MODULE_DIR, 'expo-module.config.json'), 'utf8'));
    expect(config).toEqual({ platforms: ['apple'], apple: { appDelegateSubscribers: ['ShareUploadAppDelegate'] } });
    expect(MODULE).toContain('public class ShareUploadAppDelegate: ExpoAppDelegateSubscriber {');
    expect(MODULE).toContain('handleEventsForBackgroundURLSession identifier: String,');
    // Another session's handler is called at once; ours once the events are delivered.
    expect(MODULE).toMatch(/guard identifier == ShareUploadFiles\.sessionIdentifier else \{\n\s+completionHandler\(\)\n\s+return\n/);
    expect(MODULE).toContain('func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession)');
    expect(readFileSync(join(MODULE_DIR, 'ios', 'ShareUpload.podspec'), 'utf8')).toContain("s.dependency 'ExpoModulesCore'");
  });

  test("the extension's Info.plist reads the URL from the SHARE_INGEST_URL build setting", () => {
    const info = plist.parse(readFileSync(join(TARGET_DIR, 'Info.plist'), 'utf8'));
    const { URL_SETTING } = require(join(TARGET_DIR, 'expo-target.config.js')) as { URL_SETTING: string };
    expect(URL_SETTING).toBe('SHARE_INGEST_URL');
    expect(info[swiftConst(QUEUE, 'urlInfoKey')]).toBe('$(SHARE_INGEST_URL)');
    // Local Supabase is plain http on the LAN.
    expect(info.NSAppTransportSecurity).toEqual({ NSAllowsLocalNetworking: true });
  });
});

describe('share-recipe target: the share-ingest URL', () => {
  const target = require(join(TARGET_DIR, 'expo-target.config.js')) as {
    (config: unknown): unknown;
    shareIngestUrl: (env: Record<string, string | undefined>) => string | null;
    requireShareIngestUrl: (env: Record<string, string | undefined>) => string | null;
    setShareIngestUrl: (project: unknown, url: string | null) => void;
  };

  test('is the Supabase URL the app is built with, plus /functions/v1/share-ingest', () => {
    expect(target.shareIngestUrl({ EXPO_PUBLIC_SUPABASE_URL: 'https://ardfjdorkkzymrqdihlw.supabase.co' })).toBe(
      'https://ardfjdorkkzymrqdihlw.supabase.co/functions/v1/share-ingest',
    );
    expect(target.shareIngestUrl({ EXPO_PUBLIC_SUPABASE_URL: 'http://192.168.86.29:55321/' })).toBe(
      'http://192.168.86.29:55321/functions/v1/share-ingest',
    );
    expect(target.shareIngestUrl({ EXPO_PUBLIC_SUPABASE_URL: ' https://x.supabase.co// ' })).toBe(
      'https://x.supabase.co/functions/v1/share-ingest',
    );
  });

  test('is null without a usable Supabase URL', () => {
    expect(target.shareIngestUrl({})).toBeNull();
    expect(target.shareIngestUrl({ EXPO_PUBLIC_SUPABASE_URL: '' })).toBeNull();
    expect(target.shareIngestUrl({ EXPO_PUBLIC_SUPABASE_URL: 'ardfjdorkkzymrqdihlw.supabase.co' })).toBeNull();
    expect(target.shareIngestUrl({ EXPO_PUBLIC_SUPABASE_URL: 'ftp://x.supabase.co' })).toBeNull();
  });

  test('fails an EAS build other than development without one', () => {
    expect(() => target.requireShareIngestUrl({ EAS_BUILD_PROFILE: 'production' })).toThrow(/EXPO_PUBLIC_SUPABASE_URL/);
    expect(() => target.requireShareIngestUrl({ EAS_BUILD_PROFILE: 'preview', EXPO_PUBLIC_SUPABASE_URL: '' })).toThrow(
      /"preview"/,
    );
    expect(target.requireShareIngestUrl({ EAS_BUILD_PROFILE: 'development' })).toBeNull();
    expect(target.requireShareIngestUrl({})).toBeNull();
    expect(
      target.requireShareIngestUrl({ EAS_BUILD_PROFILE: 'production', EXPO_PUBLIC_SUPABASE_URL: 'https://x.supabase.co' }),
    ).toBe('https://x.supabase.co/functions/v1/share-ingest');
  });

  test("eas.json gives the preview and production builds the hosted Supabase URL", () => {
    const eas = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'eas.json'), 'utf8'));
    const hosted = readFileSync(join(__dirname, '..', '..', '..', '..', '.env.production'), 'utf8').match(
      /^EXPO_PUBLIC_SUPABASE_URL=(.+)$/m,
    )?.[1];
    expect(hosted).toMatch(/^https:\/\//);
    for (const profile of ['preview', 'production']) {
      expect(target.requireShareIngestUrl({ ...eas.build[profile].env, EAS_BUILD_PROFILE: profile })).toBe(
        `${hosted}/functions/v1/share-ingest`,
      );
    }
  });

  /** A target as @bacons/xcode models one: its product name and build settings. */
  const fakeTarget = (productName: string) => {
    const settings: Record<string, string> = {};
    return {
      props: { productName },
      settings,
      setBuildSetting: (key: string, value: string) => {
        settings[key] = value;
      },
      removeBuildSetting: (key: string) => {
        delete settings[key];
      },
    };
  };

  test('sets the build setting on the share extension only, and removes it without a URL', () => {
    const app = fakeTarget('PerfectBite');
    const share = fakeTarget('ShareRecipe');
    const intent = fakeTarget('AddIntent');
    const project = { rootObject: { props: { targets: [app, share, intent] } } };
    target.setShareIngestUrl(project, 'https://x.supabase.co/functions/v1/share-ingest');
    expect(share.settings).toEqual({ SHARE_INGEST_URL: 'https://x.supabase.co/functions/v1/share-ingest' });
    expect(app.settings).toEqual({});
    expect(intent.settings).toEqual({});
    target.setShareIngestUrl(project, null);
    expect(share.settings).toEqual({});
  });

  test('registers an Xcode project mod that sets it from the environment', async () => {
    const config: { ios: unknown; mods?: { ios?: Record<string, (c: unknown) => Promise<unknown>> } } = {
      ios: { entitlements: { 'com.apple.security.application-groups': [], 'keychain-access-groups': [] } },
    };
    target(config);
    const mod = config.mods?.ios?.xcodeProjectBeta2;
    expect(typeof mod).toBe('function');
    const share = fakeTarget('ShareRecipe');
    const before = process.env.EXPO_PUBLIC_SUPABASE_URL;
    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://env.supabase.co';
    try {
      await mod!({
        modRequest: { nextMod: async (c: unknown) => c, platform: 'ios', modName: 'xcodeProjectBeta2' },
        modResults: { rootObject: { props: { targets: [share] } } },
      });
    } finally {
      if (before === undefined) delete process.env.EXPO_PUBLIC_SUPABASE_URL;
      else process.env.EXPO_PUBLIC_SUPABASE_URL = before;
    }
    expect(share.settings).toEqual({ SHARE_INGEST_URL: 'https://env.supabase.co/functions/v1/share-ingest' });
  });
});

// A photo share (spec 4.10 steps 1 to 3). The ImageIO work is Swift and can't run here; this checks
// its caps match the schema's, the order of the steps, the copy, and that what it writes parses.
describe('share-recipe target: photo shares', () => {
  const ROOT = join(__dirname, '..', '..', '..', '..');
  const PHOTOS = readFileSync(join(TARGET_DIR, 'SharePhotos.swift'), 'utf8');
  const VIEW = readFileSync(join(TARGET_DIR, 'ShareViewController.swift'), 'utf8');
  const QUEUE = readFileSync(join(ROOT, 'targets', '_shared', 'ShareQueue.swift'), 'utf8');
  const APP_GROUP = readFileSync(join(ROOT, 'src', 'features', 'siri', 'app-group.ts'), 'utf8');

  /** The right-hand side of a Swift `static let name… = …`. */
  const swiftValue = (source: string, name: string) => {
    const match = source.match(new RegExp(`static let ${name}(?:: [^=]+)? = (.+)\\n`));
    expect(match).not.toBeNull();
    return match![1].trim();
  };
  /** A Swift integer expression such as `2 * 1024 * 1024`. */
  const swiftInt = (source: string, name: string) => {
    const value = swiftValue(source, name);
    expect(value).toMatch(/^\d+( \* \d+)*$/);
    return value.split(' * ').reduce((product, n) => product * Number(n), 1);
  };
  /** The body of a Swift `func name(`, up to the next `func`. */
  const swiftFunc = (source: string, name: string) => {
    const start = source.indexOf(`func ${name}(`);
    expect(start).toBeGreaterThan(-1);
    const next = source.indexOf(' func ', start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  };

  test("the caps are the schema's: 3 pages of at most 2 MB, JPEG only", () => {
    expect(swiftInt(PHOTOS, 'maxImages')).toBe(MAX_PHOTO_IMPORT_IMAGES);
    expect(swiftInt(PHOTOS, 'maxImageBytes')).toBe(MAX_PHOTO_IMPORT_IMAGE_BYTES);
    expect(MAX_PHOTO_IMPORT_IMAGE_BYTES).toBe(2 * 1024 * 1024);
    expect(swiftValue(PHOTOS, 'mediaType')).toBe('"image/jpeg"');
    expect(RECIPE_PHOTO_MEDIA_TYPES).toContain('image/jpeg');
    // Only the first 3 image providers are read.
    expect(PHOTOS).toContain('.prefix(maxImages)');
  });

  test('downscales to a 2000 px long edge with ImageIO, stepping the quality down from 0.8', () => {
    expect(swiftInt(PHOTOS, 'maxPixelSize')).toBe(2000);
    expect(swiftValue(PHOTOS, 'qualities')).toBe('[0.8, 0.6, 0.4]');
    const downscale = swiftFunc(PHOTOS, 'downscale');
    expect(downscale).toContain('CGImageSourceCreateThumbnailAtIndex(source, 0, options)');
    expect(downscale).toContain('kCGImageSourceCreateThumbnailWithTransform: true');
    expect(downscale).toContain('kCGImageSourceThumbnailMaxPixelSize: maxPixelSize');
    // Each quality is tried in order until the JPEG is within the cap; over it at 0.4 is unreadable.
    const page = swiftFunc(PHOTOS, 'page');
    expect(page).toContain('for quality in qualities {');
    expect(page).toContain('if data.count <= maxImageBytes { return data }');
    expect(page).toContain('autoreleasepool');
    expect(swiftFunc(PHOTOS, 'encode')).toContain('kCGImageDestinationLossyCompressionQuality: quality');
    // Never a full-size bitmap: no UIImage from the original, and the source doesn't cache it.
    expect(PHOTOS).not.toMatch(/UIImage\(/);
    expect(PHOTOS).not.toContain('CGImageSourceCreateImageAtIndex');
    expect(PHOTOS).toContain('kCGImageSourceShouldCache: false');
  });

  test('thumbnails are 400 px at 0.7, from the same source, in share/thumbs/<id>/<n>.jpg', () => {
    expect(swiftInt(PHOTOS, 'thumbPixelSize')).toBe(400);
    expect(swiftValue(PHOTOS, 'thumbQuality')).toBe('0.7');
    expect(swiftFunc(PHOTOS, 'page')).toContain(
      'downscale(source, maxPixelSize: thumbPixelSize).flatMap { encode($0, quality: thumbQuality) }',
    );
    const thumbsDir = APP_GROUP.match(/export const SHARE_THUMBS_DIR = '([^']+)'/)?.[1];
    expect(thumbsDir).toBe('share/thumbs');
    expect(swiftValue(PHOTOS, 'thumbsPath')).toBe(`"${thumbsDir}"`);
    const write = swiftFunc(PHOTOS, 'writeThumbs');
    expect(write).toContain('ShareQueue.dir("\\(thumbsPath)/\\(id)")');
    // n from 1, as share-images' <n>.jpg.
    expect(write).toContain('name: "\\(index + 1).jpg"');
  });

  test('images are read only when no web URL was found, one at a time, stopping at an unreadable one', () => {
    const load = swiftFunc(VIEW, 'load');
    const link = load.indexOf('await loadLink(providers)');
    const photos = load.indexOf('if url == nil { await loadPhotos(SharePhotos.imageProviders(providers)) }');
    expect(link).toBeGreaterThan(-1);
    expect(photos).toBeGreaterThan(link);
    const loadPhotos = swiftFunc(VIEW, 'loadPhotos');
    expect(loadPhotos).toContain('for provider in providers {');
    expect(loadPhotos).toMatch(
      /guard let photo = await SharePhotos\.load\(provider\) else \{\n\s+unreadableImage = true\n\s+return\n/,
    );
    // The link order is as before: Safari's page, then a URL, then text.
    const loadLink = swiftFunc(VIEW, 'loadLink');
    expect(loadLink.indexOf('UTType.propertyList')).toBeGreaterThan(-1);
    expect(loadLink.indexOf('UTType.propertyList')).toBeLessThan(loadLink.indexOf('UTType.url'));
    expect(loadLink.indexOf('UTType.url')).toBeLessThan(loadLink.indexOf('UTType.plainText'));
  });

  test('an unreadable image disables Save; a photo share saves without a URL', () => {
    expect(VIEW).toContain('var isPhotoShare: Bool { url == nil && (!photos.isEmpty || unreadableImage) }');
    expect(VIEW).toContain('(url != nil || (!photos.isEmpty && !unreadableImage))');
    expect(VIEW).toContain('.disabled(!model.canSave)');
  });

  test('the sheet shows "From a photo", "2 pages" and "Couldn\'t read that image"', () => {
    expect(PHOTOS).toContain('pageCount <= 1 ? "From a photo" : "\\(pageCount) pages"');
    expect(PHOTOS).toContain('static let unreadableMessage = "Couldn\'t read that image"');
    expect(VIEW).toContain('Text(SharePhotos.unreadableMessage)');
    // 3:4 thumbnails.
    expect(VIEW).toContain('.frame(width: 72, height: 96)');
    // The household, switch and list stay as for a link.
    const content = VIEW.slice(VIEW.indexOf('PhotoHeader('), VIEW.indexOf('Button(action: model.save)'));
    expect(content).toContain('AddToListRow(model: model)');
    expect(content).toContain('SectionLabel(text: "Save to")');
  });

  test('saving writes the thumbnails, then a v: 3 envelope, then starts the upload, logging no image data', () => {
    const save = swiftFunc(VIEW, 'save');
    const thumbs = save.indexOf('if url == nil { try SharePhotos.writeThumbs(photos, id: envelope.id) }');
    const write = save.indexOf('let body = try ShareQueue.enqueue(envelope)');
    const upload = save.indexOf('ShareUpload.start(envelope, body: body)');
    expect(thumbs).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(thumbs);
    expect(upload).toBeGreaterThan(write);
    expect(save).toContain('images: SharePhotos.envelopeImages(photos)');

    const photo = swiftFunc(QUEUE, 'makePhotoEnvelope');
    expect(photo).toContain('v: photoEnvelopeVersion');
    expect(photo).toContain('url: nil, images: images');
    expect(photo).toContain('page: nil');
    expect(photo).toContain('listId: addToList ? listId : nil');
    expect(swiftInt(QUEUE, 'photoEnvelopeVersion')).toBe(3);

    // Log lines carry counts and sizes only.
    const logs = [...VIEW.matchAll(/SiriQueue\.log\(([\s\S]*?)\)\n/g)].map((m) => m[1]);
    expect(logs.length).toBeGreaterThanOrEqual(3);
    for (const line of logs) expect(line).not.toMatch(/base64|\.data\b|envelopeImages|thumbnails\b|\.thumb\b/);
    expect(VIEW).toContain('images=\\(photos.count)');
    expect(VIEW).toContain('body=\\(body.count)');
  });

  /** The envelope `makePhotoEnvelope` writes, with `pages` images of `bytes` decoded bytes each. */
  const photoEnvelope = (pages: number, bytes: number) => ({
    v: 3,
    id: '0193a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b',
    userId: '11111111-1111-4111-8111-111111111111',
    images: Array.from({ length: pages }, (_, i) => ({
      mediaType: 'image/jpeg',
      data: Buffer.alloc(bytes, i + 1).toString('base64'),
    })),
    listId: null,
    householdId: '22222222-2222-4222-8222-222222222222',
    addToList: false,
    createdAt: '2026-10-28T09:15:00.000-07:00',
    appVersion: '1.0.0',
    source: 'share',
  });

  test('a 3-page envelope of 1 MB pages (~4 MB) parses as a photo share and is within the body cap', () => {
    // JSONEncoder escapes slashes.
    const body = JSON.stringify(photoEnvelope(3, 1024 * 1024)).replace(/\//g, '\\/');
    expect(body.length).toBeGreaterThan(4 * 1024 * 1024);
    expect(body.length).toBeLessThan(MAX_PHOTO_IMPORT_BODY_BYTES);
    const parsed = ShareEnvelopeSchema.safeParse(JSON.parse(body));
    expect(parsed.success).toBe(true);
    expect(shareKind(parsed.data!)).toBe('photo');
    expect(parsed.data!.images).toHaveLength(3);
  });

  test('a page at the 2 MB cap parses; one byte over, or a fourth page, is refused', () => {
    expect(ShareEnvelopeSchema.safeParse(photoEnvelope(1, MAX_PHOTO_IMPORT_IMAGE_BYTES)).success).toBe(true);
    expect(ShareEnvelopeSchema.safeParse(photoEnvelope(1, MAX_PHOTO_IMPORT_IMAGE_BYTES + 1)).success).toBe(false);
    expect(ShareEnvelopeSchema.safeParse(photoEnvelope(MAX_PHOTO_IMPORT_IMAGES + 1, 10)).success).toBe(false);
  });
});
