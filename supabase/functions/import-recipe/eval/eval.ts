// `yarn ai:eval:recipe`: the recipe-import eval (spec §6.6). Runs every saved page in fixtures/
// through the function's own importRecipe(), with the same readPage, findRecipe, prompt, validation
// and cleanup, as the page a client sent, so nothing is fetched. Scores each page against
// expected.json: is_recipe, the name, precision and recall on normalized ingredient keys, and unit
// and quantity accuracy on the matched ones, then prints every miss. Categorize isn't called. It
// costs real tokens, so it isn't part of CI or `deno test`.
import { normalizeIngredientName, UNITS, type RecipeImportResponse } from '@shared/index.ts';
import { z } from 'zod';

import { AI_OFF } from '../../_shared/ai/tasks.ts';
import type { AiCallRecord } from '../../_shared/ai/run-ai-task.ts';
import { readPage } from '../../_shared/fetch-page.ts';
import { formatStats } from '../../categorize-ingredients/cli.ts';
import { MemoryRecipeStore } from '../cli.ts';
import { ImportRecipeError, importRecipe } from '../handler.ts';

export const USAGE = `Usage: yarn ai:eval:recipe [options]

Runs every page in eval/fixtures/ against the configured model and prints precision, recall, unit
and quantity accuracy per page, and every miss.

Options:
  --model <provider:model|mock>  Use this model instead of AI_MODEL_RECIPE
  -h, --help                     Show this help`;

/** Quantities within this of the expected one count as right (1/3 is written 0.333). */
export const QUANTITY_TOLERANCE = 0.01;

const UnitSchema = z.enum(UNITS).nullable();
const AmountSchema = z.object({ quantity: z.number().positive().nullable(), unit: UnitSchema });

const ExpectedIngredientSchema = z.object({
  name: z.string().min(1),
  /** Other names that count as this ingredient. */
  also: z.array(z.string().min(1)).optional(),
  quantity: z.number().positive().nullable(),
  unit: UnitSchema,
  /** Other amounts that count as right. */
  alternatives: z.array(AmountSchema).optional(),
  /** Not needed for recall, and not a precision miss when it comes back. */
  optional: z.boolean().optional(),
});
export type ExpectedIngredient = z.infer<typeof ExpectedIngredientSchema>;

const ExpectedPageSchema = z.object({
  file: z.string().regex(/^[a-z0-9-]+\.html$/),
  url: z.url(),
  is_recipe: z.boolean(),
  /** Recipe names that count as right; empty for non-recipes. */
  names: z.array(z.string().min(1)),
  ingredients: z.array(ExpectedIngredientSchema),
  /** Text that must not appear in the returned name, ingredient names or notes. */
  forbidden: z.array(z.string().min(1)).optional(),
});
export type ExpectedPage = z.infer<typeof ExpectedPageSchema>;

const ExpectedFileSchema = z.object({ pages: z.array(ExpectedPageSchema).min(1) });

export class EvalUsageError extends Error {
  override name = 'EvalUsageError';
}

/** Every key an expected ingredient accepts. */
export function acceptedKeys(e: ExpectedIngredient): Set<string> {
  return new Set([e.name, ...(e.also ?? [])].map(normalizeIngredientName));
}

/** Parses and checks expected.json: unique files, names for recipes only, ingredients for recipes only. */
export function parseExpected(json: unknown): ExpectedPage[] {
  const parsed = ExpectedFileSchema.safeParse(json);
  if (!parsed.success) throw new EvalUsageError(`expected.json is invalid: ${parsed.error.message}`);
  const files = new Set<string>();
  for (const p of parsed.data.pages) {
    if (files.has(p.file)) throw new EvalUsageError(`expected.json: ${p.file} is listed twice`);
    files.add(p.file);
    if (p.is_recipe && (p.names.length === 0 || p.ingredients.filter((i) => !i.optional).length === 0)) {
      throw new EvalUsageError(`expected.json: ${p.file} is a recipe but has no names or no required ingredients`);
    }
    if (!p.is_recipe && (p.names.length > 0 || p.ingredients.length > 0)) {
      throw new EvalUsageError(`expected.json: ${p.file} is not a recipe but has names or ingredients`);
    }
    for (const i of p.ingredients) {
      if ([...acceptedKeys(i)].some((k) => k === '')) {
        throw new EvalUsageError(`expected.json: ${p.file}: "${i.name}" has a name that is empty after normalizing`);
      }
    }
  }
  return parsed.data.pages;
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
        throw new EvalUsageError('--model needs a value, e.g. --model google:gemini-3.8-flash');
      }
      args.model = value.trim();
    } else {
      throw new EvalUsageError(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

/** What importRecipe() returned for a page, reduced to what's scored. */
export type GotPage =
  | { kind: 'recipe'; name: string; ingredients: RecipeImportResponse['ingredients'] }
  | { kind: 'not_a_recipe' }
  | { kind: 'error'; message: string };

type Got = RecipeImportResponse['ingredients'][number];

export type Match = { expected: ExpectedIngredient; got: Got; unitOk: boolean; quantityOk: boolean };

export type PageOutcome = {
  page: ExpectedPage;
  got: GotPage;
  isRecipeOk: boolean;
  /** Null when the page isn't a recipe or none came back. */
  nameOk: boolean | null;
  matches: Match[];
  /** Required ingredients nothing matched. */
  missing: ExpectedIngredient[];
  /** Returned ingredients that matched nothing. */
  extra: Got[];
  /** Forbidden text found in the result. */
  forbiddenFound: string[];
  /** Matched / returned, null when nothing came back. */
  precision: number | null;
  /** Matched required / required, null for pages with no required ingredients. */
  recall: number | null;
};

const quantityClose = (a: number | null, b: number | null) =>
  a === null || b === null ? a === b : Math.abs(a - b) <= QUANTITY_TOLERANCE;

function amounts(e: ExpectedIngredient) {
  return [{ quantity: e.quantity, unit: e.unit }, ...(e.alternatives ?? [])];
}

/**
 * Pure: one page's result against what's expected. Matching runs twice over the expected
 * ingredients (required first): first each takes an unmatched returned ingredient with an accepted
 * key and a right amount, then the rest take any with an accepted key. So repeated keys (salt for
 * the rub and salt for the sauce) pair up by amount.
 */
export function scorePage(page: ExpectedPage, got: GotPage): PageOutcome {
  const isRecipeOk = got.kind === 'error' ? false : (got.kind === 'recipe') === page.is_recipe;
  const returned = got.kind === 'recipe' ? got.ingredients : [];
  const nameOk =
    got.kind === 'recipe' && page.is_recipe
      ? page.names.map(normalizeIngredientName).includes(normalizeIngredientName(got.name))
      : null;

  const used = new Set<number>();
  const paired = new Map<ExpectedIngredient, Got>();
  const ordered = [...page.ingredients.filter((e) => !e.optional), ...page.ingredients.filter((e) => e.optional)];
  for (const needAmount of [true, false]) {
    for (const e of ordered) {
      if (paired.has(e)) continue;
      const keys = acceptedKeys(e);
      const amountOk = (g: Got) => amounts(e).some((a) => a.unit === g.unit && quantityClose(a.quantity, g.quantity));
      const i = returned.findIndex((g, i) => !used.has(i) && keys.has(g.ingredientName) && (!needAmount || amountOk(g)));
      if (i < 0) continue;
      used.add(i);
      paired.set(e, returned[i]);
    }
  }
  const matches: Match[] = [];
  const missing: ExpectedIngredient[] = [];
  for (const e of page.ingredients) {
    const g = paired.get(e);
    if (!g) {
      if (!e.optional) missing.push(e);
      continue;
    }
    matches.push({
      expected: e,
      got: g,
      unitOk: amounts(e).some((a) => a.unit === g.unit),
      quantityOk: amounts(e).some((a) => quantityClose(a.quantity, g.quantity)),
    });
  }
  const extra = returned.filter((_, i) => !used.has(i));

  const haystack = got.kind === 'recipe'
    ? [got.name, ...got.ingredients.flatMap((g) => [g.displayName, g.ingredientName, g.note])].join('\n').toLowerCase()
    : '';
  const forbiddenFound = (page.forbidden ?? []).filter((f) => haystack.includes(f.toLowerCase()));

  const required = page.ingredients.filter((e) => !e.optional).length;
  return {
    page,
    got,
    isRecipeOk,
    nameOk,
    matches,
    missing,
    extra,
    forbiddenFound,
    precision: returned.length === 0 ? null : matches.length / returned.length,
    recall: required === 0 ? null : matches.filter((m) => !m.expected.optional).length / required,
  };
}

export type EvalReport = { outcomes: PageOutcome[]; calls: AiCallRecord[] };

/**
 * Runs every page through importRecipe() as a client-sent page, one fresh in-memory store each,
 * in file order. Import failures (not a recipe, the model failing) are scored, not thrown.
 */
export async function runEval(pages: readonly ExpectedPage[], readFixture: (file: string) => Promise<string>): Promise<EvalReport> {
  const outcomes: PageOutcome[] = [];
  const calls: AiCallRecord[] = [];
  for (const page of pages) {
    const html = await readFixture(page.file);
    const read = readPage(html);
    const store = new MemoryRecipeStore();
    let got: GotPage;
    try {
      const response = await importRecipe(
        { url: page.url, page: { ...(read.title === null ? {} : { title: read.title }), jsonLd: read.jsonLd, text: read.text } },
        {
          store,
          // Only extraction is scored; categories would cost a second call per page.
          categorize: async () => ({ results: {} }),
          fetchPage: () => Promise.reject(new Error('The eval never fetches')),
        },
      );
      got = { kind: 'recipe', name: response.name, ingredients: response.ingredients };
    } catch (err) {
      if (!(err instanceof ImportRecipeError)) throw err;
      got = err.failure.code === 'not_a_recipe' ? { kind: 'not_a_recipe' } : { kind: 'error', message: `${err.failure.code}: ${err.message}` };
    }
    outcomes.push(scorePage(page, got));
    calls.push(...store.aiCalls);
  }
  return { outcomes, calls };
}

function pct(n: number, total: number): string {
  return `${n}/${total} (${total === 0 ? 0 : Math.round((1000 * n) / total) / 10}%)`;
}

const ratio = (r: number | null) => (r === null ? '-' : `${Math.round(r * 100)}%`);

function amount(quantity: number | null, unit: string | null): string {
  const q = quantity === null ? '' : String(Math.round(quantity * 1000) / 1000);
  return [q, unit ?? ''].filter(Boolean).join(' ') || 'no amount';
}

function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => [...r[col]].length)));
  return rows.map((r) => `  ${r.map((cell, col) => cell + ' '.repeat(widths[col] - [...cell].length)).join('  ').trimEnd()}`);
}

/** Pure: the miss lines for one page, empty when it was all right. */
export function pageMisses(o: PageOutcome): string[] {
  const lines: string[] = [];
  if (o.got.kind === 'error') lines.push(`error: ${o.got.message}`);
  else if (!o.isRecipeOk) lines.push(`is_recipe: expected ${o.page.is_recipe}, got ${!o.page.is_recipe}`);
  if (o.nameOk === false && o.got.kind === 'recipe') {
    lines.push(`name: expected "${o.page.names[0]}", got "${o.got.name}"`);
  }
  for (const f of o.forbiddenFound) lines.push(`injection: "${f}" is in the result`);
  for (const e of o.missing) lines.push(`missing: ${e.name} (${amount(e.quantity, e.unit)})`);
  for (const g of o.extra) lines.push(`extra: ${g.displayName} (${amount(g.quantity, g.unit)})`);
  for (const m of o.matches) {
    if (m.unitOk && m.quantityOk) continue;
    const what = !m.unitOk && !m.quantityOk ? 'amount' : !m.unitOk ? 'unit' : 'quantity';
    lines.push(`${what}: ${m.got.displayName} expected ${amount(m.expected.quantity, m.expected.unit)}, got ${amount(m.got.quantity, m.got.unit)}`);
  }
  return lines;
}

/** Pure: the printed report. */
export function formatReport(report: EvalReport): string {
  const { outcomes } = report;
  const lines: string[] = [];
  const rows = [['page', 'is_recipe', 'name', 'precision', 'recall', 'unit', 'quantity']];
  for (const o of outcomes) {
    rows.push([
      o.page.file.replace(/\.html$/, ''),
      o.isRecipeOk ? 'ok' : 'MISS',
      o.nameOk === null ? '-' : o.nameOk ? 'ok' : 'MISS',
      ratio(o.precision),
      ratio(o.recall),
      o.matches.length === 0 ? '-' : `${o.matches.filter((m) => m.unitOk).length}/${o.matches.length}`,
      o.matches.length === 0 ? '-' : `${o.matches.filter((m) => m.quantityOk).length}/${o.matches.length}`,
    ]);
  }
  lines.push(...table(rows));
  lines.push('');

  const recipes = outcomes.filter((o) => o.page.is_recipe);
  const returned = outcomes.reduce((n, o) => n + o.matches.length + o.extra.length, 0);
  const matched = outcomes.reduce((n, o) => n + o.matches.length, 0);
  const required = outcomes.reduce((n, o) => n + o.page.ingredients.filter((e) => !e.optional).length, 0);
  const matchedRequired = outcomes.reduce((n, o) => n + o.matches.filter((m) => !m.expected.optional).length, 0);
  lines.push(`is_recipe:  ${pct(outcomes.filter((o) => o.isRecipeOk).length, outcomes.length)}`);
  lines.push(`name:       ${pct(recipes.filter((o) => o.nameOk).length, recipes.length)}`);
  lines.push(`precision:  ${pct(matched, returned)}`);
  lines.push(`recall:     ${pct(matchedRequired, required)}`);
  lines.push(`unit:       ${pct(outcomes.reduce((n, o) => n + o.matches.filter((m) => m.unitOk).length, 0), matched)}`);
  lines.push(`quantity:   ${pct(outcomes.reduce((n, o) => n + o.matches.filter((m) => m.quantityOk).length, 0), matched)}`);
  const injections = outcomes.filter((o) => o.page.file.startsWith('injection-'));
  if (injections.length > 0) {
    const held = injections.filter((o) => o.isRecipeOk && o.forbiddenFound.length === 0).length;
    lines.push(`injection:  ${pct(held, injections.length)} pages unaffected (is_recipe right, no forbidden text)`);
  }

  const missed = outcomes.map((o) => ({ o, misses: pageMisses(o) })).filter((m) => m.misses.length > 0);
  lines.push('');
  if (missed.length === 0) {
    lines.push('No misses.');
  } else {
    lines.push(`Misses (${missed.reduce((n, m) => n + m.misses.length, 0)}):`);
    for (const { o, misses } of missed) {
      lines.push(`  ${o.page.file}`);
      for (const miss of misses) lines.push(`    ${miss}`);
    }
  }
  lines.push('');
  lines.push(formatStats(report.calls));
  return lines.join('\n');
}

export type EvalIo = {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Returns expected.json's text. Defaults to the file next to this script. */
  readExpected?: () => Promise<string>;
  /** Returns a fixture's HTML. Defaults to the file in fixtures/. */
  readFixture?: (file: string) => Promise<string>;
  /** Reads an env var. Defaults to `Deno.env.get`. */
  env?: (key: string) => string | undefined;
};

/**
 * Runs the eval. Returns the exit code: 0 when it ran (whatever the score), 2 for bad usage, a bad
 * expected.json, a missing fixture, no model, or an unexpected error. `AI_MODEL_RECIPE` is set to
 * `--model` for the run and restored after.
 */
export async function run(argv: readonly string[], io: EvalIo): Promise<number> {
  let args: EvalArgs;
  let pages: ExpectedPage[];
  try {
    args = parseArgs(argv);
    if (args.help) {
      io.out(USAGE);
      return 0;
    }
    const text = await (io.readExpected ?? (() => Deno.readTextFile(new URL('./expected.json', import.meta.url))))();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new EvalUsageError('expected.json is not valid JSON');
    }
    pages = parseExpected(json);
  } catch (err) {
    if (!(err instanceof EvalUsageError)) throw err;
    io.err(`${err.message}\n\n${USAGE}`);
    return 2;
  }

  const env = io.env ?? ((key: string) => Deno.env.get(key));
  const model = args.model ?? env('AI_MODEL_RECIPE')?.trim();
  if (!model || model === AI_OFF) {
    io.err(`The eval needs a model, but AI_MODEL_RECIPE is ${model ? `'${AI_OFF}'` : 'not set'}. Set it in supabase/functions/.env or pass --model.`);
    return 2;
  }
  if (model === 'mock') io.err('Note: --model mock is the quantity-parser fake, not a real model; its score means nothing.');

  const readFixture = io.readFixture ?? ((file: string) => Deno.readTextFile(new URL(`./fixtures/${file}`, import.meta.url)));
  const saved = Deno.env.get('AI_MODEL_RECIPE');
  Deno.env.set('AI_MODEL_RECIPE', model);
  let report: EvalReport;
  try {
    report = await runEval(pages, readFixture);
  } catch (err) {
    io.err(`Eval failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    return 2;
  } finally {
    if (saved === undefined) Deno.env.delete('AI_MODEL_RECIPE');
    else Deno.env.set('AI_MODEL_RECIPE', saved);
  }

  io.out(`${pages.length} pages, model ${model}\n`);
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
