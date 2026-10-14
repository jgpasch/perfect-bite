// `yarn ai:eval`: the golden-set eval (spec §6.4). Runs every name in golden.json through the
// function's own categorize(), with the same runAiTask, prompt and validation, against the CLI's
// in-memory store, in batches of 50 so each batch is one LLM call. Prints the accuracy, the
// default-unit score, the language, translation and link scores (spec 4.15; a wrong link costs
// more than a missing one), and every miss. Run it whenever the model or the prompt changes; it
// costs real tokens, so it isn't part of CI or `deno test`.
import { normalizeIngredientName, SYSTEM_CATEGORIES, UNIT_KEYS, type CategorySlug } from '@shared/index.ts';
import { z } from 'zod';

import type { AiCallRecord } from '../../_shared/ai/run-ai-task.ts';
import { AI_OFF, CATEGORIZE_LANGS, type CategorizeOutput } from '../../_shared/ai/tasks.ts';
import { formatStats, MemoryStore } from '../cli.ts';
import { categorize, cleanTranslation, MAX_NAME_LENGTH, type CategorizeResponse, type CategorizeResult } from '../handler.ts';

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
  /** Default units a shopper would accept (spec 4.2), most usual first. Unscored when absent. */
  units: z.array(z.enum(UNIT_KEYS)).min(1).optional(),
  /** A prompt-injection attempt: expected other/false, and the rest of its batch must still be right. */
  injection: z.boolean().optional(),
  /** The name's language (spec 4.15). Unscored when absent. */
  lang: z.enum(CATEGORIZE_LANGS).optional(),
  /**
   * Translations a shopper would accept, compared by key; a `null` in the list (or `null` for the
   * whole) means no translation is right too. Unscored when absent.
   */
  translation: z.array(z.string().min(1).nullable()).min(1).nullable().optional(),
  /** Whether the name should be linked to its translation (spec 4.15). Links are unscored when absent. */
  exact_equivalent: z.boolean().optional(),
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
    if (c.exact_equivalent && acceptedTranslations(c).every((t) => t === null)) {
      throw new EvalUsageError(`golden.json: "${c.name}" expects a link but lists no translation to link to`);
    }
  }
  return parsed.data.cases;
}

/** A case's accepted translations as keys; `null` where no translation is accepted. */
export function acceptedTranslations(c: GoldenCase): (string | null)[] {
  return (c.translation ?? [null]).map((t) => (t === null ? null : normalizeIngredientName(t)));
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
  /** The returned default unit, or null when none came back. */
  unit: string | null;
  /** The unit is one of `units` and categorized; null when the case has no `units`. Not part of `correct`. */
  unitOk: boolean | null;
  /** The model's language for the name; null when it gave no answer. */
  lang: string | null;
  /** The language is the case's; null when the case has no `lang`. Not part of `correct`. */
  langOk: boolean | null;
  /** The model's translation as written; null when none. */
  translation: string | null;
  /** The translation, as the server would keep it, is one the case accepts; null when unscored. */
  translationOk: boolean | null;
  /** The key the name was linked with (either direction); null when unlinked. */
  linkedTo: string | null;
  /**
   * `right`: linked to an accepted translation when the case expects a link, else unlinked.
   * `missing`: a link was expected and none made. `wrong`: a link the case doesn't expect. Null
   * when the case has no `exact_equivalent`.
   */
  link: 'right' | 'missing' | 'wrong' | null;
};

/** What the model said about a name's language, from the call's output. */
export type LanguageAnswer = { lang: string; translation: string | null };

/** Pure: one golden case against what categorize() returned for it and the model's language answer. */
export function scoreCase(
  c: GoldenCase,
  result: CategorizeResult | undefined,
  batch: number,
  language: { answer?: LanguageAnswer | null; linkedTo?: string | null } = {},
): CaseOutcome {
  const slug = result?.category_id ? (SLUG_BY_ID.get(result.category_id) ?? result.category_id) : null;
  const status = result?.status ?? 'missing';
  const categoryOk = slug !== null && (slug === c.category || (c.also ?? []).includes(slug as CategorySlug));
  const groceryOk = result?.is_grocery_item === c.is_grocery_item;
  const unit = result?.default_unit ?? null;
  const answer = language.answer ?? null;
  const linkedTo = language.linkedTo ?? null;
  const accepted = acceptedTranslations(c);
  const kept = answer ? (cleanTranslation(answer.translation, normalizeIngredientName(c.name))?.key ?? null) : null;
  let link: CaseOutcome['link'] = null;
  if (c.exact_equivalent !== undefined) {
    if (linkedTo === null) link = c.exact_equivalent ? 'missing' : 'right';
    else link = c.exact_equivalent && accepted.includes(linkedTo) ? 'right' : 'wrong';
  }
  return {
    case: c,
    batch,
    slug,
    isGroceryItem: result?.is_grocery_item ?? null,
    status,
    categoryOk,
    groceryOk,
    correct: status === 'categorized' && categoryOk && groceryOk,
    unit,
    unitOk: c.units ? status === 'categorized' && unit !== null && (c.units as string[]).includes(unit) : null,
    lang: answer?.lang ?? null,
    langOk: c.lang ? answer?.lang === c.lang : null,
    translation: answer?.translation ?? null,
    translationOk: c.translation === undefined ? null : answer !== null && accepted.includes(kept),
    linkedTo,
    link,
  };
}

export type EvalReport = { outcomes: CaseOutcome[]; calls: AiCallRecord[] };

/** Pure: each name's first answer in the batch's successful calls, by name as sent. */
export function languageAnswers(calls: readonly AiCallRecord[]): Map<string, LanguageAnswer> {
  const answers = new Map<string, LanguageAnswer>();
  for (const call of calls) {
    if (call.status !== 'ok') continue;
    for (const a of (call.output as CategorizeOutput).results) {
      if (!answers.has(a.name)) answers.set(a.name, { lang: a.lang, translation: a.translation });
    }
  }
  return answers;
}

/** Pure: the key `key` was linked with: its own `same_as`, else a row in the response linking to it. */
export function linkedWith(key: string, response: CategorizeResponse): string | null {
  const own = response.results[key]?.same_as;
  if (own) return own;
  const rows = [...Object.entries(response.results), ...Object.entries(response.twins ?? {})];
  return rows.find(([name, r]) => name !== key && r.same_as === key)?.[0] ?? null;
}

/** Runs every case through categorize(), one fresh in-memory store per batch, in file order. */
export async function runEval(cases: readonly GoldenCase[], batchSize = EVAL_BATCH_SIZE): Promise<EvalReport> {
  const outcomes: CaseOutcome[] = [];
  const calls: AiCallRecord[] = [];
  for (let i = 0; i < cases.length; i += batchSize) {
    const batch = cases.slice(i, i + batchSize);
    const store = new MemoryStore();
    const response = await categorize(batch.map((c) => c.name), store);
    const answers = languageAnswers(store.aiCalls);
    for (const c of batch) {
      const key = normalizeIngredientName(c.name);
      outcomes.push(
        scoreCase(c, response.results[key], i / batchSize + 1, { answer: answers.get(key) ?? null, linkedTo: linkedWith(key, response) }),
      );
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
  const scoredUnits = outcomes.filter((o) => o.unitOk !== null);
  if (scoredUnits.length > 0) {
    lines.push(`unit:            ${pct(scoredUnits.filter((o) => o.unitOk).length, scoredUnits.length)}`);
  }
  const scoredLangs = outcomes.filter((o) => o.langOk !== null);
  if (scoredLangs.length > 0) {
    lines.push(`lang:            ${pct(scoredLangs.filter((o) => o.langOk).length, scoredLangs.length)}`);
  }
  const scoredTranslations = outcomes.filter((o) => o.translationOk !== null);
  if (scoredTranslations.length > 0) {
    lines.push(`translation:     ${pct(scoredTranslations.filter((o) => o.translationOk).length, scoredTranslations.length)}`);
  }
  const scoredLinks = outcomes.filter((o) => o.link !== null);
  if (scoredLinks.length > 0) {
    const count = (link: CaseOutcome['link']) => scoredLinks.filter((o) => o.link === link).length;
    lines.push(`links:           ${pct(count('right'), scoredLinks.length)} right, ${count('missing')} missing, ${count('wrong')} wrong`);
    lines.push(`link score:      ${linkScore(scoredLinks)}/${scoredLinks.length} (right +1, missing 0, wrong -${WRONG_LINK_COST})`);
  }

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
  // Unit misses on names that were otherwise right; the misses above already show the rest.
  const unitMisses = outcomes.filter((o) => o.correct && o.unitOk === false);
  if (unitMisses.length > 0) {
    lines.push('');
    lines.push(`Unit misses (${unitMisses.length}):`);
    const rows = [['name', 'expected', 'got'], ...unitMisses.map((o) => [o.case.name, o.case.units!.join(' or '), o.unit ?? '-'])];
    const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => [...r[col]].length)));
    for (const r of rows) {
      lines.push(`  ${r.map((cell, col) => cell + ' '.repeat(widths[col] - [...cell].length)).join('  ').trimEnd()}`);
    }
  }
  // Translation and link misses, whatever the category said.
  const languageMisses = outcomes.filter((o) => o.translationOk === false || o.link === 'missing' || o.link === 'wrong');
  if (languageMisses.length > 0) {
    lines.push('');
    lines.push(`Translation and link misses (${languageMisses.length}):`);
    const rows = [['name', 'expected', 'got', ''], ...languageMisses.map((o) => [
      o.case.name,
      describeExpectedTranslation(o.case),
      `${o.translation ?? 'none'}${o.linkedTo ? `, linked to ${o.linkedTo}` : ''}`,
      o.link === 'wrong' ? 'WRONG LINK' : o.link === 'missing' ? 'missing link' : '',
    ])];
    lines.push(...alignRows(rows));
  }
  lines.push('');
  lines.push(formatStats(report.calls));
  return lines.join('\n');
}

/** A wrong link merges two different things on a list; a missing one only leaves two items apart. */
export const WRONG_LINK_COST = 2;

/** Right links (or right non-links) count 1, missing 0, wrong `-WRONG_LINK_COST`. */
export function linkScore(outcomes: readonly CaseOutcome[]): number {
  return outcomes.reduce((n, o) => n + (o.link === 'right' ? 1 : o.link === 'wrong' ? -WRONG_LINK_COST : 0), 0);
}

function describeExpectedTranslation(c: GoldenCase): string {
  const translations = c.translation === undefined ? '-' : (c.translation ?? [null]).map((t) => t ?? 'none').join(' or ');
  const link = c.exact_equivalent === undefined ? '' : c.exact_equivalent ? ', linked' : ', not linked';
  return `${translations}${link}`;
}

function alignRows(rows: string[][]): string[] {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => [...r[col]].length)));
  return rows.map((r) => `  ${r.map((cell, col) => cell + ' '.repeat(widths[col] - [...cell].length)).join('  ').trimEnd()}`);
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
