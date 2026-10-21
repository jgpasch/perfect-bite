// Tests for `yarn ai:image` with the mock models; nothing touches the network or the disk.
import { assert, assertEquals, assertFalse, assertStringIncludes, assertThrows } from '@std/assert';

import { MOCK_PHOTO_DESCRIPTION } from '../_shared/ai/mock-model.ts';
import { MOCK_RECIPE_PHOTO_JPEG } from '../_shared/fixtures/mock-recipe-photo.ts';
import { CliUsageError, formatImageCost, formatModeration, imageFileName, parseArgs, run, USAGE, type CliIo } from './cli.ts';

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

function io(env: Record<string, string> = {}, fetch: typeof globalThis.fetch = (() => Promise.reject(new Error('no network in tests'))) as typeof globalThis.fetch) {
  let out = '';
  let err = '';
  const files: { path: string; bytes: Uint8Array }[] = [];
  const cliIo: CliIo = {
    out: (t) => (out += `${t}\n`),
    err: (t) => (err += `${t}\n`),
    writeFile: async (path, bytes) => void files.push({ path, bytes }),
    fetch,
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

// --- moderation and --description -----------------------------------------------------------------------

/** A fake OpenAI answering every request with `body`, recording each URL. */
function openAi(body: unknown) {
  const urls: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { urls, fetch };
}

const FLAGGED = { results: [{ flagged: true, categories: { violence: true, 'self-harm': true, sexual: false } }] };

Deno.test('parseArgs: --description, alone or with output options, and never with a recipe', () => {
  const args = parseArgs(['--description', 'Golden rice in a clay bowl.', '--image-model', 'mock', '--quiet']);
  assertEquals([args.description, args.url, args.file, args.title, args.imageModel], ['Golden rice in a clay bowl.', null, null, null, 'mock']);
  assertEquals(parseArgs(['--description=Soup']).description, 'Soup');
  for (const argv of [
    ['--description', 'Soup', '--title', 'Soup'],
    ['--description', 'Soup', '--ingredients', 'leeks'],
    ['--description', 'Soup', '--file', 'page.html'],
    ['--description', 'Soup', 'https://example.com/r'],
  ]) {
    assertThrows(() => parseArgs(argv), CliUsageError, '--description skips the recipe', argv.join(' '));
  }
  assertThrows(() => parseArgs(['--description', 'Soup', '--describe-only']), CliUsageError, '--describe-only has nothing to do');
  assertThrows(() => parseArgs(['--description']), CliUsageError, 'needs a value');
  assertStringIncludes(USAGE, '--description <text>');
});

Deno.test('formatModeration: not flagged, or flagged with its categories', () => {
  assertEquals(formatModeration({ flagged: false, categories: [] }), 'moderation:     not flagged');
  assertEquals(formatModeration({ flagged: true, categories: ['self-harm', 'violence'] }), 'moderation:     flagged (self-harm, violence)');
  assertEquals(formatModeration({ flagged: true, categories: [] }), 'moderation:     flagged (no category)');
});

Deno.test('run: a typed recipe prints the moderation answer before the image', async () => {
  await withCleanEnv(async () => {
    const t = io();
    assertEquals(await run(['--title', 'Soup', '--ingredients', 'leeks', '--model', 'mock', '--image-model', 'mock', '--quiet'], t.cliIo), 0, t.err());
    assertStringIncludes(t.out(), 'moderation:     not flagged');
    assert(t.out().indexOf('moderation:') < t.out().indexOf('--- image prompt'));
  });
});

Deno.test('run: a flagged image prompt stops before the image, exit 1, nothing written', async () => {
  await withCleanEnv(async () => {
    const fake = openAi(FLAGGED);
    const t = io({ OPENAI_API_KEY: 'sk-test' }, fake.fetch);
    assertEquals(await run(['--title', 'Soup', '--ingredients', 'leeks', '--model', 'mock', '--quiet'], t.cliIo), 1);
    assertStringIncludes(t.out(), 'moderation:     flagged (self-harm, violence)');
    assertStringIncludes(t.err(), 'Failed: not_food (by the moderation)');
    assertEquals(fake.urls, ['https://api.openai.com/v1/moderations']);
    assertEquals(t.files, []);
  });
});

Deno.test('run --description: no description model needed; a flagged prompt is free and stops before the image', async () => {
  await withCleanEnv(async () => {
    const fake = openAi(FLAGGED);
    const t = io({ OPENAI_API_KEY: 'sk-test' }, fake.fetch);
    assertEquals(await run(['--description', 'A  bloody   steak\non a plate.', '--quiet'], t.cliIo), 1);
    assertStringIncludes(t.out(), 'The dish: A bloody steak on a plate.');
    assertStringIncludes(t.out(), 'moderated with openai:omni-moderation-latest');
    assertStringIncludes(t.out(), 'moderation:     flagged (self-harm, violence)');
    assertStringIncludes(t.err(), 'would answer 422 not_food (by the moderation) and make no image');
    assertEquals(fake.urls, ['https://api.openai.com/v1/moderations']);
    assertEquals(t.files, []);
  });
});

Deno.test('run --description: a clean prompt goes on to the image', async () => {
  await withCleanEnv(async () => {
    const t = io();
    assertEquals(await run(['--description', 'Golden rice in a clay bowl.', '--image-model', 'mock', '--quiet'], t.cliIo), 0, t.err());
    assertStringIncludes(t.out(), 'moderation:     not flagged');
    assertStringIncludes(t.out(), 'Wrote generated-images/golden-rice-in-a-clay-bowl-2026-10-18T12-34-56.jpg');
    assertEquals(t.files, [{ path: 'generated-images/golden-rice-in-a-clay-bowl-2026-10-18T12-34-56.jpg', bytes: MOCK_RECIPE_PHOTO_JPEG }]);
  });
});

Deno.test('run --description: a moderation failure exits 1 and makes no image', async () => {
  await withCleanEnv(async () => {
    const t = io({ OPENAI_API_KEY: 'sk-test' });
    assertEquals(await run(['--description', 'Soup.', '--quiet'], t.cliIo), 1);
    assertStringIncludes(t.err(), 'Failed: generation_failed (moderation): Request failed: no network in tests');
    assertEquals(t.files, []);
  });
});
