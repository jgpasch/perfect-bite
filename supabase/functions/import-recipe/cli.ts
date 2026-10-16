// `yarn ai:recipe https://example.com/some-recipe` or `yarn ai:recipe --file page.html`: runs the
// function's own importRecipe() by hand, with the same fetch, prompt, validation and categorize,
// against in-memory stores. Nothing is written to any database, and the rate limits don't apply.
// With --file the page is read from disk and sent as the client's page, so nothing is fetched.
// Every LLM call is printed in full (instructions, prompt, response, tokens, latency) unless --quiet.
import {
  AI_TAG_FACETS,
  recipeTagLabel,
  SYSTEM_CATEGORIES,
  type AiRecipeTags,
  type ExtractedRecipe,
  type RecipeImportRequest,
  type RecipeImportResponse,
} from '@shared/index.ts';

import type { AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import type { Feature } from '../_shared/entitlements.ts';
import { traceAiCalls } from '../_shared/ai/trace.ts';
import { fetchPage as realFetchPage, readPage, type FetchedPage } from '../_shared/fetch-page.ts';
import { formatStats, MemoryStore } from '../categorize-ingredients/cli.ts';
import { categorize } from '../categorize-ingredients/handler.ts';
import { formatMatch } from '../match-recipe-steps/format.ts';
import { ImportRecipeError, importRecipe, type CachedImport, type RecipeImportStore } from './handler.ts';

export const USAGE = `Usage: yarn ai:recipe [options] <url>
       yarn ai:recipe [options] --file <page.html> [<url>]

Options:
  --file <path>                      Read the page from a saved HTML file instead of fetching the
                                     URL. The URL is then optional and only names the source.
  --model <provider:model|mock|off>  Use this model instead of AI_MODEL_RECIPE
  --categorize-model <provider:model|mock|off>
                                     Use this model instead of AI_MODEL_CATEGORIZE
  --raw                              Also print the raw HTTP request and response bodies
  --quiet                            Only the recipe and totals, not each call's prompt and response
  --json                             Print the raw response the app would get
  -h, --help                         Show this help

Each LLM call is printed as it finishes: instructions, prompt, response, finish reason, input,
cached, output and reasoning tokens, and latency.`;

export type CliArgs = {
  url: string | null;
  file: string | null;
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
  const args: CliArgs = {
    url: null,
    file: null,
    model: null,
    categorizeModel: null,
    raw: false,
    quiet: false,
    json: false,
    help: false,
  };
  let flagsDone = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flagsDone || !arg.startsWith('-')) {
      if (args.url !== null) throw new CliUsageError('Give one URL at a time.');
      args.url = arg.trim();
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
    } else if (arg === '--file' || arg.startsWith('--file=')) {
      args.file = flagValue(argv, i, '--file', 'page.html');
      if (arg === '--file') i++;
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

/** The source URL for a page read from a file when no URL is given. */
export function placeholderUrl(file: string): string {
  const base = file.split(/[\\/]/).pop() || 'page.html';
  return `https://file.invalid/${encodeURIComponent(base)}`;
}

/** `recipe_imports` and `ai_calls` in memory: the cache starts empty and there are no limits or plans. */
export class MemoryRecipeStore implements RecipeImportStore {
  cache = new Map<string, CachedImport>();
  aiCalls: AiCallRecord[] = [];

  async checkLimit() {
    return 'ok' as const;
  }

  async getCached(urlKey: string, promptVersion: string) {
    return this.cache.get(`${promptVersion} ${urlKey}`) ?? null;
  }

  async saveCached(urlKey: string, promptVersion: string, result: ExtractedRecipe) {
    this.cache.set(`${promptVersion} ${urlKey}`, { result, is_recipe: result.is_recipe, created_at: new Date().toISOString() });
  }

  async logAiCall(call: AiCallRecord) {
    this.aiCalls.push(call);
  }

  /** No database, so no plans: every feature is granted. */
  async requireFeature(_feature: Feature) {}
}

const SLUG_BY_ID = new Map<string, string>(SYSTEM_CATEGORIES.map((c) => [c.id, c.slug]));

function table(rows: string[][]): string {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => [...r[col]].length)));
  return rows.map((r) => r.map((cell, col) => cell + ' '.repeat(widths[col] - [...cell].length)).join('  ').trimEnd()).join('\n');
}

/** Pure: the tags as "Meal: Dinner · Cuisine: Indian", known slugs by label and others as stored; `-` for none. */
export function formatTags(tags: AiRecipeTags | null): string {
  const parts = AI_TAG_FACETS.flatMap((facet) =>
    (tags?.[facet.key] ?? []).map((slug) => `${facet.label}: ${recipeTagLabel(facet.key, slug) ?? slug}`),
  );
  return parts.length === 0 ? '-' : parts.join(' · ');
}

/**
 * Pure: the import's step match as `yarn ai:steps` prints one, under a heading; a line saying there
 * is none when the import sent no match. Empty for a recipe with no steps.
 */
export function formatStepMatch(response: RecipeImportResponse): string {
  if (response.steps.length === 0) return '';
  if (response.stepIngredients === null) return 'step match: none (the app matches the recipe after it saves)';
  const recipe = {
    steps: response.steps,
    ingredients: response.ingredients.map((i) => ({ name: i.displayName, quantity: i.quantity, unit: i.unit })),
  };
  const match = response.stepIngredients.map((uses) => uses.map((use) => ({ ingredient: use.index, quantity: use.quantity })));
  return `step match:\n\n${formatMatch(recipe, match)}`;
}

/** Pure: name, servings, time, tags, source, the ingredient table and the step match. */
export function formatRecipe(response: RecipeImportResponse): string {
  const rows = [['name', 'quantity', 'unit', 'note', 'category']];
  for (const i of response.ingredients) {
    const slug = i.categoryId ? (SLUG_BY_ID.get(i.categoryId) ?? i.categoryId) : null;
    rows.push([
      i.displayName,
      i.quantity === null ? '-' : String(Math.round(i.quantity * 1000) / 1000),
      i.unit ?? '-',
      i.note || '-',
      i.status === 'categorized' && slug ? slug : `(${i.status})`,
    ]);
  }
  const stepMatch = formatStepMatch(response);
  return [
    `name:     ${response.name}`,
    `servings: ${response.servings ?? '-'}`,
    `time:     ${response.totalMinutes === null ? '-' : `${response.totalMinutes} min`}`,
    `tags:     ${formatTags(response.tags)}`,
    `source:   ${response.sourceUrl}`,
    '',
    response.ingredients.length === 0 ? 'No ingredients.' : table(rows),
    ...(stepMatch ? ['', stepMatch] : []),
  ].join('\n');
}

/** Pure: the token and latency totals, one block per task (extraction, then categorize). */
export function formatCallStats(extractCalls: readonly AiCallRecord[], categorizeCalls: readonly AiCallRecord[]): string {
  if (extractCalls.length === 0 && categorizeCalls.length === 0) return 'No LLM call made.';
  return [`extract-recipe\n${formatStats(extractCalls)}`, `categorize\n${formatStats(categorizeCalls)}`].join('\n\n');
}

export type CliIo = {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Reads `--file`. Defaults to `Deno.readTextFile`. */
  readFile?: (path: string) => Promise<string>;
  /** Fetches a URL. Defaults to the real `fetchPage` (SSRF checks included). */
  fetchPage?: (url: string) => Promise<FetchedPage>;
  /** Reads an env var. Defaults to `Deno.env.get`. */
  env?: (key: string) => string | undefined;
};

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
 * Runs the CLI. Returns the exit code: 0 imported, 1 the import failed (not a recipe, fetch
 * failed, AI off or failing), 2 bad usage or an unexpected error. `AI_MODEL_RECIPE` and
 * `AI_MODEL_CATEGORIZE` are set to `--model` and `--categorize-model` for the run and restored after.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
    if (!args.help && args.url === null && args.file === null) throw new CliUsageError('No URL or --file given.');
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
  const model = args.model ?? env('AI_MODEL_RECIPE')?.trim();
  if (!model) {
    io.err('AI_MODEL_RECIPE is not set. Add it to supabase/functions/.env or pass --model (e.g. --model mock).');
    return 2;
  }

  const request: RecipeImportRequest = { url: args.url ?? placeholderUrl(args.file!) };
  if (args.file !== null) {
    let html: string;
    try {
      html = await (io.readFile ?? Deno.readTextFile)(args.file);
    } catch (err) {
      io.err(`Can't read ${args.file}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
    const page = readPage(html, request.url);
    request.page = {
      ...(page.title === null ? {} : { title: page.title }),
      jsonLd: page.jsonLd,
      text: page.text,
      ...(page.imageUrl === null ? {} : { imageUrl: page.imageUrl }),
    };
  }

  // With --json, stdout is only the response; everything else goes to stderr.
  const info = args.json ? io.err : io.out;
  const stopTrace = args.quiet ? () => {} : traceAiCalls(info, { raw: args.raw });
  const restoreEnv = setEnv({ AI_MODEL_RECIPE: model, AI_MODEL_CATEGORIZE: args.categorizeModel });
  const store = new MemoryRecipeStore();
  const categorizeStore = new MemoryStore();
  let response: RecipeImportResponse;
  try {
    response = await importRecipe(request, {
      store,
      categorize: (names) => categorize(names, categorizeStore),
      fetchPage: io.fetchPage ?? ((url) => realFetchPage(url)),
    });
  } catch (err) {
    if (err instanceof ImportRecipeError) {
      io.err(`Import failed: ${err.failure.code}: ${err.message}`);
      info(formatCallStats(store.aiCalls, categorizeStore.aiCalls));
      return 1;
    }
    io.err(`Import failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    return 2;
  } finally {
    stopTrace();
    restoreEnv();
  }

  io.out(args.json ? JSON.stringify(response, null, 2) : `${formatRecipe(response)}\n`);
  info(formatCallStats(store.aiCalls, categorizeStore.aiCalls));
  return 0;
}

if (import.meta.main) {
  // runAiTask logs a JSON line per call to stdout; keep stdout for the recipe or --json response.
  const print = console.log;
  console.log = console.error;
  const code = await run(Deno.args, { out: (text) => print(text), err: (text) => console.error(text) });
  Deno.exit(code);
}
