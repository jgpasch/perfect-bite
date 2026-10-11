// `yarn ai:check-seed`: runs every seed name (src/shared/seed/) through the function's own
// categorize(), in batches of 50 against the CLI's in-memory store, and saves each answer to
// eval/results/seed-check.json as it goes. The answers are real LLM output that cost tokens, so
// they live in the repo, not only in a database. Rerunning skips names already answered, so a run
// that times out or stops part way can simply be repeated. Then it writes
// eval/results/seed-check-disagreements.tsv: every name where the model's aisle, grocery flag or
// unit differs from the seed, for a person to review. Nothing changes the seed automatically.
import { normalizeIngredientName, seedEntries, SYSTEM_CATEGORIES, type SeedEntry } from '@shared/index.ts';

import { CATEGORIZE_PROMPT_VERSION } from '../../_shared/ai/prompts/categorize.v2.ts';
import { MemoryStore } from '../cli.ts';
import { categorize } from '../handler.ts';

/** Names per categorize() call; each batch is one LLM call. */
export const CHECK_BATCH_SIZE = 50;
/** Batches in flight at once. */
const CONCURRENCY = 4;

export type SeedAnswer = { category: string; is_grocery_item: boolean; unit: string | null };

export type SeedCheckFile = {
  model: string;
  prompt_version: string;
  /** Normalized name → the model's answer. */
  answers: Record<string, SeedAnswer>;
};

export type Disagreement = {
  name: string;
  seedCategory: string;
  seedUnit: string;
  answer: SeedAnswer;
  kinds: ('category' | 'not_grocery' | 'unit')[];
};

const SLUG_BY_ID = new Map<string, string>(SYSTEM_CATEGORIES.map((c) => [c.id, c.slug]));

/** Pure: where the model's answers differ from the seed. Names with no answer are left out. */
export function compareSeed(entries: readonly SeedEntry[], answers: Record<string, SeedAnswer>): Disagreement[] {
  const out: Disagreement[] = [];
  for (const e of entries) {
    const answer = answers[normalizeIngredientName(e.name)];
    if (!answer) continue;
    const kinds: Disagreement['kinds'] = [];
    if (answer.category !== e.category) kinds.push('category');
    if (!answer.is_grocery_item) kinds.push('not_grocery');
    if (answer.unit !== e.unit) kinds.push('unit');
    if (kinds.length) out.push({ name: e.name, seedCategory: e.category, seedUnit: e.unit, answer, kinds });
  }
  return out;
}

/** Pure: the disagreements as a TSV, aisle problems first. */
export function formatDisagreements(rows: readonly Disagreement[]): string {
  const rank = (d: Disagreement) => (d.kinds.includes('not_grocery') ? 0 : d.kinds.includes('category') ? 1 : 2);
  const sorted = [...rows].sort((a, b) => rank(a) - rank(b) || a.seedCategory.localeCompare(b.seedCategory) || a.name.localeCompare(b.name));
  const lines = ['name\tkinds\tseed category\tmodel category\tseed unit\tmodel unit\tmodel is_grocery_item'];
  for (const d of sorted) {
    lines.push([d.name, d.kinds.join(','), d.seedCategory, d.answer.category, d.seedUnit, d.answer.unit ?? '-', String(d.answer.is_grocery_item)].join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

async function main(out: (text: string) => void) {
  const model = Deno.env.get('AI_MODEL_CATEGORIZE')?.trim();
  if (!model || model === 'off' || model === 'mock') {
    console.error(`ai:check-seed needs a real model; AI_MODEL_CATEGORIZE is ${model ?? 'not set'}.`);
    Deno.exit(2);
  }
  const resultsDir = new URL('./results/', import.meta.url);
  const filePath = new URL('seed-check.json', resultsDir);
  let file: SeedCheckFile = { model, prompt_version: CATEGORIZE_PROMPT_VERSION, answers: {} };
  try {
    const saved = JSON.parse(await Deno.readTextFile(filePath)) as SeedCheckFile;
    if (saved.model === model && saved.prompt_version === CATEGORIZE_PROMPT_VERSION) file = saved;
    else console.error(`Saved answers are from ${saved.model} / ${saved.prompt_version}; starting over.`);
  } catch {
    // No saved answers yet.
  }

  const entries = seedEntries();
  const todo = [...new Set(entries.map((e) => normalizeIngredientName(e.name)))].filter((k) => !file.answers[k]);
  const batches: string[][] = [];
  for (let i = 0; i < todo.length; i += CHECK_BATCH_SIZE) batches.push(todo.slice(i, i + CHECK_BATCH_SIZE));
  console.error(`${entries.length} seed names, ${Object.keys(file.answers).length} already answered, ${batches.length} batches to send`);

  let done = 0;
  let missed = 0;
  let writing = Promise.resolve();
  const save = () => (writing = writing.then(() => Deno.writeTextFile(filePath, `${JSON.stringify(file, null, 1)}\n`)));
  async function worker() {
    while (batches.length) {
      const batch = batches.shift()!;
      const response = await categorize(batch, new MemoryStore());
      for (const key of batch) {
        const r = response.results[key];
        if (r?.status !== 'categorized' || !r.category_id) {
          missed++;
          continue;
        }
        file.answers[key] = { category: SLUG_BY_ID.get(r.category_id) ?? r.category_id, is_grocery_item: r.is_grocery_item ?? false, unit: r.default_unit };
      }
      await save();
      done++;
      console.error(`batch ${done}: ${Object.keys(file.answers).length} answered, ${missed} not answered so far`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await writing;

  const disagreements = compareSeed(entries, file.answers);
  await Deno.writeTextFile(new URL('seed-check-disagreements.tsv', resultsDir), formatDisagreements(disagreements));
  const count = (k: Disagreement['kinds'][number]) => disagreements.filter((d) => d.kinds.includes(k)).length;
  out(
    [
      `answered:      ${Object.keys(file.answers).length} names (${missed} not answered this run; rerun to retry them)`,
      `aisle differs: ${count('category')}`,
      `not grocery:   ${count('not_grocery')}`,
      `unit differs:  ${count('unit')}`,
      'Details: eval/results/seed-check-disagreements.tsv',
    ].join('\n'),
  );
}

if (import.meta.main) {
  // runAiTask logs a JSON line per call to stdout; keep stdout for the summary.
  const print = console.log;
  console.log = () => {};
  await main(print);
}
