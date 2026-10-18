// Tests for `yarn ai:image` with the mock models; nothing touches the network or the disk.
import { assertEquals, assertFalse, assertStringIncludes, assertThrows } from '@std/assert';

import { MOCK_PHOTO_DESCRIPTION } from '../_shared/ai/mock-model.ts';
import { MOCK_RECIPE_PHOTO_JPEG } from '../_shared/fixtures/mock-recipe-photo.ts';
import { CliUsageError, formatImageCost, imageFileName, parseArgs, run, type CliIo } from './cli.ts';

const MODEL_VARS = ['AI_MODEL_PHOTO_DESCRIPTION', 'AI_MODEL_TAGS', 'AI_MODEL_RECIPE'] as const;

/** Runs `fn` with the description model vars unset, and checks the CLI restored them. */
async function withCleanEnv<T>(fn: () => Promise<T>): Promise<T> {
  const saved = MODEL_VARS.map((k) => [k, Deno.env.get(k)] as const);
  for (const k of MODEL_VARS) Deno.env.delete(k);
  try {
    const result = await fn();
    for (const k of MODEL_VARS) assertEquals(Deno.env.get(k), undefined, `${k} restored`);
    return result;
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

function io(env: Record<string, string> = {}) {
  let out = '';
  let err = '';
  const files: { path: string; bytes: Uint8Array }[] = [];
  const cliIo: CliIo = {
    out: (t) => (out += `${t}\n`),
    err: (t) => (err += `${t}\n`),
    writeFile: async (path, bytes) => void files.push({ path, bytes }),
    fetch: (() => Promise.reject(new Error('no network in tests'))) as typeof fetch,
    env: (key) => env[key],
    now: () => new Date('2026-10-18T12:34:56.789Z'),
  };
  return { cliIo, out: () => out, err: () => err, files };
}

Deno.test('parseArgs: a URL, a file, or a typed recipe, and the options', () => {
  assertEquals(parseArgs(['https://example.com/r']).url, 'https://example.com/r');
  assertEquals(parseArgs(['--file', 'page.html']).file, 'page.html');
  const typed = parseArgs(['--title', 'Fish tacos', '--ingredients', 'cod, corn tortillas,, ', '--ingredients=lime', '--cuisine', 'mexican', '--quality', 'low', '--image-model=mock', '--describe-only']);
  assertEquals([typed.title, typed.ingredients, typed.cuisines], ['Fish tacos', ['cod', 'corn tortillas', 'lime'], ['mexican']]);
  assertEquals([typed.quality, typed.imageModel, typed.describeOnly, typed.out], ['low', 'mock', true, 'generated-images']);
  assertThrows(() => parseArgs([]), CliUsageError, 'No recipe given');
  assertThrows(() => parseArgs(['https://a', '--title', 'x']), CliUsageError, 'Give one recipe');
  assertThrows(() => parseArgs(['--ingredients', 'cod']), CliUsageError, 'needs a --title');
  assertThrows(() => parseArgs(['--title', 'x', '--quality', 'ultra']), CliUsageError, '--quality must be one of');
  assertThrows(() => parseArgs(['--title']), CliUsageError, 'needs a value');
  assertThrows(() => parseArgs(['--nope']), CliUsageError, 'Unknown option');
  assertEquals(parseArgs(['-h']).help, true);
});

Deno.test('imageFileName and formatImageCost', () => {
  assertEquals(imageFileName('Grandma’s Fish Tacos!', new Date('2026-10-18T12:34:56.789Z')), 'grandma-s-fish-tacos-2026-10-18T12-34-56.jpg');
  assertEquals(imageFileName('寿司', new Date('2026-10-18T12:34:56Z')), 'recipe-2026-10-18T12-34-56.jpg');
  assertEquals(formatImageCost({ model: 'mock', quality: 'medium', usage: null, ms: 1 }), 'image:          mock (the fixed test JPEG), no cost');
  assertEquals(
    formatImageCost({ model: 'gpt-image-1-mini', quality: 'medium', usage: { inputTokens: 100, outputTokens: 1584 }, ms: 9000 }),
    'image:          gpt-image-1-mini, medium, 1536x1024, 100 in / 1584 out tokens, 9000 ms, about $0.013',
  );
  assertStringIncludes(formatImageCost({ model: 'gpt-image-1', quality: 'high', usage: null, ms: 1 }), 'cost unknown');
});

Deno.test('run: a typed recipe with the mocks prints the description and writes the image', async () => {
  await withCleanEnv(async () => {
    const t = io();
    const code = await run(['--title', 'Fish tacos', '--ingredients', 'cod, corn tortillas', '--cuisine', 'mexican', '--model', 'mock', '--image-model', 'mock', '--quiet'], t.cliIo);
    assertEquals(code, 0, t.err());
    assertStringIncludes(t.out(), 'ingredients: cod, corn tortillas');
    assertStringIncludes(t.out(), 'cuisines: Mexican');
    assertStringIncludes(t.out(), `description: ${MOCK_PHOTO_DESCRIPTION}`);
    assertStringIncludes(t.out(), `The dish: ${MOCK_PHOTO_DESCRIPTION}`);
    assertStringIncludes(t.out(), 'Wrote generated-images/fish-tacos-2026-10-18T12-34-56.jpg');
    assertStringIncludes(t.out(), 'mock (the fixed test JPEG), no cost');
    assertEquals(t.files, [{ path: 'generated-images/fish-tacos-2026-10-18T12-34-56.jpg', bytes: MOCK_RECIPE_PHOTO_JPEG }]);
  });
});

Deno.test('run: --describe-only makes no image', async () => {
  await withCleanEnv(async () => {
    const t = io();
    assertEquals(await run(['--title', 'Soup', '--ingredients', 'leeks', '--model', 'mock', '--describe-only', '--quiet'], t.cliIo), 0);
    assertStringIncludes(t.out(), `description: ${MOCK_PHOTO_DESCRIPTION}`);
    assertFalse(t.out().includes('image prompt'));
    assertEquals(t.files, []);
  });
});

Deno.test('run: a refused recipe exits 1 with not_food and writes nothing', async () => {
  await withCleanEnv(async () => {
    const t = io();
    assertEquals(await run(['--title', 'Slime (not food)', '--ingredients', 'glue', '--model', 'mock', '--image-model', 'mock', '--quiet'], t.cliIo), 1);
    assertStringIncludes(t.err(), 'Failed: not_food (by the description)');
    assertEquals(t.files, []);
  });
});

Deno.test('run: no description model, or no OpenAI key for a real image model, is bad usage', async () => {
  await withCleanEnv(async () => {
    const none = io();
    assertEquals(await run(['--title', 'Soup', '--image-model', 'mock'], none.cliIo), 2);
    assertStringIncludes(none.err(), 'No description model');
    const noKey = io({ AI_MODEL_TAGS: 'mock' });
    assertEquals(await run(['--title', 'Soup'], noKey.cliIo), 2);
    assertStringIncludes(noKey.err(), 'OPENAI_API_KEY is not set');
    const off = io({ AI_MODEL_TAGS: 'mock', AI_IMAGE_MODEL: 'off' });
    assertEquals(await run(['--title', 'Soup'], off.cliIo), 2);
    assertStringIncludes(off.err(), 'AI_IMAGE_MODEL is off');
  });
});
