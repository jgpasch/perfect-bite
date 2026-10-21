// `yarn ai:image https://example.com/some-recipe`, `yarn ai:image --file page.html` or
// `yarn ai:image --title "Fish tacos" --ingredients "cod, corn tortillas, red cabbage"`: runs the
// function's own generateRecipePhoto() on one recipe by hand, with the same prompts, checks,
// moderation and image call, against an in-memory store (no plans, no reservation, no database or Storage). It
// prints the description and writes the image to generated-images/ (git-ignored). A link or file
// goes through the import's own fetch and extraction first (import-recipe's importRecipe, with
// categorize on the mock), with nothing cached or written. Every LLM call is printed in full unless
// --quiet. It costs real money unless both models are mock: about a cent an image on mini at medium.
import type { GenerateRecipePhotoRequest, RecipeImportRequest } from '@shared/index.ts';

import { buildRecipePhotoDescriptionPrompt, RECIPE_PHOTO_DESCRIPTION_PROMPT_VERSION } from '../_shared/ai/prompts/recipe-photo-description.v1.ts';
import type { AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { buildRecipePhotoImagePrompt, RECIPE_PHOTO_IMAGE_PROMPT_VERSION } from '../_shared/ai/prompts/recipe-photo-image.v1.ts';
import { AI_OFF, cleanPhotoDescription } from '../_shared/ai/tasks.ts';
import { traceAiCalls } from '../_shared/ai/trace.ts';
import type { Feature } from '../_shared/entitlements.ts';
import { fetchPage as realFetchPage, readPage, type FetchedPage } from '../_shared/fetch-page.ts';
import { formatStats, MemoryStore } from '../categorize-ingredients/cli.ts';
import { categorize } from '../categorize-ingredients/handler.ts';
import { CLI_HOUSEHOLD_ID, MemoryRecipeStore, placeholderUrl } from '../import-recipe/cli.ts';
import { ImportRecipeError, importRecipe } from '../import-recipe/handler.ts';
import { describeRecipePhoto, DescribeFailedError, photoRecipe } from './describe.ts';
import { generateRecipePhoto, GeneratePhotoError, type RecipePhotoStore, type ReserveResult, type StoredRecipe } from './handler.ts';
import {
  estimateImageCost,
  generateImage,
  IMAGE_QUALITIES,
  IMAGE_SIZE,
  ImageFailedError,
  imageModel,
  imageQuality,
  ImageRefusedError,
  type GeneratedImage,
} from './image.ts';
import { moderateText, ModerationFailedError, moderationModelId, type ModerationResult } from './moderation.ts';

export const USAGE = `Usage: yarn ai:image [options] <recipe-url>
       yarn ai:image [options] --file <page.html>
       yarn ai:image [options] --title <name> --ingredients <names>
       yarn ai:image [options] --description <text>

Makes a recipe's AI photo as generate-recipe-photo would: describes the dish, moderates the image
prompt (printing the answer), then generates the image from the description. Prints the
description and writes the image to generated-images/. Nothing is written to the database or
Storage.

Options:
  --file <path>                      Read the recipe from a saved HTML page
  --description <text>               Skip the description call: build the image prompt from this
                                     text and moderate it (free). A flagged prompt stops there.
                                     Not with --title, --file or a link.
  --title <name>                     A recipe typed in: its title
  --ingredients <names>              Its ingredient names, comma-separated ("cod, corn tortillas").
                                     Repeat to add more.
  --cuisine <slug>                   A cuisine tag for a typed recipe (e.g. mexican). Repeat for more.
  --model <provider:model|mock>      Describe with this model instead of AI_MODEL_PHOTO_DESCRIPTION
                                     (else AI_MODEL_TAGS, else AI_MODEL_RECIPE)
  --recipe-model <provider:model|mock>
                                     Extract a link or file with this model instead of AI_MODEL_RECIPE
  --image-model <id|mock>            Instead of AI_IMAGE_MODEL (default gpt-image-1-mini)
  --quality <${IMAGE_QUALITIES.join('|')}>  Instead of AI_IMAGE_QUALITY (default medium)
  --out <dir>                        Where the image goes (default generated-images)
  --describe-only                    Print the description and make no image (no image cost)
  --raw                              Also print the raw HTTP request and response bodies
  --quiet                            Only the description, the file and the totals
  -h, --help                         Show this help

An image costs about a cent on gpt-image-1-mini at medium; the description a small fraction of that.
The moderation check is free.`;

export type CliArgs = {
  url: string | null;
  file: string | null;
  /** `--description`: the image prompt is built from this, with no description call. */
  description: string | null;
  title: string | null;
  ingredients: string[];
  cuisines: string[];
  model: string | null;
  recipeModel: string | null;
  imageModel: string | null;
  quality: string | null;
  out: string;
  describeOnly: boolean;
  raw: boolean;
  quiet: boolean;
  help: boolean;
};

export class CliUsageError extends Error {
  override name = 'CliUsageError';
}

function flagValue(argv: readonly string[], i: number, flag: string, example: string): string {
  const arg = argv[i];
  const value = arg === flag ? argv[i + 1] : arg.slice(flag.length + 1);
  if (!value?.trim() || (arg === flag && value.startsWith('-'))) {
    throw new CliUsageError(`${flag} needs a value, e.g. ${flag} ${example}`);
  }
  return value.trim();
}

/** Pure: argv (without the script) → options. Throws CliUsageError on a bad flag or argument. */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    url: null,
    file: null,
    description: null,
    title: null,
    ingredients: [],
    cuisines: [],
    model: null,
    recipeModel: null,
    imageModel: null,
    quality: null,
    out: 'generated-images',
    describeOnly: false,
    raw: false,
    quiet: false,
    help: false,
  };
  const valued: [string, string, (value: string) => void][] = [
    ['--file', 'page.html', (v) => (args.file = v)],
    ['--description', '"Golden rice in a clay bowl."', (v) => (args.description = v)],
    ['--title', '"Fish tacos"', (v) => (args.title = v)],
    ['--ingredients', '"cod, corn tortillas"', (v) => args.ingredients.push(...v.split(',').map((s) => s.trim()).filter(Boolean))],
    ['--cuisine', 'mexican', (v) => args.cuisines.push(v)],
    ['--model', 'mock or --model google:gemini-3.8-flash', (v) => (args.model = v)],
    ['--recipe-model', 'mock', (v) => (args.recipeModel = v)],
    ['--image-model', 'mock', (v) => (args.imageModel = v)],
    ['--quality', 'low', (v) => (args.quality = v)],
    ['--out', 'generated-images', (v) => (args.out = v)],
  ];
  let flagsDone = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const flag = valued.find(([name]) => arg === name || arg.startsWith(`${name}=`));
    if (flagsDone || !arg.startsWith('-')) {
      if (args.url !== null) throw new CliUsageError('Give one URL at a time.');
      args.url = arg.trim();
    } else if (arg === '--') {
      flagsDone = true;
    } else if (arg === '--describe-only') {
      args.describeOnly = true;
    } else if (arg === '--raw') {
      args.raw = true;
    } else if (arg === '--quiet') {
      args.quiet = true;
    } else if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else if (flag) {
      flag[2](flagValue(argv, i, flag[0], flag[1]));
      if (arg === flag[0]) i++;
    } else {
      throw new CliUsageError(`Unknown option: ${arg}`);
    }
  }
  if (args.help) return args;
  if (args.quality !== null && !(IMAGE_QUALITIES as readonly string[]).includes(args.quality)) {
    throw new CliUsageError(`--quality must be one of ${IMAGE_QUALITIES.join(', ')}`);
  }
  const typed = args.title !== null || args.ingredients.length > 0 || args.cuisines.length > 0;
  if (args.description !== null) {
    if (typed || args.file !== null || args.url !== null) {
      throw new CliUsageError('--description skips the recipe: give it without --title, --ingredients, --cuisine, --file or a link.');
    }
    if (args.describeOnly) throw new CliUsageError('--description makes no description call, so --describe-only has nothing to do.');
    return args;
  }
  const sources = [args.url !== null, args.file !== null, typed].filter(Boolean).length;
  if (sources === 0) throw new CliUsageError('No recipe given: pass a URL, --file, or --title and --ingredients.');
  if (sources > 1) throw new CliUsageError('Give one recipe: a URL, --file, or --title and --ingredients, not several.');
  if (typed && args.title === null) throw new CliUsageError('A typed recipe needs a --title.');
  return args;
}

/** A file name for the image: the title as a slug and the time, e.g. `fish-tacos-2026-10-18T12-00-00.jpg`. */
export function imageFileName(title: string, now: Date): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'recipe';
  return `${slug}-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jpg`;
}

const usd = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(3)}`;

/** Pure: the image's model, size, tokens and rough cost. */
export function formatImageCost(image: Pick<GeneratedImage, 'model' | 'quality' | 'usage' | 'ms'>): string {
  if (image.model === 'mock') return `image:          mock (the fixed test JPEG), no cost`;
  const tokens = image.usage ? `, ${image.usage.inputTokens ?? '?'} in / ${image.usage.outputTokens ?? '?'} out tokens` : '';
  const cost = estimateImageCost(image);
  const costText = cost === null ? 'cost unknown for this model (about a cent on gpt-image-1-mini at medium)' : `about ${usd(cost)}`;
  return `image:          ${image.model}, ${image.quality}, ${IMAGE_SIZE}${tokens}, ${image.ms} ms, ${costText}`;
}

/** Pure: a moderation answer, e.g. `moderation:     flagged (self-harm, violence)`. */
export function formatModeration(moderation: ModerationResult): string {
  if (!moderation.flagged) return 'moderation:     not flagged';
  return `moderation:     flagged (${moderation.categories.join(', ') || 'no category'})`;
}

const ZERO_ID = '00000000-0000-0000-0000-000000000000';

/** Writes the image to `--out` (or `io.writeFile`) and answers its path. */
async function writeImage(args: CliArgs, io: CliIo, title: string, now: Date, bytes: Uint8Array): Promise<string> {
  const path = `${args.out}/${imageFileName(title, now)}`;
  if (io.writeFile) await io.writeFile(path, bytes);
  else {
    await Deno.mkdir(args.out, { recursive: true });
    await Deno.writeFile(path, bytes);
  }
  return path;
}

/**
 * `--description`: no recipe and no description call. Builds the image prompt from the text (cut
 * as the function cuts a description), moderates it and prints the answer; a flagged prompt stops
 * there, before the image (exit 1). Otherwise makes the image as the function would.
 */
async function runWithDescription(text: string, args: CliArgs, io: CliIo, imageEnv: (key: string) => string | undefined): Promise<number> {
  const cleaned = cleanPhotoDescription({ isFood: true, description: text });
  if (cleaned === null || !cleaned.isFood) {
    io.err(`--description is empty.\n\n${USAGE}`);
    return 2;
  }
  const prompt = buildRecipePhotoImagePrompt(cleaned.description);
  io.out(`--- image prompt (${RECIPE_PHOTO_IMAGE_PROMPT_VERSION}), moderated with ${moderationModelId(imageEnv)} ---\n${prompt}\n`);
  let moderation: ModerationResult;
  try {
    moderation = await moderateText(prompt, { env: imageEnv, fetch: io.fetch });
  } catch (err) {
    if (!(err instanceof ModerationFailedError)) throw err;
    io.err(`Failed: generation_failed (moderation): ${err.message}`);
    return 1;
  }
  io.out(formatModeration(moderation));
  if (moderation.flagged) {
    io.err('Flagged: the function would answer 422 not_food (by the moderation) and make no image.');
    return 1;
  }
  io.out(`--- image prompt, to ${imageModel(imageEnv)} at ${imageQuality(imageEnv)} ---\n${prompt}\n`);
  let image: GeneratedImage;
  try {
    image = await generateImage(prompt, { env: imageEnv, fetch: io.fetch });
  } catch (err) {
    if (err instanceof ImageRefusedError) {
      io.err(`Failed: not_food (by the image): ${err.message}`);
      return 1;
    }
    if (err instanceof ImageFailedError) {
      io.err(`Failed: generation_failed (image): ${err.message}`);
      return 1;
    }
    throw err;
  }
  io.out(`Wrote ${await writeImage(args, io, cleaned.description, io.now?.() ?? new Date(), image.bytes)}\n`);
  io.out(formatImageCost(image));
  return 0;
}

/** The function's store in memory: every feature granted, always reserved, and the upload written to a local file. */
export class MemoryPhotoStore implements RecipePhotoStore {
  aiCalls: AiCallRecord[] = [];
  description: string | null = null;
  released = false;
  written: string | null = null;

  constructor(
    private readonly recipe: StoredRecipe,
    private readonly write: (bytes: Uint8Array) => Promise<string>,
  ) {}

  async recipeHousehold() {
    return ZERO_ID;
  }
  async requireFeature(_feature: Feature) {}
  async reserve(): Promise<ReserveResult> {
    return { status: 'ok', householdId: ZERO_ID };
  }
  async readRecipe() {
    return this.recipe;
  }
  async upload(_path: string, bytes: Uint8Array) {
    this.written = await this.write(bytes);
  }
  async complete(_recipeId: string, description: string) {
    this.description = description;
    return true;
  }
  async release() {
    this.released = true;
  }
  async logAiCall(call: AiCallRecord) {
    this.aiCalls.push(call);
  }
}

export type CliIo = {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Reads `--file`. Defaults to `Deno.readTextFile`. */
  readFile?: (path: string) => Promise<string>;
  /** Writes the image. Defaults to `Deno.mkdir` and `Deno.writeFile`. */
  writeFile?: (path: string, bytes: Uint8Array) => Promise<void>;
  /** Fetches a recipe page. Defaults to the real `fetchPage` (SSRF checks included). */
  fetchPage?: (url: string) => Promise<FetchedPage>;
  /** The image call. Defaults to OpenAI's Images API. */
  fetch?: typeof fetch;
  /** Reads an env var. Defaults to `Deno.env.get`. */
  env?: (key: string) => string | undefined;
  now?: () => Date;
};

/** Sets env vars for the run (null leaves one alone); the returned function restores them. */
function setEnv(values: Record<string, string | null>): () => void {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(values)) if (v !== null) Deno.env.set(k, v);
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  };
}

type Loaded = { recipe: StoredRecipe; source: string | null; extractCalls: AiCallRecord[] };

/** A link or file through the import, or the typed recipe. Throws CliUsageError or ImportRecipeError. */
async function loadRecipe(args: CliArgs, io: CliIo, recipeModel: string | null): Promise<Loaded> {
  if (args.url === null && args.file === null) {
    return { recipe: { name: args.title!, ingredients: args.ingredients, tags: { cuisine: args.cuisines } }, source: null, extractCalls: [] };
  }
  if (!recipeModel) throw new CliUsageError('AI_MODEL_RECIPE is not set. Add it to supabase/functions/.env or pass --recipe-model.');
  const request: RecipeImportRequest = { url: args.url ?? placeholderUrl(args.file!), householdId: CLI_HOUSEHOLD_ID };
  if (args.file !== null) {
    let html: string;
    try {
      html = await (io.readFile ?? Deno.readTextFile)(args.file);
    } catch (err) {
      throw new CliUsageError(`Can't read ${args.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const page = readPage(html, request.url);
    request.page = { ...(page.title === null ? {} : { title: page.title }), jsonLd: page.jsonLd, text: page.text };
  }
  const store = new MemoryRecipeStore();
  const categorizeStore = new MemoryStore();
  // Categories don't matter here, so categorize runs on the mock and costs nothing.
  const restore = setEnv({ AI_MODEL_RECIPE: recipeModel, AI_MODEL_CATEGORIZE: 'mock' });
  try {
    const response = await importRecipe(request, {
      store,
      categorize: (names) => categorize(names, categorizeStore),
      fetchPage: io.fetchPage ?? realFetchPage,
    });
    return {
      recipe: { name: response.name, ingredients: response.ingredients.map((i) => i.displayName), tags: response.tags ?? null },
      source: args.file ?? response.sourceUrl,
      extractCalls: store.aiCalls,
    };
  } finally {
    restore();
  }
}

/**
 * Runs the CLI. Returns the exit code: 0 the photo was made (or described), 1 the import, the
 * description or the image failed or was refused, 2 bad usage or an unexpected error.
 * `AI_MODEL_PHOTO_DESCRIPTION` is set to `--model` (or the configured model) for the run and restored after.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof CliUsageError)) throw err;
    io.err(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    io.out(USAGE);
    return 0;
  }

  const env = io.env ?? ((key: string) => Deno.env.get(key));
  const model = args.model ?? (env('AI_MODEL_PHOTO_DESCRIPTION')?.trim() || env('AI_MODEL_TAGS')?.trim() || env('AI_MODEL_RECIPE')?.trim());
  // --description makes no description call, so it needs no description model.
  if (args.description === null && (!model || model === AI_OFF)) {
    io.err('No description model: set AI_MODEL_PHOTO_DESCRIPTION (or AI_MODEL_TAGS or AI_MODEL_RECIPE) in supabase/functions/.env, or pass --model (e.g. --model mock).');
    return 2;
  }
  const imageEnv = (key: string) => (key === 'AI_IMAGE_MODEL' && args.imageModel) || (key === 'AI_IMAGE_QUALITY' && args.quality) || env(key);
  if (!args.describeOnly) {
    const image = imageModel(imageEnv);
    if (image === AI_OFF) {
      io.err('AI_IMAGE_MODEL is off. Pass --image-model (e.g. --image-model mock) or --describe-only.');
      return 2;
    }
    if (image !== 'mock' && !imageEnv('OPENAI_API_KEY')?.trim()) {
      io.err('OPENAI_API_KEY is not set in supabase/functions/.env. Pass --image-model mock or --describe-only to make no image.');
      return 2;
    }
  }
  const recipeModel = args.recipeModel ?? (env('AI_MODEL_RECIPE')?.trim() || null);

  const stopTrace = args.quiet ? () => {} : traceAiCalls(io.out, { raw: args.raw });
  try {
    // Without --description a model was checked above; `!model` only narrows it for what follows.
    if (args.description !== null || !model) return await runWithDescription(args.description ?? '', args, io, imageEnv);
    let loaded: Loaded;
    try {
      loaded = await loadRecipe(args, io, recipeModel);
    } catch (err) {
      if (err instanceof CliUsageError) {
        io.err(`${err.message}\n\n${USAGE}`);
        return 2;
      }
      if (err instanceof ImportRecipeError) {
        io.err(`Import failed: ${err.failure.code}: ${err.message}`);
        return 1;
      }
      throw err;
    }
    const recipe = photoRecipe(loaded.recipe);
    io.out(`${recipe.title}${loaded.source ? `\n${loaded.source}` : ''}\ningredients: ${recipe.ingredients.join(', ') || '(none)'}\ncuisines: ${recipe.cuisines.join(', ') || '(none)'}\n`);
    if (args.quiet) io.out(`description call (${RECIPE_PHOTO_DESCRIPTION_PROMPT_VERSION}) with ${model}\n`);
    else io.out(`--- description prompt (${RECIPE_PHOTO_DESCRIPTION_PROMPT_VERSION}), to ${model} ---\n${buildRecipePhotoDescriptionPrompt(recipe).prompt}\n`);

    const restore = setEnv({ AI_MODEL_PHOTO_DESCRIPTION: model });
    try {
      if (args.describeOnly) {
        const calls: AiCallRecord[] = [];
        try {
          const described = await describeRecipePhoto(recipe, { onCall: async (call) => void calls.push(call) });
          io.out(described.isFood ? `description: ${described.description}` : 'Refused: isFood is false (the function would answer 422 not_food).');
          io.out(`\nrecipe-photo-description\n${formatStats(calls)}`);
          return described.isFood ? 0 : 1;
        } catch (err) {
          if (!(err instanceof DescribeFailedError)) throw err;
          io.err(err.message);
          io.out(formatStats(calls));
          return 1;
        }
      }

      const now = io.now?.() ?? new Date();
      const store = new MemoryPhotoStore(loaded.recipe, (bytes) => writeImage(args, io, recipe.title, now, bytes));
      // Set inside the image call; `as` so TS doesn't narrow it to null here.
      let image = null as GeneratedImage | null;
      const request: GenerateRecipePhotoRequest = { recipeId: ZERO_ID };
      try {
        await generateRecipePhoto(request, {
          store,
          env: imageEnv,
          moderate: async (text) => {
            const moderation = await moderateText(text, { env: imageEnv, fetch: io.fetch });
            io.out(formatModeration(moderation));
            return moderation;
          },
          generateImage: async (prompt) => {
            io.out(`--- image prompt, to ${imageModel(imageEnv)} at ${imageQuality(imageEnv)} ---\n${prompt}\n`);
            image = await generateImage(prompt, { env: imageEnv, fetch: io.fetch });
            return image;
          },
        });
      } catch (err) {
        if (!(err instanceof GeneratePhotoError)) throw err;
        io.err(`Failed: ${err.failure.code}${'step' in err.failure ? ` (${err.failure.step})` : 'by' in err.failure ? ` (by the ${err.failure.by})` : ''}: ${err.message}`);
        io.out(`\nrecipe-photo-description\n${formatStats(store.aiCalls)}`);
        return 1;
      }
      io.out(`description: ${store.description}\n`);
      io.out(`Wrote ${store.written}\n`);
      if (loaded.extractCalls.length > 0) io.out(`extract-recipe\n${formatStats(loaded.extractCalls)}\n`);
      io.out(`recipe-photo-description\n${formatStats(store.aiCalls)}\n`);
      io.out(formatImageCost(image!));
      return 0;
    } finally {
      restore();
    }
  } catch (err) {
    io.err(`Failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    return 2;
  } finally {
    stopTrace();
  }
}

if (import.meta.main) {
  // runAiTask logs a JSON line per call to stdout; keep stdout for the CLI's own output.
  const print = console.log;
  console.log = console.error;
  const code = await run(Deno.args, { out: (text) => print(text), err: (text) => console.error(text) });
  Deno.exit(code);
}
