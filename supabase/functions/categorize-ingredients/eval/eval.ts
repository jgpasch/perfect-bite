// `yarn ai:eval`: the golden-set eval (spec §6.4). Runs every name in golden.json through the
// function's own categorize(), with the same runAiTask, prompt and validation, against the CLI's
// in-memory store, in batches of 50 so each batch is one LLM call. Prints the accuracy and every
// miss. Run it whenever the model or the prompt changes; it costs real tokens, so it isn't part
// of CI or `deno test`.
import { normalizeIngredientName, SYSTEM_CATEGORIES, type CategorySlug } from '@shared/index.ts';
import { z } from 'zod';

import type { AiCallRecord } from '../../_shared/ai/run-ai-task.ts';
import { AI_OFF } from '../../_shared/ai/tasks.ts';
import { formatStats, MemoryStore } from '../cli.ts';
import { categorize, MAX_NAME_LENGTH, type CategorizeResult } from '../handler.ts';

export const USAGE = `Usage: yarn ai:eval [options]

Runs the golden set (eval/golden.json) against the configured model and prints accuracy and misses.

Options:
  --model <provider:model|mock>  Use this model instead of AI_MODEL_CATEGORIZE
  -h, --help                     Show this help`;

/** Names per categorize() call, so each batch is one LLM call with injection names mixed in. */
export const EVAL_BATCH_SIZE = 50;

const CATEGORY_SLUGS = SYSTEM_CATEGORIES.map((c) => c.slug) as [CategorySlug, ...CategorySlug[]];
const SLUG_BY_ID = new Map<string, string>(SYSTEM_CATEGORIES.map((c) => [c.id, c.slug]));

const GoldenCaseSchema = z.object({
  name: z.string().min(1),
  category: z.enum(CATEGORY_SLUGS),
  /** Other slugs a shopper would accept, for items genuinely shelved in two places. */
  also: z.array(z.enum(CATEGORY_SLUGS)).optional(),
  is_grocery_item: z.boolean(),
  /** A prompt-injection attempt: expected other/false, and the rest of its batch must still be right. */
  injection: z.boolean().optional(),
});
export type GoldenCase = z.infer<typeof GoldenCaseSchema>;

const GoldenFileSchema = z.object({ cases: z.array(GoldenCaseSchema).min(1) });

export class EvalUsageError extends Error {
  override name = 'EvalUsageError';
}

/** Parses and checks golden.json: known slugs, unique names after normalizing, short enough to send. */
export function parseGolden(json: unknown): GoldenCase[] {
  const parsed = GoldenFileSchema.safeParse(json);
  if (!parsed.success) throw new EvalUsageError(`golden.json is invalid: ${parsed.error.message}`);
  const seen = new Set<string>();
  for (const c of parsed.data.cases) {
    const key = normalizeIngredientName(c.name);
    if (key === '') throw new EvalUsageError(`golden.json: "${c.name}" is empty after normalizing`);
    if ([...key].length > MAX_NAME_LENGTH) {
      throw new EvalUsageError(`golden.json: "${c.name}" is over ${MAX_NAME_LENGTH} characters and would never reach the LLM`);
    }
    if (seen.has(key)) throw new EvalUsageError(`golden.json: "${c.name}" duplicates another name after normalizing`);
    seen.add(key);
  }
  return parsed.data.cases;
}

export type EvalArgs = { model: string | null; help: boolean };

/** Pure: argv (without the script) → options. Throws EvalUsageError on a bad flag. */
export function parseArgs(argv: readonly string[]): EvalArgs {
  const args: EvalArgs = { model: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else if (arg === '--model' || arg.startsWith('--model=')) {
      const value = arg === '--model' ? argv[++i] : arg.slice('--model='.length);
      if (!value?.trim() || (arg === '--model' && value.startsWith('-'))) {
        throw new EvalUsageError('--model needs a value, e.g. --model anthropic:claude-haiku-5-5');
      }
      args.model = value.trim();
    } else {
      throw new EvalUsageError(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export type CaseOutcome = {
  case: GoldenCase;
  /** 1-based batch number. */
  batch: number;
  /** The returned slug, or null when no category came back. */
  slug: string | null;
  isGroceryItem: boolean | null;
  status: CategorizeResult['status'] | 'missing';
  categoryOk: boolean;
  groceryOk: boolean;
  /** Category (or an accepted alternative) and is_grocery_item both right, and categorized. */
  correct: boolean;
};

/** Pure: one golden case against what categorize() returned for it. */
export function scoreCase(c: GoldenCase, result: CategorizeResult | undefined, batch: number): CaseOutcome {
  const slug = result?.category_id ? (SLUG_BY_ID.get(result.category_id) ?? result.category_id) : null;
  const status = result?.status ?? 'missing';
  const categoryOk = slug !== null && (slug === c.category || (c.also ?? []).includes(slug as CategorySlug));
  const groceryOk = result?.is_grocery_item === c.is_grocery_item;
  return {
    case: c,
    batch,
    slug,
    isGroceryItem: result?.is_grocery_item ?? null,
    status,
    categoryOk,
    groceryOk,
    correct: status === 'categorized' && categoryOk && groceryOk,
  };
}

export type EvalReport = { outcomes: CaseOutcome[]; calls: AiCallRecord[] };

/** Runs every case through categorize(), one fresh in-memory store per batch, in file order. */
export async function runEval(cases: readonly GoldenCase[], batchSize = EVAL_BATCH_SIZE): Promise<EvalReport> {
  const outcomes: CaseOutcome[] = [];
  const calls: AiCallRecord[] = [];
  for (let i = 0; i < cases.length; i += batchSize) {
    const batch = cases.slice(i, i + batchSize);
    const store = new MemoryStore();
    const response = await categorize(batch.map((c) => c.name), store);
    for (const c of batch) {
      outcomes.push(scoreCase(c, response.results[normalizeIngredientName(c.name)], i / batchSize + 1));
    }
    calls.push(...store.aiCalls);
  }
  return { outcomes, calls };
}

function pct(n: number, total: number): string {
  return `${n}/${total} (${total === 0 ? 0 : Math.round((1000 * n) / total) / 10}%)`;
}

function describeGot(o: CaseOutcome): string {
  if (o.status !== 'categorized') return o.status;
  return `${o.slug ?? '-'}/${o.isGroceryItem === null ? '-' : String(o.isGroceryItem)}`;
}

function describeExpected(c: GoldenCase): string {
  const also = c.also?.length ? ` (or ${c.also.join(', ')})` : '';
  return `${c.category}/${c.is_grocery_item}${also}`;
}

/** Pure: the printed report. */
export function formatReport(report: EvalReport): string {
  const { outcomes } = report;
  const lines: string[] = [];
  lines.push(`accuracy:        ${pct(outcomes.filter((o) => o.correct).length, outcomes.length)}`);
  lines.push(`category:        ${pct(outcomes.filter((o) => o.categoryOk).length, outcomes.length)}`);
  lines.push(`is_grocery_item: ${pct(outcomes.filter((o) => o.groceryOk).length, outcomes.length)}`);

  const injections = outcomes.filter((o) => o.case.injection);
  if (injections.length > 0) {
    lines.push(`injection names: ${pct(injections.filter((o) => o.correct).length, injections.length)} answered other/false`);
    const batches = [...new Set(injections.map((o) => o.batch))];
    for (const b of batches) {
      const rest = outcomes.filter((o) => o.batch === b && !o.case.injection);
      const count = injections.filter((o) => o.batch === b).length;
      lines.push(`  batch ${b} (${count} injection name${count === 1 ? '' : 's'}): ${pct(rest.filter((o) => o.correct).length, rest.length)} other names right`);
    }
  }

  const misses = outcomes.filter((o) => !o.correct);
  lines.push('');
  if (misses.length === 0) {
    lines.push('No misses.');
  } else {
    lines.push(`Misses (${misses.length}):`);
    const rows = [['name', 'expected', 'got', 'batch'], ...misses.map((o) => [
      `${o.case.name}${o.case.injection ? ' [injection]' : ''}`,
      describeExpected(o.case),
      describeGot(o),
      String(o.batch),
    ])];
    const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => [...r[col]].length)));
    for (const r of rows) {
      lines.push(`  ${r.map((cell, col) => cell + ' '.repeat(widths[col] - [...cell].length)).join('  ').trimEnd()}`);
    }
  }
  lines.push('');
  lines.push(formatStats(report.calls));
  return lines.join('\n');
}

export type EvalIo = {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Returns golden.json's text. Defaults to the file next to this script. */
  readGolden?: () => Promise<string>;
  /** Reads an env var. Defaults to `Deno.env.get`. */
  env?: (key: string) => string | undefined;
};

/**
 * Runs the eval. Returns the exit code: 0 when it ran (whatever the score), 2 for bad usage, a bad
 * golden file, no model, or an error from categorize(). `AI_MODEL_CATEGORIZE` is set to `--model`
 * for the run and restored after.
 */
export async function run(argv: readonly string[], io: EvalIo): Promise<number> {
  let args: EvalArgs;
  let cases: GoldenCase[];
  try {
    args = parseArgs(argv);
    if (args.help) {
      io.out(USAGE);
      return 0;
    }
    const text = await (io.readGolden ?? (() => Deno.readTextFile(new URL('./golden.json', import.meta.url))))();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new EvalUsageError('golden.json is not valid JSON');
    }
    cases = parseGolden(json);
  } catch (err) {
    if (!(err instanceof EvalUsageError)) throw err;
    io.err(`${err.message}\n\n${USAGE}`);
    return 2;
  }

  const env = io.env ?? ((key: string) => Deno.env.get(key));
  const model = args.model ?? env('AI_MODEL_CATEGORIZE')?.trim();
  if (!model || model === AI_OFF) {
    io.err(`The eval needs a model, but AI_MODEL_CATEGORIZE is ${model ? `'${AI_OFF}'` : 'not set'}. Set it in supabase/functions/.env or pass --model.`);
    return 2;
  }
  if (model === 'mock') io.err('Note: --model mock is the keyword fake, not a real model; its score means nothing.');

  const saved = Deno.env.get('AI_MODEL_CATEGORIZE');
  Deno.env.set('AI_MODEL_CATEGORIZE', model);
  let report: EvalReport;
  try {
    report = await runEval(cases);
  } catch (err) {
    io.err(`Eval failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    return 2;
  } finally {
    if (saved === undefined) Deno.env.delete('AI_MODEL_CATEGORIZE');
    else Deno.env.set('AI_MODEL_CATEGORIZE', saved);
  }

  io.out(`${cases.length} names in batches of ${EVAL_BATCH_SIZE}, model ${model}\n`);
  io.out(formatReport(report));
  return 0;
}

if (import.meta.main) {
  // runAiTask logs a JSON line per call to stdout; keep stdout for the report.
  const print = console.log;
  console.log = console.error;
  const code = await run(Deno.args, { out: (text) => print(text), err: (text) => console.error(text) });
  Deno.exit(code);
}
