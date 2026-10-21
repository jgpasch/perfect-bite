// `yarn ai:recipe-photo page1.jpg [page2.heic …]`: runs the function's own importRecipePhoto() by
// hand, with the same prompt, validation and categorize, against in-memory stores. Nothing is
// written to any database, and the rate limits don't apply. HEIC is converted to JPEG, and a file
// over the 2 MB cap is shrunk, with macOS's `sips`, into the temp folder. Every LLM call is printed
// in full (instructions, prompt with each image described, response, tokens, latency) unless --quiet.
import {
  base64DecodedBytes,
  MAX_PHOTO_IMPORT_IMAGE_BYTES,
  MAX_PHOTO_IMPORT_IMAGES,
  RecipePhotoImportRequestSchema,
  type RecipeImportResponse,
  type RecipePhotoImportRequest,
  type RecipePhotoMediaType,
} from '@shared/index.ts';

import type { PromptImage } from '../_shared/ai/prompts/extract-recipe-photo.v3.ts';
import type { AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { traceAiCalls } from '../_shared/ai/trace.ts';
import { MemoryStore } from '../categorize-ingredients/cli.ts';
import { categorize } from '../categorize-ingredients/handler.ts';
import { formatCallStats, formatRecipe } from '../import-recipe/cli.ts';
import { ImportRecipePhotoError, importRecipePhoto, type RecipePhotoImportStore } from './handler.ts';

export const USAGE = `Usage: yarn ai:recipe-photo [options] <image> [<image> <image>]

The images are the pages of one recipe, in order (1 to ${MAX_PHOTO_IMPORT_IMAGES}): .jpg, .jpeg, .png, .webp, or .heic/.heif
(converted to JPEG with sips). A file over 2 MB is resized to 2000 px with sips first.

Options:
  --model <provider:model|mock|off>  Use this model instead of AI_MODEL_RECIPE_PHOTO (else AI_MODEL_RECIPE)
  --categorize-model <provider:model|mock|off>
                                     Use this model instead of AI_MODEL_CATEGORIZE
  --raw                              Also print the raw HTTP request and response bodies, with image
                                     data shown as <N bytes base64>
  --quiet                            Only the recipe and totals, not each call's prompt and response
  --json                             Print the raw response the app would get
  -h, --help                         Show this help

Each LLM call is printed as it finishes: instructions, prompt (each image as its type, size and
SHA-256), response, finish reason, input, cached, output and reasoning tokens, and latency.`;

export type CliArgs = {
  paths: string[];
  model: string | null;
  categorizeModel: string | null;
  raw: boolean;
  quiet: boolean;
  json: boolean;
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
  const args: CliArgs = { paths: [], model: null, categorizeModel: null, raw: false, quiet: false, json: false, help: false };
  let flagsDone = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flagsDone || !arg.startsWith('-')) {
      if (args.paths.length === MAX_PHOTO_IMPORT_IMAGES) throw new CliUsageError(`Give at most ${MAX_PHOTO_IMPORT_IMAGES} images.`);
      args.paths.push(arg);
    } else if (arg === '--') {
      flagsDone = true;
    } else if (arg === '--raw') {
      args.raw = true;
    } else if (arg === '--quiet') {
      args.quiet = true;
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else if (arg === '--model' || arg.startsWith('--model=')) {
      args.model = flagValue(argv, i, '--model', 'mock or --model google:gemini-3.8-flash');
      if (arg === '--model') i++;
    } else if (arg === '--categorize-model' || arg.startsWith('--categorize-model=')) {
      args.categorizeModel = flagValue(argv, i, '--categorize-model', 'mock');
      if (arg === '--categorize-model') i++;
    } else {
      throw new CliUsageError(`Unknown option: ${arg}`);
    }
  }
  return args;
}

/** Pure: a file's media type from its extension (any case); `heic` needs converting first; null for anything else. */
export function mediaTypeFor(path: string): RecipePhotoMediaType | 'heic' | null {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'heic':
    case 'heif':
      return 'heic';
    default:
      return null;
  }
}

/** Below this, a base64-looking string is left as it is: it's not image data worth hiding. */
const REDACT_MIN_LENGTH = 256;

/**
 * Pure: `value` with every long base64 string (image data) replaced by `<N bytes base64>`, inside
 * objects, arrays and JSON text alike, for `--raw`.
 */
export function redactBase64(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length >= REDACT_MIN_LENGTH) {
      const bytes = base64DecodedBytes(value);
      if (bytes !== null) return `<${bytes} bytes base64>`;
    }
    const trimmed = value.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(redactBase64(JSON.parse(value)));
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(redactBase64);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactBase64(v)]));
  return value;
}

/** Pure: bytes as standard base64. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** The photo-import tables in memory: no limits, no plans, `ai_calls` kept for the totals. */
export class MemoryPhotoStore implements RecipePhotoImportStore {
  aiCalls: AiCallRecord[] = [];

  /** No database, so no plans: every feature is granted. */
  async requireFeature() {}

  async checkLimit() {
    return 'ok' as const;
  }

  async logAiCall(call: AiCallRecord) {
    this.aiCalls.push(call);
  }
}

/** What running `sips` did; `missing` when there's no `sips` (not macOS). */
export type SipsResult = { ok: true } | { ok: false; missing: boolean; error: string };

export type CliIo = {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Reads an image. Defaults to `Deno.readFile`. */
  readFile?: (path: string) => Promise<Uint8Array>;
  /** Runs `sips` with these arguments. Defaults to `Deno.Command('sips')`. */
  sips?: (args: string[]) => Promise<SipsResult>;
  /** A new path in the temp folder ending in `ext`, for sips to write. Nothing is deleted. */
  tempPath?: (ext: string) => string;
  /** Reads an env var. Defaults to `Deno.env.get`. */
  env?: (key: string) => string | undefined;
};

async function runSips(args: string[]): Promise<SipsResult> {
  try {
    const { success, stderr } = await new Deno.Command('sips', { args, stdout: 'null', stderr: 'piped' }).output();
    return success ? { ok: true } : { ok: false, missing: false, error: new TextDecoder().decode(stderr).trim() };
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return { ok: false, missing: true, error: 'sips not found' };
    throw err;
  }
}

function defaultTempPath(ext: string): string {
  const dir = (Deno.env.get('TMPDIR') ?? '/tmp').replace(/\/+$/, '');
  return `${dir}/ai-recipe-photo-${crypto.randomUUID()}${ext}`;
}

class ImageError extends Error {
  override name = 'ImageError';
}

const NO_SIPS = "sips isn't available (it comes with macOS)";

/**
 * One file as the request's image: HEIC converted to JPEG, and a file over the cap resized to
 * 2000 px, both with sips into the temp folder. `say` reports each conversion. Throws ImageError.
 */
async function loadImage(path: string, io: CliIo, say: (text: string) => void): Promise<PromptImage> {
  const type = mediaTypeFor(path);
  if (type === null) throw new ImageError(`${path}: not a .jpg, .jpeg, .png, .webp, .heic or .heif file`);
  const readFile = io.readFile ?? Deno.readFile;
  const sips = io.sips ?? runSips;
  const tempPath = io.tempPath ?? defaultTempPath;
  const read = async (file: string) => {
    try {
      return await readFile(file);
    } catch (err) {
      throw new ImageError(`Can't read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  let file = path;
  let mediaType: RecipePhotoMediaType;
  if (type === 'heic') {
    const jpeg = tempPath('.jpg');
    const converted = await sips(['-s', 'format', 'jpeg', path, '--out', jpeg]);
    if (!converted.ok) {
      throw new ImageError(
        converted.missing
          ? `${path}: HEIC needs converting to JPEG and ${NO_SIPS}. Export it as JPEG first (Preview: File › Export).`
          : `${path}: sips couldn't convert it to JPEG: ${converted.error}`,
      );
    }
    say(`${path}: converted HEIC to JPEG with sips (${jpeg})`);
    file = jpeg;
    mediaType = 'image/jpeg';
  } else {
    mediaType = type;
  }

  let bytes = await read(file);
  if (bytes.length > MAX_PHOTO_IMPORT_IMAGE_BYTES) {
    const ext = file.match(/\.[^./]+$/)?.[0] ?? '.jpg';
    const smaller = tempPath(ext);
    const resized = await sips(['-Z', '2000', file, '--out', smaller]);
    if (!resized.ok) {
      throw new ImageError(
        resized.missing
          ? `${path}: ${bytes.length} bytes is over the 2 MB cap and ${NO_SIPS} to shrink it. Resize it to 2000 px first.`
          : `${path}: sips couldn't resize it: ${resized.error}`,
      );
    }
    const before = bytes.length;
    bytes = await read(smaller);
    say(`${path}: ${before} bytes is over the 2 MB cap; resized to 2000 px with sips (${bytes.length} bytes, ${smaller})`);
    if (bytes.length > MAX_PHOTO_IMPORT_IMAGE_BYTES) {
      throw new ImageError(`${path}: still ${bytes.length} bytes at 2000 px, over the 2 MB cap. Save it as a JPEG first.`);
    }
  }
  return { mediaType, data: toBase64(bytes) };
}

/** Sets env vars for the run; the returned function restores them. */
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

/**
 * Runs the CLI. Returns the exit code: 0 imported, 1 the import failed (not a recipe, AI off or
 * failing), 2 bad usage, an unreadable or unusable image, or an unexpected error.
 * `AI_MODEL_RECIPE_PHOTO` and `AI_MODEL_CATEGORIZE` are set to `--model` and `--categorize-model`
 * for the run and restored after.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
    if (!args.help && args.paths.length === 0) throw new CliUsageError('No image given.');
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
  const model = args.model ?? (env('AI_MODEL_RECIPE_PHOTO')?.trim() || env('AI_MODEL_RECIPE')?.trim());
  if (!model) {
    io.err('Neither AI_MODEL_RECIPE_PHOTO nor AI_MODEL_RECIPE is set. Add one to supabase/functions/.env or pass --model (e.g. --model mock).');
    return 2;
  }

  // With --json, stdout is only the response; everything else goes to stderr.
  const info = args.json ? io.err : io.out;
  const images: PromptImage[] = [];
  try {
    for (const path of args.paths) images.push(await loadImage(path, io, info));
  } catch (err) {
    if (!(err instanceof ImageError)) throw err;
    io.err(err.message);
    return 2;
  }
  const parsed = RecipePhotoImportRequestSchema.safeParse({ images });
  if (!parsed.success) {
    io.err(`The request isn't valid: ${parsed.error.issues[0].path.join('.')}: ${parsed.error.issues[0].message}`);
    return 2;
  }
  const request: RecipePhotoImportRequest = parsed.data;

  const stopTrace = args.quiet ? () => {} : traceAiCalls(info, { raw: args.raw, redact: redactBase64 });
  const restoreEnv = setEnv({ AI_MODEL_RECIPE_PHOTO: model, AI_MODEL_CATEGORIZE: args.categorizeModel });
  const store = new MemoryPhotoStore();
  const categorizeStore = new MemoryStore();
  let response: RecipeImportResponse;
  try {
    response = await importRecipePhoto(request, { store, categorize: (names) => categorize(names, categorizeStore) });
  } catch (err) {
    if (err instanceof ImportRecipePhotoError) {
      io.err(`Import failed: ${err.failure.code}: ${err.message}`);
      info(formatCallStats(store.aiCalls, categorizeStore.aiCalls, 'extract-recipe-photo'));
      return 1;
    }
    io.err(`Import failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    return 2;
  } finally {
    stopTrace();
    restoreEnv();
  }

  io.out(args.json ? JSON.stringify(response, null, 2) : `${formatRecipe(response, args.paths.join(', '))}\n`);
  info(formatCallStats(store.aiCalls, categorizeStore.aiCalls, 'extract-recipe-photo'));
  return 0;
}

if (import.meta.main) {
  // runAiTask logs a JSON line per call to stdout; keep stdout for the recipe or --json response.
  const print = console.log;
  console.log = console.error;
  const code = await run(Deno.args, { out: (text) => print(text), err: (text) => console.error(text) });
  Deno.exit(code);
}
