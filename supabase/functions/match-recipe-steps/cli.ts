// `yarn ai:steps https://example.com/some-recipe`, `yarn ai:steps --file page.html` or
// `yarn ai:steps --step "Toss the chicken with the lime" --ingredient "2 lb chicken thighs" …`: runs
// the function's own matchSteps() on one recipe by hand, with the same request schema, prompt,
// validation and id mapping, against an in-memory store (no plans, no limits), and prints each
// step with the ingredients it uses. A link or file goes through the import's own fetch and
// extraction first (import-recipe's importRecipe, with categorize on the mock), with nothing cached
// or written. Ingredients get the ids "1", "2", … in order. Every LLM call is printed in full
// (instructions, prompt, response, tokens, latency) unless --quiet.
import {
  MatchRecipeStepsRequestSchema,
  type MatchRecipeStepsRequest,
  type MatchRecipeStepsRequestInput,
  type MatchRecipeStepsResponse,
  type RecipeImportRequest,
  stepTexts,
} from '@shared/index.ts';

import { buildMatchRecipeStepsPrompt, MATCH_RECIPE_STEPS_PROMPT_VERSION } from '../_shared/ai/prompts/match-recipe-steps.v1.ts';
import type { AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import type { StepMatch } from '../_shared/ai/tasks.ts';
import { traceAiCalls } from '../_shared/ai/trace.ts';
import type { Feature } from '../_shared/entitlements.ts';
import { fetchPage as realFetchPage, readPage, type FetchedPage } from '../_shared/fetch-page.ts';
import { formatStats, MemoryStore } from '../categorize-ingredients/cli.ts';
import { categorize } from '../categorize-ingredients/handler.ts';
import { MemoryRecipeStore, placeholderUrl } from '../import-recipe/cli.ts';
import { ImportRecipeError, importRecipe } from '../import-recipe/handler.ts';
import { ingredientFromLine } from '../suggest-recipe-tags/cli.ts';
import { formatAmount, formatMatch } from './format.ts';
import { matchSteps, MatchStepsError, type StepMatchStore } from './handler.ts';

export const USAGE = `Usage: yarn ai:steps [options] <url>
       yarn ai:steps [options] --file <page.html>
       yarn ai:steps [options] --step <text> ... --ingredient <line> ...

Matches a recipe's ingredients to its steps, as cook mode will show them.

Options:
  --file <path>                      Read the recipe page from a saved HTML file
  --step <text>                      A step, for a recipe typed in. Repeat for each one, in order.
  --ingredient <line>                An ingredient, as you'd type it: "2 lb chicken thighs, skinless".
                                     Repeat for each one.
  --model <provider:model|mock|off>  Match with this model instead of AI_MODEL_STEPS (else AI_MODEL_RECIPE)
  --recipe-model <provider:model|mock>
                                     Extract a link or file with this model instead of AI_MODEL_RECIPE
  --raw                              Also print the raw HTTP request and response bodies
  --quiet                            Only the match and totals, not each call's prompt and response
  --dry-run                          Print the matching instructions and prompt, and make no match call
  --json                             Print the request and the function's response as JSON
  -h, --help                         Show this help

Each LLM call is printed as it finishes: instructions, prompt, response, finish reason, input,
cached, output and reasoning tokens, and latency.`;

export type CliArgs = {
  url: string | null;
  file: string | null;
  steps: string[];
  ingredients: string[];
  model: string | null;
  recipeModel: string | null;
  raw: boolean;
  quiet: boolean;
  dryRun: boolean;
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
    steps: [],
    ingredients: [],
    model: null,
    recipeModel: null,
    raw: false,
    quiet: false,
    dryRun: false,
    json: false,
    help: false,
  };
  const valued: [string, string, (value: string) => void][] = [
    ['--file', 'page.html', (v) => (args.file = v)],
    ['--step', '"Toss the chicken with the lime juice"', (v) => args.steps.push(v)],
    ['--ingredient', '"2 lb chicken thighs"', (v) => args.ingredients.push(v)],
    ['--model', 'mock or --model google:gemini-3.8-flash', (v) => (args.model = v)],
    ['--recipe-model', 'mock', (v) => (args.recipeModel = v)],
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
    } else if (arg === '--raw') {
      args.raw = true;
    } else if (arg === '--quiet') {
      args.quiet = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--json') {
      args.json = true;
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
  const typed = args.steps.length > 0 || args.ingredients.length > 0;
  const sources = [args.url !== null && args.file === null, args.file !== null, typed].filter(Boolean).length;
  if (sources === 0) throw new CliUsageError('No recipe given: pass a URL, --file, or --step and --ingredient.');
  if (sources > 1) throw new CliUsageError('Give one recipe: a URL, --file, or --step and --ingredient, not several.');
  if (typed && (args.steps.length === 0 || args.ingredients.length === 0)) {
    throw new CliUsageError('A typed recipe needs at least one --step and one --ingredient.');
  }
  return args;
}

export { formatAmount, formatMatch };

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

/** The response's ids mapped back to indexes into the request's ingredients, for `formatMatch`. */
export function matchIndexes(request: MatchRecipeStepsRequest, steps: MatchRecipeStepsResponse['steps']): StepMatch {
  const index = new Map(request.ingredients.map((item, i) => [item.id, i]));
  return steps.map((uses) => uses.map((use) => ({ ingredient: index.get(use.id)!, quantity: use.quantity })));
}

/** `ai_calls` in memory; there are no limits or plans. */
export class MemoryStepMatchStore implements StepMatchStore {
  aiCalls: AiCallRecord[] = [];

  /** No database, so no plans: every feature is granted. */
  async requireFeature(_feature: Feature) {}

  /** Local and manual: no rate limits, no global cap. */
  async checkLimit() {
    return 'ok' as const;
  }

  async logAiCall(call: AiCallRecord) {
    this.aiCalls.push(call);
  }
}

type Loaded = { name: string | null; source: string | null; input: MatchRecipeStepsRequestInput; extractCalls: AiCallRecord[] };

/** The request for these steps and ingredients, with the ids "1", "2", … */
const requestInput = (steps: string[], ingredients: Omit<MatchRecipeStepsRequestInput['ingredients'][number], 'id'>[]): MatchRecipeStepsRequestInput => ({
  steps,
  ingredients: ingredients.map((item, i) => ({ id: String(i + 1), ...item })),
});

/** A link or file through the import, or the typed steps and ingredients. Throws CliUsageError or ImportRecipeError. */
async function loadRecipe(args: CliArgs, io: CliIo, recipeModel: string | null): Promise<Loaded> {
  if (args.url === null && args.file === null) {
    const input = requestInput(args.steps, args.ingredients.map(ingredientFromLine));
    const parsed = MatchRecipeStepsRequestSchema.safeParse(input);
    if (!parsed.success) throw new CliUsageError(parsed.error.issues[0].message);
    return { name: null, source: null, input, extractCalls: [] };
  }
  if (!recipeModel) throw new CliUsageError('AI_MODEL_RECIPE is not set. Add it to supabase/functions/.env or pass --recipe-model.');
  const request: RecipeImportRequest = { url: args.url ?? placeholderUrl(args.file!) };
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
    // Only the step strings are matched, as the app sends them (`ensureStepMatch`).
    const input = requestInput(
      stepTexts(response.steps),
      response.ingredients.map((i) => ({ name: i.displayName, quantity: i.quantity, unit: i.unit, note: i.note })),
    );
    return { name: response.name, source: args.file ?? response.sourceUrl, input, extractCalls: store.aiCalls };
  } finally {
    restore();
  }
}

/**
 * Runs the CLI. Returns the exit code: 0 matched, 1 the import or the match failed (or the recipe
 * has no steps or ingredients), 2 bad usage or an unexpected error. `AI_MODEL_STEPS` is set to
 * `--model` (or the configured model) for the run and restored after.
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
  const model = args.model ?? (env('AI_MODEL_STEPS')?.trim() || env('AI_MODEL_RECIPE')?.trim());
  if (!model) {
    io.err('Neither AI_MODEL_STEPS nor AI_MODEL_RECIPE is set. Add one to supabase/functions/.env or pass --model (e.g. --model mock).');
    return 2;
  }
  const recipeModel = args.recipeModel ?? (env('AI_MODEL_RECIPE')?.trim() || null);

  // With --json, stdout is only the JSON; everything else goes to stderr.
  const info = args.json ? io.err : io.out;
  const stopTrace = args.quiet || args.dryRun ? () => {} : traceAiCalls(info, { raw: args.raw });
  try {
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
    const parsed = MatchRecipeStepsRequestSchema.safeParse(loaded.input);
    if (!parsed.success) {
      const { steps, ingredients } = loaded.input;
      io.err(`Nothing to match: the recipe has ${steps.length} steps and ${ingredients.length} ingredients (${parsed.error.issues[0].message}).`);
      return 1;
    }
    const request = parsed.data;
    if (loaded.name !== null) info(`${loaded.name}\n${loaded.source}\n`);

    if (args.dryRun) {
      const { instructions, prompt } = buildMatchRecipeStepsPrompt({ steps: request.steps.filter((s) => s !== ''), ingredients: request.ingredients });
      io.out(`--- instructions (${MATCH_RECIPE_STEPS_PROMPT_VERSION}) ---\n${instructions}\n--- prompt ---\n${prompt}\n---`);
      io.out(`Dry run: no match call made (would use ${model}).`);
      return 0;
    }

    const store = new MemoryStepMatchStore();
    const restore = setEnv({ AI_MODEL_STEPS: model });
    let response: MatchRecipeStepsResponse;
    try {
      response = await matchSteps(request, { store });
    } catch (err) {
      if (err instanceof MatchStepsError) {
        const reason = err.failure.code === 'unavailable' ? `unavailable (${err.failure.reason})` : err.failure.code;
        io.err(`Match failed: ${reason}: ${err.message}`);
        info(formatStats(store.aiCalls));
        return 1;
      }
      throw err;
    } finally {
      restore();
    }

    if (args.json) {
      io.out(JSON.stringify({ name: loaded.name, source: loaded.source, request, response }, null, 2));
    } else {
      io.out(`${formatMatch(request, matchIndexes(request, response.steps))}\n`);
    }
    if (loaded.extractCalls.length > 0) info(`extract-recipe\n${formatStats(loaded.extractCalls)}\n`);
    info(`match-recipe-steps\n${formatStats(store.aiCalls)}`);
    return 0;
  } catch (err) {
    io.err(`Failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    return 2;
  } finally {
    stopTrace();
  }
}

if (import.meta.main) {
  // runAiTask logs a JSON line per call to stdout; keep stdout for the match or --json output.
  const print = console.log;
  console.log = console.error;
  const code = await run(Deno.args, { out: (text) => print(text), err: (text) => console.error(text) });
  Deno.exit(code);
}
