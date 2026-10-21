// `yarn ai:tags "Chicken tikka" --ingredient "2 lb chicken thighs" --ingredient "1 cup yogurt"`:
// runs the function's own suggestRecipeTags() by hand, with the same request schema, prompt and
// validation, against an in-memory store. Nothing is written to any database, and the rate limits
// don't apply. Every LLM call is printed in full (instructions, prompt, response, tokens, latency)
// unless --quiet.
import {
  parseQuantity,
  SuggestRecipeTagsRequestSchema,
  type SuggestRecipeTagsRequest,
  type SuggestRecipeTagsRequestInput,
  type SuggestRecipeTagsResponse,
} from '@shared/index.ts';

import { buildSuggestRecipeTagsPrompt, SUGGEST_RECIPE_TAGS_PROMPT_VERSION } from '../_shared/ai/prompts/suggest-recipe-tags.v1.ts';
import type { AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { traceAiCalls } from '../_shared/ai/trace.ts';
import { formatStats } from '../categorize-ingredients/cli.ts';
import { formatTags } from '../import-recipe/cli.ts';
import { SuggestTagsError, suggestRecipeTags, type SuggestTagsStore } from './handler.ts';

export const USAGE = `Usage: yarn ai:tags [options] <recipe name>

Options:
  --ingredient <line>                An ingredient, as you'd type it: "2 lb chicken thighs, skinless".
                                     Repeat for each one.
  --notes <text>                     The recipe's notes
  --model <provider:model|mock|off>  Use this model instead of AI_MODEL_TAGS (else AI_MODEL_RECIPE)
  --raw                              Also print the raw HTTP request and response bodies
  --quiet                            Only the tags and totals, not each call's prompt and response
  --dry-run                          Print the instructions and prompt, and make no call
  --json                             Print the raw response the app would get
  -h, --help                         Show this help

Each LLM call is printed as it finishes: instructions, prompt, response, finish reason, input,
cached, output and reasoning tokens, and latency.`;

export type CliArgs = {
  name: string | null;
  ingredients: string[];
  notes: string | null;
  model: string | null;
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
    name: null,
    ingredients: [],
    notes: null,
    model: null,
    raw: false,
    quiet: false,
    dryRun: false,
    json: false,
    help: false,
  };
  let flagsDone = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (flagsDone || !arg.startsWith('-')) {
      if (args.name !== null) throw new CliUsageError('Give one recipe name (quote it if it has spaces).');
      args.name = arg.trim();
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
    } else if (arg === '--ingredient' || arg.startsWith('--ingredient=')) {
      args.ingredients.push(flagValue(argv, i, '--ingredient', '"2 chicken thighs"'));
      if (arg === '--ingredient') i++;
    } else if (arg === '--notes' || arg.startsWith('--notes=')) {
      args.notes = flagValue(argv, i, '--notes', '"Weeknight favourite"');
      if (arg === '--notes') i++;
    } else if (arg === '--model' || arg.startsWith('--model=')) {
      args.model = flagValue(argv, i, '--model', 'mock or --model google:gemini-3.8-flash');
      if (arg === '--model') i++;
    } else {
      throw new CliUsageError(`Unknown option: ${arg}`);
    }
  }
  return args;
}

/** Pure: an ingredient as typed → the request's shape. Anything after the first comma is the note. */
export function ingredientFromLine(line: string): SuggestRecipeTagsRequestInput['ingredients'][number] {
  const parsed = parseQuantity(line);
  const [name, ...rest] = parsed.name.split(',');
  return { name: name.trim(), quantity: parsed.quantity, unit: parsed.unit, note: rest.join(',').trim() };
}

/** `ai_calls` in memory; there are no limits. */
export class MemoryTagsStore implements SuggestTagsStore {
  aiCalls: AiCallRecord[] = [];

  /** Local and manual: no rate limits. */
  async checkLimit() {
    return 'ok' as const;
  }

  async logAiCall(call: AiCallRecord) {
    this.aiCalls.push(call);
  }
}

export type CliIo = {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Reads an env var. Defaults to `Deno.env.get`. */
  env?: (key: string) => string | undefined;
};

/**
 * Runs the CLI. Returns the exit code: 0 suggested (even when nothing fit), 1 the suggestion
 * failed (AI off or failing), 2 bad usage or an unexpected error. `AI_MODEL_TAGS` is set to
 * `--model` (or the configured model) for the run and restored after.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  let args: CliArgs;
  let request: SuggestRecipeTagsRequest;
  try {
    args = parseArgs(argv);
    if (!args.help) {
      if (args.name === null) throw new CliUsageError('No recipe name given.');
      const parsed = SuggestRecipeTagsRequestSchema.safeParse({
        name: args.name,
        notes: args.notes,
        ingredients: args.ingredients.map(ingredientFromLine),
      });
      if (!parsed.success) throw new CliUsageError(parsed.error.issues[0].message);
      request = parsed.data;
    }
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
  const model = args.model ?? (env('AI_MODEL_TAGS')?.trim() || env('AI_MODEL_RECIPE')?.trim());
  if (!model) {
    io.err('Neither AI_MODEL_TAGS nor AI_MODEL_RECIPE is set. Add one to supabase/functions/.env or pass --model (e.g. --model mock).');
    return 2;
  }

  if (args.dryRun) {
    const { instructions, prompt } = buildSuggestRecipeTagsPrompt(request!);
    io.out(`--- instructions (${SUGGEST_RECIPE_TAGS_PROMPT_VERSION}) ---\n${instructions}\n--- prompt ---\n${prompt}\n---`);
    io.out(`Dry run: no call made (would use ${model}).`);
    return 0;
  }

  // With --json, stdout is only the response; everything else goes to stderr.
  const info = args.json ? io.err : io.out;
  const stopTrace = args.quiet ? () => {} : traceAiCalls(info, { raw: args.raw });
  const saved = Deno.env.get('AI_MODEL_TAGS');
  Deno.env.set('AI_MODEL_TAGS', model);
  const store = new MemoryTagsStore();
  let response: SuggestRecipeTagsResponse;
  try {
    response = await suggestRecipeTags(request!, { store });
  } catch (err) {
    if (err instanceof SuggestTagsError) {
      io.err(`Suggestion failed: ${err.failure.code}: ${err.message}`);
      info(formatStats(store.aiCalls));
      return 1;
    }
    io.err(`Suggestion failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    return 2;
  } finally {
    stopTrace();
    if (saved === undefined) Deno.env.delete('AI_MODEL_TAGS');
    else Deno.env.set('AI_MODEL_TAGS', saved);
  }

  io.out(args.json ? JSON.stringify(response, null, 2) : `tags: ${formatTags(response.tags)}\n`);
  info(formatStats(store.aiCalls));
  return 0;
}

if (import.meta.main) {
  // runAiTask logs a JSON line per call to stdout; keep stdout for the tags or --json response.
  const print = console.log;
  console.log = console.error;
  const code = await run(Deno.args, { out: (text) => print(text), err: (text) => console.error(text) });
  Deno.exit(code);
}
