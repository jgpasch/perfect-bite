// share-import-worker's committing phase, before the commit (spec 6.12, plan §5 Planning): where
// the share goes (`resolveTarget`, the device's `resolveImportTarget` rules), the snapshot of what
// the plan reads (`readSnapshot`, as the device's `addSnapshot`), and the plan itself
// (`planCommit`, the shared `planRecipeImport` with ids derived from the operation id). All of it
// reads through the service role outside any transaction; `commit_share_import` then checks the
// plan's preconditions and applies its writes in one. Pure logic behind a store interface, so it
// runs in Deno tests with fakes; store.ts has the real reads.
import {
  findReusableRecipe,
  IMPORT_ID_NAMESPACE,
  planRecipeImport,
  type IdSource,
  type ListSnapshot,
  type Precondition,
  type ReuseCandidate,
  type UnitKnowledge,
  type Write,
} from '@shared/domain/index.ts';
import { familyKey, RecipeImportResponseSchema, type RecipeImportResponse, type Unit } from '@shared/index.ts';

import type { ShareImportJob } from './handler.ts';

/** A list as the destination check reads it. */
export type ListRow = { id: string; householdId: string; archivedAt: string | null; deletedAt: string | null };

export type CatalogRow = { normalizedName: string; sameAs: string | null; defaultUnit: string | null };

/** A live item on the list. */
export type ItemRow = {
  id: string;
  ingredientName: string;
  displayName: string;
  checkedAt: string | null;
  checkedBy: string | null;
};

/** A live amount on an item. */
export type ContributionRow = {
  id: string;
  listItemId: string;
  source: 'manual' | 'recipe' | 'siri';
  quantity: number | null;
  unit: string | null;
};

export type UnitUsageDbRow = { ingredientName: string; unitKey: string; useCount: number; lastUsedAt: string };

/** `commit_share_import`'s `p_target`: the destination and the receipt's counts. */
export type CommitRequest = {
  household_id: string;
  list_id: string | null;
  list_gone: boolean;
  recipe_id: string;
  items_added: number;
  items_combined: number;
};

export type ShareImportReceipt = {
  recipe_id: string;
  applied_list_id: string | null;
  list_gone: boolean;
  items_added: number;
  items_combined: number;
  committed_at: string;
};

/** The commit found the plan stale (`plan_conflict`) or its destination gone (`destination_changed`). */
export class CommitConflictError extends Error {
  override name = 'CommitConflictError';
  constructor(readonly code: 'plan_conflict' | 'destination_changed') {
    super(code);
  }
}

/** The share can't be committed at all (the sharer left the household): a permanent failure. */
export class CommitRefusedError extends Error {
  override name = 'CommitRefusedError';
  constructor(readonly code: 'not_a_member') {
    super(code);
  }
}

/** What the committing phase reads, and the commit, over the service-role client. */
export interface ShareImportCommitStore {
  /** Whether the user is a member of the household (false when it's gone). */
  isMember(userId: string, householdId: string): Promise<boolean>;
  list(listId: string): Promise<ListRow | null>;
  /** `user_settings.default_list_id`. */
  defaultListId(userId: string): Promise<string | null>;
  /** The live, unarchived lists in the user's households, by position. */
  memberLists(userId: string): Promise<ListRow[]>;
  combineLanguages(householdId: string): Promise<boolean>;
  /** The catalog rows among `names`. */
  catalog(names: string[]): Promise<CatalogRow[]>;
  /** The list's live items (open or checked), oldest first. */
  liveItems(listId: string): Promise<ItemRow[]>;
  /** The items' live amounts, oldest first. */
  liveContributions(itemIds: string[]): Promise<ContributionRow[]>;
  unitUsage(householdId: string, names: string[]): Promise<UnitUsageDbRow[]>;
  /** Whether any recipe row, live or deleted, has this id. */
  recipeExists(id: string): Promise<boolean>;
  /**
   * The live recipe with `importRecipeId`, and the household's live recipes whose source URL may
   * canonicalize to `sourceUrl` (canonical; null for a photo, which gives only the first). A
   * superset: `findReusableRecipe` makes the exact match.
   */
  reuseCandidates(householdId: string, importRecipeId: string, sourceUrl: string | null): Promise<ReuseCandidate[]>;
  /**
   * `commit_share_import`. Throws CommitConflictError (40001), and LeaseLostError (handler.ts) for
   * a lease that isn't the job's.
   */
  commit(
    id: string,
    lease: string,
    target: CommitRequest,
    writes: Write[],
    preconditions: Precondition[],
  ): Promise<ShareImportReceipt>;
}

/** Where a share's recipe is saved, and the list its ingredients go on (null: recipe-only). */
export type CommitTarget = { householdId: string; listId: string | null; listGone: boolean };

const usable = (list: ListRow | null): list is ListRow => !!list && list.deletedAt === null && list.archivedAt === null;

/**
 * The share's destination (spec 4.10 Which list), as the device's `resolveImportTarget`: its list
 * if it's live, unarchived and in the share's household; else the user's default list; else their
 * first list (the share's household's first); with no lists at all, recipe-only into the share's
 * household with `listGone`. A recipe-only share stays recipe-only. A sharer no longer in the
 * share's household (or a household that's gone) is CommitRefusedError.
 */
export async function resolveTarget(job: ShareImportJob, store: ShareImportCommitStore): Promise<CommitTarget> {
  if (!(await store.isMember(job.user_id, job.household_id))) throw new CommitRefusedError('not_a_member');
  if (!job.add_to_list) return { householdId: job.household_id, listId: null, listGone: false };

  if (job.list_id) {
    const list = await store.list(job.list_id);
    if (usable(list) && list.householdId === job.household_id) {
      return { householdId: list.householdId, listId: list.id, listGone: false };
    }
  }
  const [lists, defaultId] = await Promise.all([store.memberLists(job.user_id), store.defaultListId(job.user_id)]);
  const fallback =
    lists.find((l) => l.id === defaultId) ?? lists.find((l) => l.householdId === job.household_id) ?? lists[0];
  return fallback
    ? { householdId: fallback.householdId, listId: fallback.id, listGone: false }
    : { householdId: job.household_id, listId: null, listGone: true };
}

/**
 * The snapshot the planner reads (plan §5 Planning step 2), as the device's `addSnapshot`: whether
 * the household combines languages, each name's family, the list's live items whose own or family
 * key is in the batch with their live amounts, and the unit knowledge (unit history and the
 * catalog's default unit) for the batch's names and those items'.
 */
export async function readSnapshot(
  store: ShareImportCommitStore,
  list: { id: string; householdId: string },
  names: readonly string[],
): Promise<{ snapshot: ListSnapshot; unitKnowledge: UnitKnowledge }> {
  const [combine, items] = await Promise.all([store.combineLanguages(list.householdId), store.liveItems(list.id)]);
  const catalog = new Map(
    (await store.catalog(unique([...names, ...items.map((i) => i.ingredientName)]))).map((c) => [c.normalizedName, c]),
  );
  const familyOf = (name: string) => (combine ? familyKey(name, catalog.get(name)?.sameAs) : name);
  const families = Object.fromEntries(names.map((n) => [n, familyOf(n)]));
  const keys = new Set([...names, ...Object.values(families)]);
  const matching = items
    .map((i) => ({ ...i, familyKey: familyOf(i.ingredientName) }))
    .filter((i) => keys.has(i.ingredientName) || keys.has(i.familyKey));

  const contributions = matching.length > 0 ? await store.liveContributions(matching.map((i) => i.id)) : [];
  const unitNames = unique([...names, ...matching.map((i) => i.ingredientName)]);
  const usage = await store.unitUsage(list.householdId, unitNames);

  const unitKnowledge: UnitKnowledge = {};
  for (const name of unitNames) {
    unitKnowledge[name] = {
      unitUsage: usage
        .filter((u) => u.ingredientName === name)
        .map((u) => ({ unitKey: u.unitKey, useCount: u.useCount, lastUsedAt: new Date(u.lastUsedAt) })),
      defaultUnit: catalog.get(name)?.defaultUnit ?? null,
    };
  }
  return {
    snapshot: {
      list,
      combineLanguages: combine,
      families,
      items: matching.map((i) => ({
        id: i.id,
        ingredientName: i.ingredientName,
        displayName: i.displayName,
        familyKey: i.familyKey,
        checkedAt: i.checkedAt === null ? null : new Date(i.checkedAt),
        checkedBy: i.checkedBy,
        liveContributions: contributions
          .filter((c) => c.listItemId === i.id)
          .map((c) => ({ id: c.id, source: c.source, quantity: c.quantity, unit: c.unit as Unit | null })),
      })),
    },
    unitKnowledge,
  };
}

/** The job's saved extraction; throws when it's missing or malformed. */
export function jobExtraction(job: ShareImportJob): RecipeImportResponse {
  return RecipeImportResponseSchema.parse(job.extraction);
}

export type CommitPlan = { request: CommitRequest; writes: Write[]; preconditions: Precondition[] };

/**
 * Plans the share's commit with the device's rules (`planRecipeImport`): the recipe it reuses
 * (`findReusableRecipe`: the one with id `uuidv5(op id)`, else a live one with the same canonical
 * URL in the household), or a new one with id `uuidv5(op id)` (`uuidv5(op id:recipe:0)` if a
 * deleted recipe has that id), then the ingredients onto the target list. Every other new row's id
 * is `uuidv5(op id:purpose:index)`, so a replan makes the same ids.
 */
export async function planCommit(
  job: ShareImportJob,
  extraction: RecipeImportResponse,
  target: CommitTarget,
  store: ShareImportCommitStore,
  at: Date,
): Promise<CommitPlan> {
  const own = await uuidV5(job.id, IMPORT_ID_NAMESPACE);
  const [ownTaken, candidates] = await Promise.all([
    store.recipeExists(own),
    store.reuseCandidates(target.householdId, own, extraction.sourceUrl),
  ]);
  const existing = findReusableRecipe(candidates, {
    householdId: target.householdId,
    sourceUrl: extraction.sourceUrl,
    importRecipeId: own,
  });

  const derived = new Map<string, string>();
  for (const purpose of ['contribution', 'item', 'recipeIngredient'] as const) {
    for (let index = 0; index < extraction.ingredients.length; index++) {
      derived.set(`${purpose}:${index}`, await uuidV5(`${job.id}:${purpose}:${index}`, IMPORT_ID_NAMESPACE));
    }
  }
  derived.set('recipe:0', ownTaken ? await uuidV5(`${job.id}:recipe:0`, IMPORT_ID_NAMESPACE) : own);
  const ids: IdSource = (purpose, index) => {
    const id = derived.get(`${purpose}:${index}`);
    if (!id) throw new Error(`No id for ${purpose} ${index}`);
    return id;
  };

  const forList = target.listId
    ? await readSnapshot(store, { id: target.listId, householdId: target.householdId }, extraction.ingredients.map((i) => i.ingredientName))
    : null;
  const plan = planRecipeImport({
    extracted: extraction,
    target: { householdId: target.householdId, listId: target.listId },
    existingRecipe: existing ?? null,
    listSnapshot: forList?.snapshot ?? null,
    unitKnowledge: forList?.unitKnowledge ?? {},
    ids,
    at,
    userId: job.user_id,
  });
  return {
    request: {
      household_id: target.householdId,
      list_id: target.listId,
      list_gone: target.listGone,
      recipe_id: plan.summary.recipeId,
      items_added: plan.summary.added,
      items_combined: plan.summary.combined,
    },
    writes: plan.writes,
    preconditions: plan.preconditions,
  };
}

/** A name-based UUID (RFC 4122 version 5, SHA-1), as the `uuid` package's `v5` the app uses. */
export async function uuidV5(name: string, namespace: string): Promise<string> {
  const hex = namespace.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`Invalid namespace ${namespace}`);
  const nameBytes = new TextEncoder().encode(name);
  const data = new Uint8Array(16 + nameBytes.length);
  for (let i = 0; i < 16; i++) data[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  data.set(nameBytes, 16);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', data)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const out = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
