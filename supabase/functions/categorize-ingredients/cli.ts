// `yarn ai:categorize "za'atar" "chicken thighs" "call mom"`: runs the function's own categorize()
// by hand, with the same runAiTask, prompt and validation, against an in-memory store where every
// name starts unknown. Nothing is written to any database, and the rate limits don't apply.
// Names also come from stdin, one per line: `cat names.txt | yarn ai:categorize -`.
// Every LLM call is printed in full (instructions, prompt, response, tokens, latency) unless --quiet.
import { normalizeIngredientName, OTHER_CATEGORY_ID, SYSTEM_CATEGORIES } from '@shared/index.ts';

import { buildCategorizePrompt, CATEGORIZE_PROMPT_VERSION } from '../_shared/ai/prompts/categorize.v1.ts';
import type { AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { traceAiCalls } from '../_shared/ai/trace.ts';
import {
  categorize,
  CategorizeInputError,
  MAX_NAME_LENGTH,
  MAX_NAMES_PER_CALL,
  type CategorizedAnswer,
  type CategorizeResponse,
  type CategorizeStore,
  type IngredientRow,
} from './handler.ts';

export const USAGE = `Usage: yarn ai:categorize [options] <name>... (or - to read names from stdin, one per line)

Options:
  --model <provider:model|mock|off>  Use this model instead of AI_MODEL_CATEGORIZE
  --raw                              Also print the raw HTTP request and response bodies
  --quiet                            Only the table and totals, not each call's prompt and response
  --dry-run                          Print the instructions and prompt, and make no call
  --json                             Print the raw { results } response the app would get
  -h, --help                         Show this help

Each LLM call is printed as it finishes: instructions, prompt, response, finish reason, input,
cached, output and reasoning tokens, and latency.`;

export type CliArgs = {
  /** Names given as arguments, in order. */
  names: string[];
  /** `-` was given: names also come from stdin. */
  stdin: boolean;
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

/** Pure: argv (without the script) → options. Throws CliUsageError on a bad flag. */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    names: [],
    stdin: false,
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
      args.names.push(arg);
    } else if (arg === '-') {
      args.stdin = true;
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
    } else if (arg === '--model' || arg.startsWith('--model=')) {
      const value = arg === '--model' ? argv[++i] : arg.slice('--model='.length);
      if (!value?.trim() || (arg === '--model' && value.startsWith('-'))) {
        throw new CliUsageError('--model needs a value, e.g. --model mock or --model anthropic:claude-haiku-5-5');
      }
      args.model = value.trim();
    } else {
      throw new CliUsageError(`Unknown option: ${arg}`);
    }
  }
  return args;
}

/** Stdin text → names: one per line, blank lines skipped. */
export function namesFromText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** The `ingredients` table in memory, starting empty, with the real store's conditional writes. */
export class MemoryStore implements CategorizeStore {
  rows = new Map<string, IngredientRow>();
  aiCalls: AiCallRecord[] = [];

  async getIngredients(names: readonly string[]) {
    return names.flatMap((n) => {
      const row = this.rows.get(n);
      return row ? [{ ...row }] : [];
    });
  }

  async insertPending(rows: readonly { normalized_name: string; display_name: string }[]) {
    for (const r of rows) {
      if (this.rows.has(r.normalized_name)) continue;
      this.rows.set(r.normalized_name, {
        normalized_name: r.normalized_name,
        status: 'pending',
        default_category_id: null,
        is_grocery_item: null,
        attempts: 0,
      });
    }
  }

  async saveCategorized(rows: readonly CategorizedAnswer[]) {
    for (const r of rows) {
      const row = this.rows.get(r.normalized_name);
      if (!row || row.status === 'categorized') continue;
      Object.assign(row, { status: 'categorized', default_category_id: r.default_category_id, is_grocery_item: r.is_grocery_item });
    }
  }

  async saveFailed(names: readonly string[]) {
    for (const n of names) {
      const row = this.rows.get(n);
      if (!row || row.status === 'categorized') continue;
      Object.assign(row, { status: 'failed', default_category_id: OTHER_CATEGORY_ID, attempts: row.attempts + 1 });
    }
  }

  async logAiCall(call: AiCallRecord) {
    this.aiCalls.push(call);
  }

  /** Local and manual: no rate limits, no global cap. */
  async checkLimit() {
    return 'ok' as const;
  }
}

export type CliIo = {
  out: (text: string) => void;
  err: (text: string) => void;
  readStdin: () => Promise<string>;
  /** Reads an env var. Defaults to `Deno.env.get`. */
  env?: (key: string) => string | undefined;
};

const SLUG_BY_ID = new Map<string, string>(SYSTEM_CATEGORIES.map((c) => [c.id, c.slug]));

/** Input names normalized and deduplicated, in input order, as categorize() keys its results. */
function resultKeys(names: readonly string[]): string[] {
  return [...new Set(names.map(normalizeIngredientName).filter((n) => n !== ''))];
}

function table(rows: string[][]): string {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => [...r[col]].length)));
  return rows.map((r) => r.map((cell, col) => cell + ' '.repeat(widths[col] - [...cell].length)).join('  ').trimEnd()).join('\n');
}

export function formatTable(names: readonly string[], response: CategorizeResponse): string {
  const rows = [['name', 'category', 'is_grocery_item', 'status']];
  for (const key of resultKeys(names)) {
    const r = response.results[key];
    if (!r) continue;
    rows.push([
      key,
      r.category_id ? (SLUG_BY_ID.get(r.category_id) ?? r.category_id) : '-',
      r.is_grocery_item === null ? '-' : String(r.is_grocery_item),
      r.status,
    ]);
  }
  return table(rows);
}

export function formatStats(calls: readonly AiCallRecord[]): string {
  if (calls.length === 0) return 'No LLM call made.';
  const sum = (pick: (c: AiCallRecord) => number | null) =>
    calls.every((c) => pick(c) === null) ? '?' : String(calls.reduce((n, c) => n + (pick(c) ?? 0), 0));
  const failed = calls.filter((c) => c.status !== 'ok');
  return [
    `model:          ${[...new Set(calls.map((c) => c.model))].join(' -> ')}`,
    `prompt version: ${calls[0].prompt_version}`,
    `calls:          ${calls.length}${failed.length ? ` (${failed.map((c) => `${c.model}: ${c.status}`).join(', ')})` : ''}`,
    `input tokens:   ${sum((c) => c.input_tokens)} (cached ${sum((c) => c.cached_input_tokens)})`,
    `output tokens:  ${sum((c) => c.output_tokens)} (reasoning ${sum((c) => c.reasoning_tokens)})`,
    `total tokens:   ${sum((c) => (c.input_tokens === null && c.output_tokens === null ? null : (c.input_tokens ?? 0) + (c.output_tokens ?? 0)))}`,
    `latency:        ${calls.reduce((n, c) => n + c.duration_ms, 0)} ms`,
  ].join('\n');
}

/**
 * Runs the CLI. Returns the exit code: 0 ok, 1 any name `failed`, 2 bad usage or an error.
 * `AI_MODEL_CATEGORIZE` is set to `--model` for the run and restored after.
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

  const names = [...args.names, ...(args.stdin ? namesFromText(await io.readStdin()) : [])];
  if (names.length === 0) {
    io.err(`No names given.\n\n${USAGE}`);
    return 2;
  }

  const env = io.env ?? ((key: string) => Deno.env.get(key));
  const model = args.model ?? env('AI_MODEL_CATEGORIZE')?.trim();
  if (!model) {
    io.err('AI_MODEL_CATEGORIZE is not set. Add it to supabase/functions/.env or pass --model (e.g. --model mock).');
    return 2;
  }

  // With --json, stdout is only the response; everything else goes to stderr.
  const info = args.json ? io.err : io.out;

  if (args.dryRun) {
    // Every name starts unknown, so all of them that fit the length limit reach the LLM.
    const toSend = resultKeys(names).filter((n) => [...n].length <= MAX_NAME_LENGTH);
    for (let i = 0; i < toSend.length; i += MAX_NAMES_PER_CALL) {
      const { instructions, prompt } = buildCategorizePrompt(toSend.slice(i, i + MAX_NAMES_PER_CALL));
      io.out(`--- instructions (${CATEGORIZE_PROMPT_VERSION}) ---\n${instructions}\n--- prompt ---\n${prompt}\n---`);
    }
    io.out(`Dry run: no call made (would use ${model}).`);
    return 0;
  }

  const store = new MemoryStore();
  const stopTrace = args.quiet ? () => {} : traceAiCalls(info, { raw: args.raw });
  const saved = Deno.env.get('AI_MODEL_CATEGORIZE');
  Deno.env.set('AI_MODEL_CATEGORIZE', model);
  let response: CategorizeResponse;
  try {
    response = await categorize(names, store);
  } catch (err) {
    if (err instanceof CategorizeInputError) {
      io.err(err.message);
      return 2;
    }
    io.err(`Categorization failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    return 2;
  } finally {
    stopTrace();
    if (saved === undefined) Deno.env.delete('AI_MODEL_CATEGORIZE');
    else Deno.env.set('AI_MODEL_CATEGORIZE', saved);
  }

  if (args.json) {
    io.out(JSON.stringify(response, null, 2));
  } else {
    io.out(formatTable(names, response));
    io.out('');
  }
  info(formatStats(store.aiCalls));

  const failed = Object.values(response.results).filter((r) => r.status === 'failed').length;
  if (failed > 0) {
    io.err(`${failed} name${failed === 1 ? '' : 's'} failed.`);
    return 1;
  }
  return 0;
}

if (import.meta.main) {
  // runAiTask logs a JSON line per call to stdout; keep stdout for the table or --json response.
  const print = console.log;
  console.log = console.error;
  const code = await run(Deno.args, {
    out: (text) => print(text),
    err: (text) => console.error(text),
    readStdin: () => new Response(Deno.stdin.readable).text(),
  });
  Deno.exit(code);
}
