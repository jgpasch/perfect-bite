// categorize-ingredients (spec §6.1 step 5, §6.4): pure logic behind a store interface, so it
// runs in Deno tests with a fake store and MockLanguageModelV4. index.ts wires the real store.
import { normalizeIngredientName, OTHER_CATEGORY_ID, SYSTEM_CATEGORIES, type UnitKey } from '@shared/index.ts';
import { APICallError, NoObjectGeneratedError, RetryError, type LanguageModel } from 'ai';

import { buildCategorizePrompt } from '../_shared/ai/prompts/categorize.v2.ts';
import { runAiTask, type AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { isAiEnabled } from '../_shared/ai/tasks.ts';

/** Names per request (LLM boundaries: input). */
export const MAX_NAMES = 100;
/** Names per LLM call; a bigger batch is split. */
export const MAX_NAMES_PER_CALL = 100;
/** Longer normalized names are `failed` without reaching the LLM. */
export const MAX_NAME_LENGTH = 64;
/** A name that has failed this many times isn't sent again; it stays Other. */
export const MAX_ATTEMPTS = 3;

export type IngredientStatus = 'pending' | 'categorized' | 'failed';

export type IngredientRow = {
  normalized_name: string;
  status: IngredientStatus;
  default_category_id: string | null;
  is_grocery_item: boolean | null;
  /** A unit key (spec 4.2); null when unknown. */
  default_unit: string | null;
  attempts: number;
};

export type CategorizedAnswer = {
  normalized_name: string;
  default_category_id: string;
  is_grocery_item: boolean;
  default_unit: UnitKey;
};

/** The `ingredients` table as the function sees it. index.ts implements it with the service role. */
export interface CategorizeStore {
  getIngredients(names: readonly string[]): Promise<IngredientRow[]>;
  /** Inserts `pending` rows; `on conflict do nothing`. */
  insertPending(rows: readonly { normalized_name: string; display_name: string }[]): Promise<void>;
  /** Sets the category, default unit, `status = 'categorized'` and `categorized_by`, only `where status <> 'categorized'`. */
  saveCategorized(rows: readonly CategorizedAnswer[], categorizedBy: string): Promise<void>;
  /** Sets `status = 'failed'`, `attempts + 1` and category Other, only `where status <> 'categorized'`. */
  saveFailed(names: readonly string[]): Promise<void>;
  /** Writes one `ai_calls` row. */
  logAiCall(call: AiCallRecord): Promise<void>;
  /**
   * Counts this request against the rate limits (`public.check_categorize_limit`), given how many
   * names it would send to the LLM. Called once per request, before anything is written.
   */
  checkLimit(newNames: number): Promise<LimitResult>;
}

export type LimitResult = 'ok' | 'user_limit' | 'global_cap';

export type CategorizeResult = {
  status: IngredientStatus;
  category_id: string | null;
  is_grocery_item: boolean | null;
  /** A unit key; null when unknown. */
  default_unit: string | null;
};

export type CategorizeResponse = { results: Record<string, CategorizeResult> };

export class CategorizeInputError extends Error {
  override name = 'CategorizeInputError';
}

/** The request was refused by a rate limit; nothing was written and the names stay pending. */
export class CategorizeLimitError extends Error {
  override name = 'CategorizeLimitError';
  constructor(readonly reason: Exclude<LimitResult, 'ok'>) {
    super(`Rate limited: ${reason}`);
  }
}

const CATEGORY_ID_BY_SLUG = new Map<string, string>(SYSTEM_CATEGORIES.map((c) => [c.slug, c.id]));

const PENDING: CategorizeResult = { status: 'pending', category_id: null, is_grocery_item: null, default_unit: null };
const TOO_LONG: CategorizeResult = { status: 'failed', category_id: OTHER_CATEGORY_ID, is_grocery_item: null, default_unit: null };

/** A provider error or timeout isn't the names' fault: they stay pending and no attempt counts. */
function isProviderFailure(err: unknown): boolean {
  if (APICallError.isInstance(err) || RetryError.isInstance(err)) return true;
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Answers every input name from the database, sending only the uncategorized ones (with attempts
 * left) to the LLM in one call per 100 names. `model` is injected by tests; otherwise the task's
 * env model is used.
 */
export async function categorize(
  names: readonly string[],
  store: CategorizeStore,
  model?: { instance: LanguageModel; modelId: string },
): Promise<CategorizeResponse> {
  if (names.length > MAX_NAMES) throw new CategorizeInputError(`At most ${MAX_NAMES} names per request`);

  // Normalized name → display name (the first spelling seen). Names empty after normalizing are dropped.
  const inputs = new Map<string, string>();
  for (const raw of names) {
    const key = normalizeIngredientName(raw);
    if (key && !inputs.has(key)) inputs.set(key, raw.trim().replace(/\s+/g, ' '));
  }
  const tooLong = [...inputs.keys()].filter((n) => [...n].length > MAX_NAME_LENGTH);
  const keys = [...inputs.keys()].filter((n) => [...n].length <= MAX_NAME_LENGTH);

  const known = new Map((await store.getIngredients(keys)).map((r) => [r.normalized_name, r]));
  const toSend = keys.filter((n) => {
    const row = known.get(n);
    return !row || (row.status !== 'categorized' && row.attempts < MAX_ATTEMPTS);
  });
  const aiEnabled = isAiEnabled('categorize');

  // Every request counts; only names that will reach the LLM count as new. A refused request is
  // refused whole, before anything is written.
  const limit = await store.checkLimit(aiEnabled ? toSend.length : 0);
  if (limit !== 'ok') throw new CategorizeLimitError(limit);

  const missing = keys.filter((n) => !known.has(n));
  if (missing.length > 0) {
    await store.insertPending(missing.map((n) => ({ normalized_name: n, display_name: inputs.get(n)! })));
  }

  // Names that should have reached the LLM but didn't (kill switch, provider error): answered pending.
  const deferred = new Set<string>();
  if (!aiEnabled) {
    for (const n of toSend) deferred.add(n);
  } else {
    for (const batch of chunk(toSend, MAX_NAMES_PER_CALL)) {
      const outcome = await categorizeBatch(batch, store, model);
      if (outcome === 'deferred') for (const n of batch) deferred.add(n);
    }
  }

  // Answer from the database after writing, so a concurrent winner's result is what's returned.
  const rows = new Map((await store.getIngredients(keys)).map((r) => [r.normalized_name, r]));
  const results = new Map<string, CategorizeResult>();
  for (const n of keys) {
    const row = rows.get(n);
    if (!row || (deferred.has(n) && row.status !== 'categorized')) {
      results.set(n, PENDING);
    } else {
      results.set(n, {
        status: row.status,
        category_id: row.default_category_id,
        is_grocery_item: row.is_grocery_item,
        default_unit: row.default_unit,
      });
    }
  }
  for (const n of tooLong) results.set(n, TOO_LONG);
  return { results: Object.fromEntries(results) };
}

/** One LLM call. Bad output fails the names it covers; a provider failure defers the whole batch. */
async function categorizeBatch(
  batch: readonly string[],
  store: CategorizeStore,
  model: { instance: LanguageModel; modelId: string } | undefined,
): Promise<'done' | 'deferred'> {
  let result;
  try {
    result = await runAiTask(
      'categorize',
      { ...buildCategorizePrompt(batch), itemCount: batch.length },
      { model, onCall: (call) => store.logAiCall(call) },
    );
  } catch (err) {
    if (isProviderFailure(err)) return 'deferred';
    if (NoObjectGeneratedError.isInstance(err)) {
      await store.saveFailed(batch);
      return 'done';
    }
    throw err;
  }

  const sent = new Set(batch);
  const seen = new Set<string>();
  const answers = new Map<string, CategorizedAnswer>();
  // Never more answers than names sent; answers for names not sent are ignored; the first answer wins.
  for (const answer of result.output.results.slice(0, batch.length)) {
    if (!sent.has(answer.name) || seen.has(answer.name)) continue;
    seen.add(answer.name);
    const categoryId = CATEGORY_ID_BY_SLUG.get(answer.category);
    if (!categoryId) continue; // The schema allows only known slugs; this is a second guard.
    answers.set(answer.name, {
      normalized_name: answer.name,
      default_category_id: categoryId,
      is_grocery_item: answer.is_grocery_item,
      default_unit: answer.unit,
    });
  }
  if (answers.size > 0) await store.saveCategorized([...answers.values()], result.model);
  const unanswered = batch.filter((n) => !answers.has(n));
  if (unanswered.length > 0) await store.saveFailed(unanswered);
  return 'done';
}
