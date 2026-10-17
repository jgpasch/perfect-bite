// `yarn ai:recipe-photo` (spec 6.10, Tools): its arguments, media types, sips conversions and output,
// run against the mocks with in-memory files.
import { assert, assertEquals, assertStringIncludes, assertThrows } from '@std/assert';

import { CliUsageError, mediaTypeFor, parseArgs, redactBase64, run, toBase64, type CliIo, type SipsResult } from './cli.ts';

// --- parseArgs ----------------------------------------------------------------------------------------

Deno.test('parseArgs: 1 to 3 paths in order, and the flags', () => {
  assertEquals(parseArgs(['a.jpg']), { paths: ['a.jpg'], model: null, categorizeModel: null, raw: false, quiet: false, json: false, help: false });
  assertEquals(parseArgs(['--raw', 'p1.heic', '--quiet', 'p2.png', '--json', 'p3.webp']), {
    paths: ['p1.heic', 'p2.png', 'p3.webp'],
    model: null,
    categorizeModel: null,
    raw: true,
    quiet: true,
    json: true,
    help: false,
  });
  assertEquals(parseArgs(['--model', 'mock', '--categorize-model=off', 'a.jpg']).model, 'mock');
  assertEquals(parseArgs(['--model=google:gemini-3.8-flash', 'a.jpg']).model, 'google:gemini-3.8-flash');
  assertEquals(parseArgs(['--categorize-model', 'mock', 'a.jpg']).categorizeModel, 'mock');
  assertEquals(parseArgs(['-h']).help, true);
  assertEquals(parseArgs(['--help']).help, true);
  assertEquals(parseArgs(['--', '-odd name.jpg']).paths, ['-odd name.jpg']);
  assertEquals(parseArgs([]).paths, []);
});

Deno.test('parseArgs: a fourth image, an unknown flag or a flag with no value is a usage error', () => {
  assertThrows(() => parseArgs(['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']), CliUsageError, 'at most 3 images');
  assertThrows(() => parseArgs(['--dry-run', 'a.jpg']), CliUsageError, 'Unknown option: --dry-run');
  assertThrows(() => parseArgs(['--file', 'a.html']), CliUsageError, 'Unknown option');
  assertThrows(() => parseArgs(['a.jpg', '--model']), CliUsageError, '--model needs a value');
  assertThrows(() => parseArgs(['--model', '--raw', 'a.jpg']), CliUsageError, '--model needs a value');
  assertThrows(() => parseArgs(['--categorize-model=', 'a.jpg']), CliUsageError, '--categorize-model needs a value');
});

// --- mediaTypeFor --------------------------------------------------------------------------------------

Deno.test('mediaTypeFor: by extension, any case; HEIC/HEIF need converting; anything else is null', () => {
  assertEquals(mediaTypeFor('page.jpg'), 'image/jpeg');
  assertEquals(mediaTypeFor('/tmp/Page.JPEG'), 'image/jpeg');
  assertEquals(mediaTypeFor('shot.png'), 'image/png');
  assertEquals(mediaTypeFor('card.WebP'), 'image/webp');
  assertEquals(mediaTypeFor('IMG_0042.HEIC'), 'heic');
  assertEquals(mediaTypeFor('IMG_0042.heif'), 'heic');
  for (const path of ['page.gif', 'page.pdf', 'page', 'jpg', 'dir.jpg/page', 'page.jpg.txt']) assertEquals(mediaTypeFor(path), null, path);
});

// --- redactBase64 and toBase64 -------------------------------------------------------------------------

const LONG = toBase64(new Uint8Array(3000).fill(7));

Deno.test('toBase64: standard, padded base64', () => {
  assertEquals(toBase64(new TextEncoder().encode('Man')), 'TWFu');
  assertEquals(toBase64(new TextEncoder().encode('Ma')), 'TWE=');
  assertEquals(toBase64(new Uint8Array()), '');
  // Bigger than one chunk.
  const big = new Uint8Array(100_000).map((_, i) => i % 256);
  assertEquals(Uint8Array.from(atob(toBase64(big)), (c) => c.charCodeAt(0)), big);
});

Deno.test('redactBase64: long base64 becomes <N bytes base64>, in objects, arrays and JSON text', () => {
  assertEquals(redactBase64(LONG), '<3000 bytes base64>');
  const anthropic = { messages: [{ content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: LONG } }, { type: 'text', text: 'Page 1 of 1:' }] }] };
  assertEquals(redactBase64(anthropic), {
    messages: [{ content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '<3000 bytes base64>' } }, { type: 'text', text: 'Page 1 of 1:' }] }],
  });
  const google = JSON.stringify({ contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: LONG } }] }] });
  assertEquals(JSON.parse(redactBase64(google) as string), { contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: '<3000 bytes base64>' } }] }] });
});

Deno.test('redactBase64: short strings, prose, numbers and other JSON are left alone', () => {
  for (const value of ['TWFu', 'Season the chicken thighs with salt.', 42, null, true, '{"a":1', 'x'.repeat(300) + '!']) {
    assertEquals(redactBase64(value), value);
  }
  assertEquals(redactBase64({ model: 'gemini', temperature: 0, text: 'abc' }), { model: 'gemini', temperature: 0, text: 'abc' });
});

// --- run ----------------------------------------------------------------------------------------------

const JPEG = new Uint8Array(4096).fill(1);
const TINY = new Uint8Array(300).fill(2);
const OVER = new Uint8Array(2 * 1024 * 1024 + 1).fill(3);

/** Files by path, a fake sips that "writes" what `outputs` says, and everything printed. */
function io(files: Record<string, Uint8Array>, options: { sips?: 'missing' | 'fails'; outputs?: Record<string, Uint8Array> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const sipsCalls: string[][] = [];
  let n = 0;
  const cli: CliIo = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    readFile: async (path) => {
      const bytes = files[path];
      if (!bytes) throw new Deno.errors.NotFound(`No such file: ${path}`);
      return bytes;
    },
    tempPath: (ext) => `/tmp/test-${++n}${ext}`,
    sips: async (args): Promise<SipsResult> => {
      sipsCalls.push(args);
      if (options.sips === 'missing') return { ok: false, missing: true, error: 'sips not found' };
      if (options.sips === 'fails') return { ok: false, missing: false, error: 'Error: Cannot open file' };
      const target = args[args.indexOf('--out') + 1];
      files[target] = options.outputs?.[args[0]] ?? new Uint8Array(5000).fill(9);
      return { ok: true };
    },
    env: (key) => ({ AI_MODEL_CATEGORIZE: 'mock' })[key],
  };
  return { cli, out, err, sipsCalls, text: () => out.join('\n'), errors: () => err.join('\n') };
}

const MOCK = ['--model', 'mock', '--categorize-model', 'mock'];

Deno.test('run: two pages through the mocks print the recipe, its step match and the totals', async () => {
  const t = io({ 'p1.jpg': JPEG, 'p2.png': JPEG });
  assertEquals(await run([...MOCK, 'p1.jpg', 'p2.png'], t.cli), 0);
  const text = t.text();
  assertStringIncludes(text, 'AI call #1 · extractRecipePhoto · mock · OK');
  assertStringIncludes(text, 'Page 2 of 2:\n[image: image/png, 4096 bytes, sha256 ');
  assertStringIncludes(text, 'name:     Mock photo recipe');
  assertStringIncludes(text, 'servings: 4');
  assertStringIncludes(text, 'tags:     Protein: Chicken');
  assertStringIncludes(text, 'source:   p1.jpg, p2.png');
  assertStringIncludes(text, 'chicken thighs  2         lb    boneless  meat-seafood');
  assertStringIncludes(text, 'step match:');
  assertStringIncludes(text, 'Season the chicken thighs with salt.');
  assertStringIncludes(text, 'extract-recipe-photo\n');
  assert(!text.includes(toBase64(JPEG).slice(0, 40)), 'no image data printed');
  assertEquals(t.sipsCalls, []);
});

Deno.test('run --json: only the response on stdout, with no source URL or photo', async () => {
  const t = io({ 'p1.webp': JPEG });
  assertEquals(await run([...MOCK, '--json', 'p1.webp'], t.cli), 0);
  assertEquals(t.out.length, 1);
  const response = JSON.parse(t.out[0]);
  assertEquals([response.name, response.sourceUrl, response.imageUrl], ['Mock photo recipe', null, null]);
  assertStringIncludes(t.errors(), 'extractRecipePhoto');
});

Deno.test('run --quiet: no trace, just the recipe and totals', async () => {
  const t = io({ 'p1.jpg': JPEG });
  assertEquals(await run([...MOCK, '--quiet', 'p1.jpg'], t.cli), 0);
  assert(!t.text().includes('AI call #'));
  assertStringIncludes(t.text(), 'name:     Mock photo recipe');
});

Deno.test('run: a photo the mock reads as no recipe exits 1 with not_a_recipe', async () => {
  const t = io({ 'plate.jpg': TINY });
  assertEquals(await run([...MOCK, 'plate.jpg'], t.cli), 1);
  assertStringIncludes(t.errors(), "Import failed: not_a_recipe: That photo doesn't look like a recipe");
});

Deno.test('run: --model off exits 1 with unavailable', async () => {
  const t = io({ 'p1.jpg': JPEG });
  assertEquals(await run(['--model', 'off', 'p1.jpg'], t.cli), 1);
  assertStringIncludes(t.errors(), 'Import failed: unavailable');
});

Deno.test('run: HEIC is converted to JPEG with sips first, and says so', async () => {
  const t = io({ 'IMG_1.HEIC': JPEG });
  assertEquals(await run([...MOCK, 'IMG_1.HEIC'], t.cli), 0);
  assertEquals(t.sipsCalls, [['-s', 'format', 'jpeg', 'IMG_1.HEIC', '--out', '/tmp/test-1.jpg']]);
  assertStringIncludes(t.text(), 'IMG_1.HEIC: converted HEIC to JPEG with sips (/tmp/test-1.jpg)');
  assertStringIncludes(t.text(), '[image: image/jpeg, 5000 bytes');
});

Deno.test('run: HEIC without sips says how to convert it, and exits 2', async () => {
  const t = io({ 'IMG_1.heic': JPEG }, { sips: 'missing' });
  assertEquals(await run([...MOCK, 'IMG_1.heic'], t.cli), 2);
  assertStringIncludes(t.errors(), "IMG_1.heic: HEIC needs converting to JPEG and sips isn't available (it comes with macOS). Export it as JPEG first");
});

Deno.test('run: a file over 2 MB is resized to 2000 px with sips, and says so', async () => {
  const t = io({ 'big.png': OVER }, { outputs: { '-Z': new Uint8Array(900_000).fill(4) } });
  assertEquals(await run([...MOCK, 'big.png'], t.cli), 0);
  assertEquals(t.sipsCalls, [['-Z', '2000', 'big.png', '--out', '/tmp/test-1.png']]);
  assertStringIncludes(t.text(), 'big.png: 2097153 bytes is over the 2 MB cap; resized to 2000 px with sips (900000 bytes, /tmp/test-1.png)');
  assertStringIncludes(t.text(), '[image: image/png, 900000 bytes');
});

Deno.test('run: still over the cap after resizing, or sips failing, exits 2 with why', async () => {
  const still = io({ 'big.png': OVER }, { outputs: { '-Z': OVER } });
  assertEquals(await run([...MOCK, 'big.png'], still.cli), 2);
  assertStringIncludes(still.errors(), 'big.png: still 2097153 bytes at 2000 px, over the 2 MB cap');
  const fails = io({ 'big.jpg': OVER }, { sips: 'fails' });
  assertEquals(await run([...MOCK, 'big.jpg'], fails.cli), 2);
  assertStringIncludes(fails.errors(), "big.jpg: sips couldn't resize it: Error: Cannot open file");
  const missing = io({ 'big.jpg': OVER }, { sips: 'missing' });
  assertEquals(await run([...MOCK, 'big.jpg'], missing.cli), 2);
  assertStringIncludes(missing.errors(), 'over the 2 MB cap and sips isn\'t available');
});

Deno.test('run: no image, a bad extension, a missing file or no model is exit 2; -h prints the usage', async () => {
  const none = io({});
  assertEquals(await run(MOCK, none.cli), 2);
  assertStringIncludes(none.errors(), 'No image given.');
  const gif = io({ 'a.gif': JPEG });
  assertEquals(await run([...MOCK, 'a.gif'], gif.cli), 2);
  assertStringIncludes(gif.errors(), 'a.gif: not a .jpg, .jpeg, .png, .webp, .heic or .heif file');
  const missing = io({});
  assertEquals(await run([...MOCK, 'nope.jpg'], missing.cli), 2);
  assertStringIncludes(missing.errors(), "Can't read nope.jpg");
  const noModel = io({ 'p.jpg': JPEG });
  assertEquals(await run(['p.jpg'], { ...noModel.cli, env: () => undefined }), 2);
  assertStringIncludes(noModel.errors(), 'Neither AI_MODEL_RECIPE_PHOTO nor AI_MODEL_RECIPE is set');
  const help = io({});
  assertEquals(await run(['-h'], help.cli), 0);
  assertStringIncludes(help.text(), 'Usage: yarn ai:recipe-photo');
});

Deno.test('run: falls back to AI_MODEL_RECIPE when AI_MODEL_RECIPE_PHOTO is unset, and restores the env after', async () => {
  const before = Deno.env.get('AI_MODEL_RECIPE_PHOTO');
  const t = io({ 'p.jpg': JPEG });
  const env = (key: string) => ({ AI_MODEL_RECIPE: 'mock' })[key];
  assertEquals(await run(['--categorize-model', 'mock', '--quiet', 'p.jpg'], { ...t.cli, env }), 0);
  assertStringIncludes(t.text(), 'Mock photo recipe');
  assertEquals(Deno.env.get('AI_MODEL_RECIPE_PHOTO'), before);
});
