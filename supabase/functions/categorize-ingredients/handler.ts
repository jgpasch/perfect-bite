// categorize-ingredients (spec §6.1 step 5, §6.4): pure logic behind a store interface, so it
// runs in Deno tests with a fake store and MockLanguageModelV4. index.ts wires the real store.
import { normalizeIngredientName, OTHER_CATEGORY_ID, SYSTEM_CATEGORIES, type UnitKey } from '@shared/index.ts';
import { APICallError, NoObjectGeneratedError, RetryError, type LanguageModel } from 'ai';

import { buildCategorizePrompt } from '../_shared/ai/prompts/categorize.v3.ts';
import { runAiTask, type AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { isAiEnabled, type CategorizeOutput } from '../_shared/ai/tasks.ts';
import type { Feature } from '../_shared/entitlements.ts';

/** Names per request (LLM boundaries: input). */
export const MAX_NAMES = 100;
/** Names per LLM call; a bigger batch is split. */
export const MAX_NAMES_PER_CALL = 100;
/** Longer normalized names are `failed` without reaching the LLM. */
export const MAX_NAME_LENGTH = 64;
/** A name that has failed this many times isn't sent again; it stays Other. */
export const MAX_ATTEMPTS = 3;

export type IngredientStatus = 'pending' | 'categorized' | 'failed';

/** A stored language (spec 4.15); the model's `other` is stored as null. */
export type IngredientLang = 'en' | 'es';

export type IngredientRow = {
  normalized_name: string;
  display_name: string;
  status: IngredientStatus;
  default_category_id: string | null;
  is_grocery_item: boolean | null;
  /** A unit key (spec 4.2); null when unknown. */
  default_unit: string | null;
  attempts: number;
  lang: IngredientLang | null;
  /** The English ingredient this name means (spec 4.15); one level only. */
  same_as: string | null;
  /** `seed`, a model id or `admin`; null without a link. */
  linked_by: string | null;
};

export type CategorizedAnswer = {
  normalized_name: string;
  default_category_id: string;
  is_grocery_item: boolean;
  default_unit: UnitKey;
  /** Written only when not null, so a known language is never cleared. */
  lang: IngredientLang | null;
};

/** A translation's own row (spec 4.15): the name's category, unit and grocery flag. */
export type TwinRow = {
  normalized_name: string;
  display_name: string;
  lang: IngredientLang;
  default_category_id: string;
  is_grocery_item: boolean;
  default_unit: UnitKey;
};

/** The `ingredients` table as the function sees it. index.ts implements it with the service role. */
export interface CategorizeStore {
  getIngredients(names: readonly string[]): Promise<IngredientRow[]>;
  /** Inserts `pending` rows; `on conflict do nothing`. */
  insertPending(rows: readonly { normalized_name: string; display_name: string }[]): Promise<void>;
  /**
   * Sets the category, default unit, `status = 'categorized'`, `categorized_by` and (when not null)
   * `lang`, only `where status <> 'categorized'`.
   */
  saveCategorized(rows: readonly CategorizedAnswer[], categorizedBy: string): Promise<void>;
  /** Sets `status = 'failed'`, `attempts + 1` and category Other, only `where status <> 'categorized'`. */
  saveFailed(names: readonly string[]): Promise<void>;
  /**
   * Inserts `categorized` twin rows with `categorized_by` and `household_count = 0` (spec 6.5 keeps
   * them out of other households' autocomplete); `on conflict do nothing`.
   */
  insertTwins(rows: readonly TwinRow[], categorizedBy: string): Promise<void>;
  /** The names among `names` that another ingredient's `same_as` points at. */
  getLinkTargets(names: readonly string[]): Promise<string[]>;
  /**
   * Sets `name`'s `same_as` to `target` and `linked_by`, only `where same_as is null`. False when
   * nothing was linked: a link appeared meanwhile, or the one-level rule refused it.
   */
  link(name: string, target: string, linkedBy: string): Promise<boolean>;
  /** Writes one `ai_calls` row. */
  logAiCall(call: AiCallRecord): Promise<void>;
  /**
   * Counts this request against the rate limits (`public.check_categorize_limit`), given how many
   * names it would send to the LLM. Called once per request, before anything is written.
   */
  checkLimit(newNames: number): Promise<LimitResult>;
  /**
   * Throws NotEntitledError unless the caller's plan has `feature` (`requireFeature` in
   * `_shared/entitlements.ts`). Called first, before the rate limit or any database or LLM work.
   */
  requireFeature(feature: Feature): Promise<void>;
}

export type LimitResult = 'ok' | 'user_limit';

export type CategorizeResult = {
  status: IngredientStatus;
  category_id: string | null;
  is_grocery_item: boolean | null;
  /** A unit key; null when unknown. */
  default_unit: string | null;
  /** The name's language (spec 4.15); null when not known. */
  lang: IngredientLang | null;
  /** The English ingredient this name is linked to; null without a link. */
  same_as: string | null;
  linked_by: string | null;
};

/** A twin this request linked (creating it or not), with the display name a device needs to add it. */
export type TwinResult = CategorizeResult & { display_name: string };

export type CategorizeResponse = {
  results: Record<string, CategorizeResult>;
  /**
   * Translations' rows this request linked (spec 4.15), by key; never an input name.
   * Absent when there are none.
   */
  twins?: Record<string, TwinResult>;
};

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

const NO_LINK = { lang: null, same_as: null, linked_by: null } as const;
const PENDING: CategorizeResult = { status: 'pending', category_id: null, is_grocery_item: null, default_unit: null, ...NO_LINK };
const TOO_LONG: CategorizeResult = { status: 'failed', category_id: OTHER_CATEGORY_ID, is_grocery_item: null, default_unit: null, ...NO_LINK };

/** A provider error or timeout isn't the names' fault: they stay pending and no attempt counts. */
export function isProviderFailure(err: unknown): boolean {
  if (APICallError.isInstance(err) || RetryError.isInstance(err)) return true;
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function toResult(row: IngredientRow): CategorizeResult {
  return {
    status: row.status,
    category_id: row.default_category_id,
    is_grocery_item: row.is_grocery_item,
    default_unit: row.default_unit,
    lang: row.lang,
    same_as: row.same_as,
    linked_by: row.linked_by,
  };
}

/**
 * Answers every input name from the database, sending only the uncategorized ones (with attempts
 * left) to the LLM in one call per 100 names. `model` is injected by tests; otherwise the task's
 * env model is used. Throws NotEntitledError, before any other work, without `categorize`.
 */
export async function categorize(
  names: readonly string[],
  store: CategorizeStore,
  model?: { instance: LanguageModel; modelId: string },
): Promise<CategorizeResponse> {
  await store.requireFeature('categorize');
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
  // Translations' rows linked on the way (spec 4.15).
  const twinKeys = new Set<string>();
  if (!aiEnabled) {
    for (const n of toSend) deferred.add(n);
  } else {
    for (const batch of chunk(toSend, MAX_NAMES_PER_CALL)) {
      const outcome = await categorizeBatch(batch, store, model);
      if (outcome === 'deferred') for (const n of batch) deferred.add(n);
      else for (const t of outcome.twins) twinKeys.add(t);
    }
  }

  // Answer from the database after writing, so a concurrent winner's result is what's returned.
  const rows = new Map((await store.getIngredients(keys)).map((r) => [r.normalized_name, r]));
  const results = new Map<string, CategorizeResult>();
  for (const n of keys) {
    const row = rows.get(n);
    results.set(n, !row || (deferred.has(n) && row.status !== 'categorized') ? PENDING : toResult(row));
  }
  for (const n of tooLong) results.set(n, TOO_LONG);

  const twinNames = [...twinKeys].filter((n) => !inputs.has(n));
  if (twinNames.length === 0) return { results: Object.fromEntries(results) };
  const twins = (await store.getIngredients(twinNames)).map((r) => [r.normalized_name, { ...toResult(r), display_name: r.display_name }]);
  return { results: Object.fromEntries(results), twins: Object.fromEntries(twins) };
}

/** One LLM call. Bad output fails the names it covers; a provider failure defers the whole batch. */
async function categorizeBatch(
  batch: readonly string[],
  store: CategorizeStore,
  model: { instance: LanguageModel; modelId: string } | undefined,
): Promise<{ twins: string[] } | 'deferred'> {
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
      return { twins: [] };
    }
    throw err;
  }

  const sent = new Set(batch);
  const seen = new Set<string>();
  const answers = new Map<string, CategorizedAnswer>();
  const translated: { answer: CategorizedAnswer; raw: Answer }[] = [];
  // Never more answers than names sent; answers for names not sent are ignored; the first answer wins.
  for (const raw of result.output.results.slice(0, batch.length)) {
    if (!sent.has(raw.name) || seen.has(raw.name)) continue;
    seen.add(raw.name);
    const categoryId = CATEGORY_ID_BY_SLUG.get(raw.category);
    if (!categoryId) continue; // The schema allows only known slugs; this is a second guard.
    const answer: CategorizedAnswer = {
      normalized_name: raw.name,
      default_category_id: categoryId,
      is_grocery_item: raw.is_grocery_item,
      default_unit: raw.unit,
      lang: raw.lang === 'other' ? null : raw.lang,
    };
    answers.set(raw.name, answer);
    translated.push({ answer, raw });
  }
  if (answers.size > 0) await store.saveCategorized([...answers.values()], result.model);
  const unanswered = batch.filter((n) => !answers.has(n));
  if (unanswered.length > 0) await store.saveFailed(unanswered);

  // After the batch's own rows are saved, so a twin that is also in the batch is found, not made.
  const twins: string[] = [];
  for (const { answer, raw } of translated) {
    const twin = await saveTwin(answer, raw, store, result.model);
    if (twin) twins.push(twin);
  }
  return { twins };
}

type Answer = CategorizeOutput['results'][number];

/** The longest translation stored, like a name (LLM boundaries: output). */
export const MAX_TRANSLATION_LENGTH = MAX_NAME_LENGTH;

/** Letters (any script, with their accents), spaces, hyphens and apostrophes. No tabs or newlines. */
const TRANSLATION_CHARS = /^[\p{L}\p{M}' \-’]+$/u;

/**
 * The model's translation of `nameKey`, checked before it's stored (spec 6.4: output): trimmed,
 * runs of spaces collapsed, at most 64 characters before and after normalizing, only letters,
 * spaces, hyphens and apostrophes, and a key that's neither empty nor the name's own. Null otherwise.
 */
export function cleanTranslation(raw: string | null, nameKey: string): { key: string; display: string } | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!TRANSLATION_CHARS.test(trimmed)) return null;
  const display = trimmed.replace(/ +/g, ' ');
  if ([...display].length > MAX_TRANSLATION_LENGTH) return null;
  const key = normalizeIngredientName(display);
  if (key === '' || key === nameKey || [...key].length > MAX_TRANSLATION_LENGTH) return null;
  return { key, display };
}

/**
 * Links one answer to its translation's row (spec 4.15): the non-English row's `same_as` is the
 * English one. A model-made twin is always a link, so only an exact equivalent that can be linked
 * makes or touches a row: a twin is created (with the name's category, unit and grocery flag) just
 * before it's linked, and one that exists keeps its own and is only linked. Nothing is created or
 * linked when either side already has a link (a seed link always wins), when the non-English side
 * is already a link's target, or when an existing twin's language isn't the one expected. A link
 * the database still refuses (a concurrent link) leaves the new twin unlinked, for
 * `yarn ai:prune-twins`. Only English and Spanish names of grocery items get a twin: an errand or
 * an injection name can't write another key's row. Returns the twin's key when it was linked.
 */
async function saveTwin(answer: CategorizedAnswer, raw: Answer, store: CategorizeStore, modelId: string): Promise<string | null> {
  if (answer.lang === null || !answer.is_grocery_item || !raw.exact_equivalent) return null;
  const translation = cleanTranslation(raw.translation, answer.normalized_name);
  if (!translation) return null;
  const twinLang: IngredientLang = answer.lang === 'en' ? 'es' : 'en';

  const [name] = await store.getIngredients([answer.normalized_name]);
  let [twin] = await store.getIngredients([translation.key]);
  if (!name || name.same_as !== null) return null;
  if (twin && (twin.same_as !== null || (twin.lang !== null && twin.lang !== twinLang))) return null;
  const [source, target] = answer.lang === 'en' ? [translation.key, name.normalized_name] : [name.normalized_name, translation.key];
  if ((await store.getLinkTargets([source])).length > 0) return null;

  if (!twin) {
    await store.insertTwins(
      [
        {
          normalized_name: translation.key,
          display_name: translation.display,
          lang: twinLang,
          default_category_id: answer.default_category_id,
          is_grocery_item: answer.is_grocery_item,
          default_unit: answer.default_unit,
        },
      ],
      modelId,
    );
    [twin] = await store.getIngredients([translation.key]);
  }
  if (!twin) return null;
  return (await store.link(source, target, modelId)) ? twin.normalized_name : null;
}
