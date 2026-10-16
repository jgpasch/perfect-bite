// `yarn ai:eval:steps`: the step-matching eval (cook mode, spec 4.5; docs/spikes.md §5). Runs every
// recipe in recipes.json through the function's own matchRecipeSteps(), one at a time, and scores
// it against the hand-labelled matches: precision and recall of (step, ingredient) pairs, the
// share of ingredients placed in no step, split-amount accuracy, and latency and tokens per
// recipe, then prints every miss. It costs real tokens, so it isn't part of CI or `deno test`.
import { SuggestRecipeTagsIngredientSchema } from '@shared/index.ts';
import { z } from 'zod';

import type { StepMatchRecipe } from '../../_shared/ai/prompts/match-recipe-steps.v1.ts';
import type { AiCallRecord } from '../../_shared/ai/run-ai-task.ts';
import { AI_OFF, type StepMatch } from '../../_shared/ai/tasks.ts';
import { percentile } from '../../categorize-ingredients/cli.ts';
import { matchRecipeSteps, StepMatchError } from '../match.ts';

export const USAGE = `Usage: yarn ai:eval:steps [options]

Runs every recipe in eval/recipes.json against the configured model and prints precision and
recall of (step, ingredient) pairs, ingredients placed nowhere, split-amount accuracy, latency and
tokens per recipe, and every miss.

Options:
  --model <provider:model|mock>  Use this model instead of AI_MODEL_STEPS (else AI_MODEL_RECIPE)
  --only <id>                    Run only this recipe (repeat for several)
  --price-in <usd>               Input price per million tokens, to print a cost per recipe
  --price-out <usd>              Output price per million tokens (reasoning included)
  -h, --help                     Show this help`;

/** The suggested bar (tasks.md): a wrong ingredient on a step is worse than a missing one. */
export const BAR = { precision: 0.95, recall: 0.85 } as const;

/** A share within this fraction of the expected one counts as right (1/3 is written 0.333). */
export const SHARE_TOLERANCE = 0.02;

const IndexListSchema = z.array(z.number().int().min(0));

const ExpectedStepSchema = z
  .object({
    /** Needed for recall. */
    uses: IndexListSchema,
    /** Fair either way: not needed for recall, and not a precision miss. */
    optional: IndexListSchema.optional(),
    /** The step's share of an ingredient the recipe splits, by index. */
    shares: z.record(z.string().regex(/^\d+$/), z.number().positive()).optional(),
    /** Ingredients where any share (or none) is fine. */
    any_share: IndexListSchema.optional(),
  })
  .strict();
export type ExpectedStep = z.infer<typeof ExpectedStepSchema>;

const EvalRecipeSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  source: z.string().min(1),
  name: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
  ingredients: z.array(SuggestRecipeTagsIngredientSchema).min(1),
  expected: z.array(ExpectedStepSchema),
});
export type EvalRecipe = z.infer<typeof EvalRecipeSchema>;

const RecipesFileSchema = z.object({ recipes: z.array(EvalRecipeSchema).min(1) });

export class EvalUsageError extends Error {
  override name = 'EvalUsageError';
}

/**
 * Parses and checks recipes.json: unique ids, one expected entry per step, every index a real
 * ingredient, no index both needed and optional in a step, and shares only on needed ones.
 */
export function parseRecipes(json: unknown): EvalRecipe[] {
  const parsed = RecipesFileSchema.safeParse(json);
  if (!parsed.success) throw new EvalUsageError(`recipes.json is invalid: ${parsed.error.message}`);
  const ids = new Set<string>();
  for (const r of parsed.data.recipes) {
    const where = `recipes.json: ${r.id}`;
    if (ids.has(r.id)) throw new EvalUsageError(`${where} is listed twice`);
    ids.add(r.id);
    if (r.expected.length !== r.steps.length) {
      throw new EvalUsageError(`${where} has ${r.steps.length} steps but ${r.expected.length} expected entries`);
    }
    r.expected.forEach((e, i) => {
      const step = `${where} step ${i + 1}`;
      const all = [...e.uses, ...(e.optional ?? []), ...(e.any_share ?? []), ...Object.keys(e.shares ?? {}).map(Number)];
      if (all.some((n) => n >= r.ingredients.length)) throw new EvalUsageError(`${step} names an ingredient that isn't there`);
      if (new Set(e.uses).size !== e.uses.length) throw new EvalUsageError(`${step} lists an ingredient twice`);
      if ((e.optional ?? []).some((n) => e.uses.includes(n))) throw new EvalUsageError(`${step} has an ingredient both needed and optional`);
      if (Object.keys(e.shares ?? {}).some((k) => !e.uses.includes(Number(k)))) {
        throw new EvalUsageError(`${step} has a share on an ingredient it doesn't need`);
      }
    });
  }
  return parsed.data.recipes;
}

export type PairMiss = { step: number; ingredient: number; kind: 'wrong' | 'missed' };
export type ShareMiss = { step: number; ingredient: number; expected: number | null; got: number | null };

export type RecipeOutcome = {
  recipe: EvalRecipe;
  /** Null when the match failed. */
  error: string | null;
  /** Right pairs returned (needed ones only), wrong pairs returned, needed pairs not returned. */
  right: number;
  wrong: number;
  missed: number;
  pairMisses: PairMiss[];
  /** Ingredients in no returned step. */
  unplaced: number;
  /** Shares scored (a needed pair that came back, outside `any_share`) and how many were right. */
  sharesScored: number;
  sharesRight: number;
  shareMisses: ShareMiss[];
  calls: AiCallRecord[];
};

function shareOk(expected: number | null, got: number | null): boolean {
  if (expected === null || got === null) return expected === got;
  return Math.abs(got - expected) <= SHARE_TOLERANCE * expected;
}

/** Pure: one recipe's match (null when it failed) against its expected matches. */
export function scoreRecipe(recipe: EvalRecipe, match: StepMatch | null, calls: AiCallRecord[] = [], error: string | null = null): RecipeOutcome {
  const outcome: RecipeOutcome = {
    recipe,
    error,
    right: 0,
    wrong: 0,
    missed: 0,
    pairMisses: [],
    unplaced: recipe.ingredients.length,
    sharesScored: 0,
    sharesRight: 0,
    shareMisses: [],
    calls,
  };
  if (match === null) {
    recipe.expected.forEach((e, i) => {
      for (const ingredient of e.uses) outcome.pairMisses.push({ step: i + 1, ingredient, kind: 'missed' });
      outcome.missed += e.uses.length;
    });
    return outcome;
  }
  outcome.unplaced = recipe.ingredients.filter((_, n) => !match.some((uses) => uses.some((u) => u.ingredient === n))).length;
  recipe.expected.forEach((e, i) => {
    const got = new Map((match[i] ?? []).map((u) => [u.ingredient, u.quantity]));
    for (const [ingredient, quantity] of got) {
      if (e.uses.includes(ingredient)) {
        outcome.right++;
        if (e.any_share?.includes(ingredient)) continue;
        const expected = e.shares?.[String(ingredient)] ?? null;
        outcome.sharesScored++;
        if (shareOk(expected, quantity)) outcome.sharesRight++;
        else outcome.shareMisses.push({ step: i + 1, ingredient, expected, got: quantity });
      } else if (!e.optional?.includes(ingredient)) {
        outcome.wrong++;
        outcome.pairMisses.push({ step: i + 1, ingredient, kind: 'wrong' });
      }
    }
    for (const ingredient of e.uses) {
      if (got.has(ingredient)) continue;
      outcome.missed++;
      outcome.pairMisses.push({ step: i + 1, ingredient, kind: 'missed' });
    }
  });
  return outcome;
}

export type EvalArgs = { model: string | null; only: string[]; priceIn: number | null; priceOut: number | null; help: boolean };

function price(argv: readonly string[], i: number, flag: string): number {
  const arg = argv[i];
  const value = arg === flag ? argv[i + 1] : arg.slice(flag.length + 1);
  const n = Number(value);
  if (!value || !Number.isFinite(n) || n < 0) throw new EvalUsageError(`${flag} needs a price in USD per million tokens, e.g. ${flag} 0.3`);
  return n;
}

/** Pure: argv (without the script) → options. */
export function parseArgs(argv: readonly string[]): EvalArgs {
  const args: EvalArgs = { model: null, only: [], priceIn: null, priceOut: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const takes = (flag: string) => arg === flag || arg.startsWith(`${flag}=`);
    const value = (flag: string) => {
      const v = arg === flag ? argv[++i] : arg.slice(flag.length + 1);
      if (!v?.trim() || v.startsWith('-')) throw new EvalUsageError(`${flag} needs a value`);
      return v.trim();
    };
    if (arg === '-h' || arg === '--help') args.help = true;
    else if (takes('--model')) args.model = value('--model');
    else if (takes('--only')) args.only.push(value('--only'));
    else if (takes('--price-in')) {
      args.priceIn = price(argv, i, '--price-in');
      if (arg === '--price-in') i++;
    } else if (takes('--price-out')) {
      args.priceOut = price(argv, i, '--price-out');
      if (arg === '--price-out') i++;
    } else throw new EvalUsageError(`Unknown option: ${arg}`);
  }
  return args;
}

function pct(n: number, total: number): string {
  return `${n}/${total} (${total === 0 ? 0 : Math.round((1000 * n) / total) / 10}%)`;
}

const ratio = (n: number, total: number) => (total === 0 ? '-' : `${Math.round((100 * n) / total)}%`);

function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => [...r[col]].length)));
  return rows.map((r) => `  ${r.map((cell, col) => cell + ' '.repeat(widths[col] - [...cell].length)).join('  ').trimEnd()}`);
}

const ms = (calls: readonly AiCallRecord[]) => calls.reduce((n, c) => n + c.duration_ms, 0);
const tokens = (calls: readonly AiCallRecord[], pick: (c: AiCallRecord) => number | null) => calls.reduce((n, c) => n + (pick(c) ?? 0), 0);
const outputTokens = (c: AiCallRecord) => (c.output_tokens ?? 0) + (c.reasoning_tokens ?? 0);

/** Pure: the miss lines for one recipe, empty when it was all right. */
export function recipeMisses(o: RecipeOutcome): string[] {
  const name = (n: number) => o.recipe.ingredients[n].name;
  const lines: string[] = [];
  if (o.error) lines.push(`error: ${o.error}`);
  for (const m of o.pairMisses) lines.push(`step ${m.step}: ${m.kind} ${name(m.ingredient)}`);
  const share = (n: number | null) => (n === null ? 'none' : String(n));
  for (const m of o.shareMisses) lines.push(`step ${m.step}: share of ${name(m.ingredient)} expected ${share(m.expected)}, got ${share(m.got)}`);
  return lines;
}

export type Prices = { input: number | null; output: number | null };

/** Pure: the printed report. */
export function formatReport(outcomes: readonly RecipeOutcome[], prices: Prices = { input: null, output: null }): string {
  const priced = prices.input !== null && prices.output !== null;
  const cost = (calls: readonly AiCallRecord[]) =>
    (tokens(calls, (c) => c.input_tokens) * prices.input! + tokens(calls, outputTokens) * prices.output!) / 1_000_000;
  const rows = [['recipe', 'steps', 'precision', 'recall', 'shares', 'unplaced', 'ms', 'in/out tokens', ...(priced ? ['cost'] : [])]];
  for (const o of outcomes) {
    rows.push([
      o.recipe.id,
      String(o.recipe.steps.length),
      o.error ? 'FAIL' : ratio(o.right, o.right + o.wrong),
      ratio(o.right, o.right + o.missed),
      o.sharesScored === 0 ? '-' : `${o.sharesRight}/${o.sharesScored}`,
      `${o.unplaced}/${o.recipe.ingredients.length}`,
      String(ms(o.calls)),
      `${tokens(o.calls, (c) => c.input_tokens)}/${tokens(o.calls, outputTokens)}`,
      ...(priced ? [`$${cost(o.calls).toFixed(5)}`] : []),
    ]);
  }
  const lines = [...table(rows), ''];

  const sum = (pick: (o: RecipeOutcome) => number) => outcomes.reduce((n, o) => n + pick(o), 0);
  const right = sum((o) => o.right);
  const wrong = sum((o) => o.wrong);
  const missed = sum((o) => o.missed);
  const precision = right + wrong === 0 ? 0 : right / (right + wrong);
  const recall = right + missed === 0 ? 0 : right / (right + missed);
  const timed = outcomes.filter((o) => o.calls.length > 0);
  lines.push(`precision:  ${pct(right, right + wrong)}  (bar ${BAR.precision * 100}%)`);
  lines.push(`recall:     ${pct(right, right + missed)}  (bar ${BAR.recall * 100}%)`);
  lines.push(`unplaced:   ${pct(sum((o) => o.unplaced), sum((o) => o.recipe.ingredients.length))} ingredients in no step`);
  lines.push(`shares:     ${pct(sum((o) => o.sharesRight), sum((o) => o.sharesScored))} right (a split's share, else none)`);
  lines.push(`failures:   ${outcomes.filter((o) => o.error).length} of ${outcomes.length} recipes`);
  if (timed.length > 0) {
    const latency = timed.map((o) => ms(o.calls));
    const input = timed.map((o) => tokens(o.calls, (c) => c.input_tokens));
    const output = timed.map((o) => tokens(o.calls, outputTokens));
    lines.push(`latency:    p50 ${percentile(latency, 50)} ms, p95 ${percentile(latency, 95)} ms per recipe`);
    lines.push(`tokens:     p50 ${percentile(input, 50)} in, ${percentile(output, 50)} out (reasoning included) per recipe`);
    if (priced) {
      const costs = timed.map((o) => cost(o.calls));
      lines.push(`cost:       p50 $${percentile(costs, 50).toFixed(5)}, total $${costs.reduce((a, b) => a + b, 0).toFixed(4)}`);
    }
  }
  const pass = outcomes.length > 0 && precision >= BAR.precision && recall >= BAR.recall;
  lines.push(`bar:        ${pass ? 'met' : 'NOT met'}`);

  const missedRecipes = outcomes.map((o) => ({ o, misses: recipeMisses(o) })).filter((m) => m.misses.length > 0);
  lines.push('');
  if (missedRecipes.length === 0) {
    lines.push('No misses.');
  } else {
    lines.push('Misses:');
    for (const { o, misses } of missedRecipes) {
      lines.push(`  ${o.recipe.id}`);
      for (const miss of misses) lines.push(`    ${miss}`);
    }
  }
  return lines.join('\n');
}

/** Matches each recipe in turn (so latency is per call, not shared) and scores it. */
export async function runEval(recipes: readonly EvalRecipe[]): Promise<RecipeOutcome[]> {
  const outcomes: RecipeOutcome[] = [];
  for (const recipe of recipes) {
    const calls: AiCallRecord[] = [];
    const input: StepMatchRecipe = { steps: recipe.steps, ingredients: recipe.ingredients };
    try {
      const { steps } = await matchRecipeSteps(input, { onCall: async (call) => void calls.push(call) });
      outcomes.push(scoreRecipe(recipe, steps, calls));
    } catch (err) {
      if (!(err instanceof StepMatchError)) throw err;
      outcomes.push(scoreRecipe(recipe, null, calls, `${err.reason}: ${err.message}`));
    }
  }
  return outcomes;
}

export type EvalIo = {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Returns recipes.json's text. Defaults to the file next to this script. */
  readRecipes?: () => Promise<string>;
  /** Reads an env var. Defaults to `Deno.env.get`. */
  env?: (key: string) => string | undefined;
};

/**
 * Runs the eval. Returns the exit code: 0 when it ran (whatever the score), 2 for bad usage, a bad
 * recipes.json, an unknown --only id, no model, or an unexpected error. `AI_MODEL_STEPS` is set to
 * `--model` (or the configured model) for the run and restored after.
 */
export async function run(argv: readonly string[], io: EvalIo): Promise<number> {
  let args: EvalArgs;
  let recipes: EvalRecipe[];
  try {
    args = parseArgs(argv);
    if (args.help) {
      io.out(USAGE);
      return 0;
    }
    const text = await (io.readRecipes ?? (() => Deno.readTextFile(new URL('./recipes.json', import.meta.url))))();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new EvalUsageError('recipes.json is not valid JSON');
    }
    recipes = parseRecipes(json);
    const unknown = args.only.filter((id) => !recipes.some((r) => r.id === id));
    if (unknown.length > 0) throw new EvalUsageError(`No recipe with id ${unknown.join(', ')}`);
    if (args.only.length > 0) recipes = recipes.filter((r) => args.only.includes(r.id));
  } catch (err) {
    if (!(err instanceof EvalUsageError)) throw err;
    io.err(`${err.message}\n\n${USAGE}`);
    return 2;
  }

  const env = io.env ?? ((key: string) => Deno.env.get(key));
  const model = args.model ?? (env('AI_MODEL_STEPS')?.trim() || env('AI_MODEL_RECIPE')?.trim());
  if (!model || model === AI_OFF) {
    io.err(`The eval needs a model, but neither AI_MODEL_STEPS nor AI_MODEL_RECIPE is set (or it's '${AI_OFF}'). Set one in supabase/functions/.env or pass --model.`);
    return 2;
  }
  if (model === 'mock') io.err('Note: --model mock is the word-matching fake, not a real model; its score means nothing.');

  const saved = Deno.env.get('AI_MODEL_STEPS');
  Deno.env.set('AI_MODEL_STEPS', model);
  let outcomes: RecipeOutcome[];
  try {
    outcomes = await runEval(recipes);
  } catch (err) {
    io.err(`Eval failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    return 2;
  } finally {
    if (saved === undefined) Deno.env.delete('AI_MODEL_STEPS');
    else Deno.env.set('AI_MODEL_STEPS', saved);
  }

  io.out(`${recipes.length} recipes, model ${model}\n`);
  io.out(formatReport(outcomes, { input: args.priceIn, output: args.priceOut }));
  return 0;
}

if (import.meta.main) {
  // runAiTask logs a JSON line per call to stdout; keep stdout for the report.
  const print = console.log;
  console.log = console.error;
  const code = await run(Deno.args, { out: (text) => print(text), err: (text) => console.error(text) });
  Deno.exit(code);
}
