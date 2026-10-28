// share-import-worker (spec 6.12, plan §4): imports shared recipes on the server. Each run claims
// due `share_imports` jobs one at a time until none is due or about 50 s have passed, and runs the
// job's phase under its lease. Extracting: the plan check, the charge (`reserve_share_import`, once
// per operation), the extraction (`extractForImport`, import-recipe's second half, with the captured
// page; for a photo share, its pages from share-images through `extractRecipePhotoForImport`) and
// `save_share_extraction`. Committing: the destination, a snapshot and the plan (commit.ts; a photo
// share's pages copied to recipe-pages for `source_pages`), then `commit_share_import`, planned
// again on a conflict. A failure is released as transient, waiting or permanent. Every store call is one short transaction of its own, so none is
// open during the fetch or the model call. Pure logic behind store interfaces, so it runs in Deno
// tests with fakes; index.ts wires the real stores.
import { IMPORT_ID_NAMESPACE, type Write } from '@shared/domain/index.ts';
import {
  canonicalRecipeUrl,
  RecipeImportPageSchema,
  type RecipeImportPage,
  type RecipeImportResponse,
  type RecipePhoto,
} from '@shared/index.ts';

import { isAiEnabled } from '../_shared/ai/tasks.ts';
import { NotEntitledError } from '../_shared/entitlements.ts';
import { dailyResetsAt, monthlyResetsAt } from '../_shared/limits.ts';
import { asError, reportError } from '../_shared/sentry.ts';
import type { LimitResult } from '../categorize-ingredients/handler.ts';
import { extractForImport, ImportRecipeError, type ImportDeps } from '../import-recipe/handler.ts';
import { extractRecipePhotoForImport, ImportRecipePhotoError } from '../import-recipe-photo/handler.ts';
import {
  CommitConflictError,
  CommitRefusedError,
  jobExtraction,
  planCommit,
  resolveTarget,
  uuidV5,
  type CommitPlan,
  type CommitTarget,
  type ShareImportCommitStore,
} from './commit.ts';

/** The phases a job is claimed for. */
export type JobKind = 'extracting' | 'committing';

/** A claimed `share_imports` row, as far as the worker reads it. */
export type ShareImportJob = {
  id: string;
  user_id: string;
  household_id: string;
  /** The list the share asked for (null: the default list), when `add_to_list`. */
  list_id: string | null;
  add_to_list: boolean;
  /** `link`: a URL (and maybe a captured page); `photo`: 1 to 3 pages in share-images. */
  kind: 'link' | 'photo';
  /** A link's URL; null for a photo. */
  url: string | null;
  /** A photo's share-images object paths in page order; null for a link, or once they're deleted. */
  images: string[] | null;
  /** The Safari capture; null when there was none or retention purged it (the server fetches). */
  page: unknown;
  /** The saved RecipeImportResponse, once extracted. */
  extraction: unknown;
  status: JobKind;
  lease_token: string;
  attempts: number;
};

/** How a phase failed: `release_share_import`'s kind and code, and `resets_at` for the limits. */
export type Release = {
  kind: 'transient' | 'waiting' | 'permanent';
  code: string;
  resetsAt?: string | null;
};

/** The job's lease isn't this worker's any more (`lease_lost`, 55000): it stops touching the job. */
export class LeaseLostError extends Error {
  override name = 'LeaseLostError';
  constructor() {
    super('lease_lost');
  }
}

/** The share-import RPCs, over the service-role client in store.ts and fakes in tests. */
export interface ShareImportWorkerStore {
  /** `claim_share_import(p_kinds)`: the oldest due job, leased to this run; null when none is due. */
  claim(kinds: JobKind[]): Promise<ShareImportJob | null>;
  /** `reserve_share_import`: charges the import once per operation. Throws LeaseLostError. */
  reserve(id: string, lease: string): Promise<LimitResult>;
  /** `save_share_extraction`: only under a matching, unexpired lease. Throws LeaseLostError. */
  saveExtraction(id: string, lease: string, extraction: RecipeImportResponse): Promise<void>;
  /** `release_share_import`; returns the job's new status. Throws LeaseLostError. */
  release(id: string, lease: string, release: Release): Promise<string>;
  /** `queue_recipe_page_prefix_deletion`: photo-cleanup deletes the recipe-pages objects under it. */
  queueRecipePageDeletion(prefix: string): Promise<void>;
}

/** A photo share's pages: read from share-images, copied to recipe-pages. */
export interface SharePageStorage {
  /** A share-images object's bytes; null when it isn't there. */
  downloadShareImage(path: string): Promise<Uint8Array | null>;
  /** Writes a recipe-pages object, replacing one already at `path`. */
  uploadRecipePage(path: string, bytes: Uint8Array): Promise<void>;
}

/** A photo share's pages are gone from share-images (spec 6.12): a permanent `invalid_request`. */
export class ShareImagesMissingError extends Error {
  override name = 'ShareImagesMissingError';
  constructor() {
    super("The share's images are gone");
  }
}

export type WorkerDeps = {
  store: ShareImportWorkerStore;
  /** The committing phase's reads and `commit_share_import`. */
  commitStore: ShareImportCommitStore;
  /** A photo share's pages. */
  pages: SharePageStorage;
  /** The phases this run claims; defaults to both. */
  kinds?: JobKind[];
  /**
   * import-recipe's deps for one job: its store and categorize bound to the sharer, and the sharer
   * as the `ai_calls` caller. A photo share's extraction uses them too (its store only logs).
   */
  importDeps: (job: ShareImportJob) => ImportDeps;
  now?: () => number;
  /** How long a run keeps claiming; defaults to RUN_BUDGET_MS. */
  budgetMs?: number;
};

/** A run stops claiming after this long, inside the 60 s between cron calls (spec 6.12). */
export const RUN_BUDGET_MS = 50_000;

/**
 * How many times a commit is planned again after `plan_conflict` or `destination_changed` before
 * the job is released as transient (spec 6.12).
 */
export const MAX_REPLANS = 3;

export type RunResult = {
  claimed: number;
  extracted: number;
  committed: number;
  transient: number;
  waiting: number;
  permanent: number;
  leaseLost: number;
};

/** Failures that end the share at once (spec 6.12 Errors). */
const PERMANENT = new Set(['not_a_recipe', 'invalid_url', 'not_entitled', 'daily_limit', 'limit_reached', 'invalid_request']);

/**
 * How a phase's error is released: limits and the expected import failures by their code, and
 * anything unexpected (network, a database error, a bug) as transient `internal`, reported.
 */
export function releaseFor(err: unknown, now: number): Release {
  if (err instanceof NotEntitledError) return { kind: 'permanent', code: 'not_entitled' };
  if (err instanceof ShareImagesMissingError) return { kind: 'permanent', code: 'invalid_request' };
  if (err instanceof CommitRefusedError) return { kind: 'permanent', code: err.code };
  if (err instanceof CommitConflictError) return { kind: 'transient', code: err.code };
  if (err instanceof ImportRecipeError || err instanceof ImportRecipePhotoError) {
    const code = err.failure.code;
    if (code === 'rate_limited') return { kind: 'waiting', code };
    if (code === 'daily_limit') return { kind: 'permanent', code, resetsAt: dailyResetsAt(now) };
    if (code === 'limit_reached') return { kind: 'permanent', code, resetsAt: monthlyResetsAt(now) };
    return { kind: PERMANENT.has(code) ? 'permanent' : 'transient', code };
  }
  return { kind: 'transient', code: 'internal' };
}

/** The limit's answer as import-recipe's errors, so both phases release them alike. */
function checkReserve(answer: LimitResult): void {
  if (answer === 'user_limit') throw new ImportRecipeError({ code: 'rate_limited' }, 'Too many imports; try again later');
  if (answer === 'daily_limit') throw new ImportRecipeError({ code: 'daily_limit' }, "Today's recipe imports are used up");
  if (answer === 'monthly_limit') throw new ImportRecipeError({ code: 'limit_reached' }, "This month's recipe imports are used up");
}

/** The job's captured page, or undefined to fetch (share-ingest validated it; anything else is ignored). */
function capturedPage(page: unknown): RecipeImportPage | undefined {
  if (page == null) return undefined;
  const parsed = RecipeImportPageSchema.safeParse(page);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The extracting phase of one job: `requireFeature` (a plan without `recipe_import`, or a sharer no
 * longer in the household, fails `not_entitled` uncharged), the URL and kill-switch checks, then
 * `reserve` (charged once per operation: a retry after a crash reserves `ok` without charging),
 * `extractForImport` with the job's page (a client capture, so never cached by URL), and the save.
 * Returns `extracted` or the release made; a lost lease ends the job here without a release.
 */
async function extractJob(job: ShareImportJob, deps: WorkerDeps): Promise<'extracted' | 'lease_lost' | Release> {
  if (job.kind === 'photo') return extractPhotoJob(job, deps);
  const importDeps = deps.importDeps(job);
  try {
    await importDeps.store.requireFeature('recipe_import', job.household_id);
    if (!job.url || !canonicalRecipeUrl(job.url)) throw new ImportRecipeError({ code: 'invalid_url' }, 'Not an http(s) URL');
    if (!isAiEnabled('extractRecipe')) {
      throw new ImportRecipeError({ code: 'unavailable', reason: 'ai_off' }, 'Recipe import is turned off');
    }
    checkReserve(await deps.store.reserve(job.id, job.lease_token));
    const extraction = await extractForImport(
      { url: job.url, page: capturedPage(job.page), householdId: job.household_id },
      importDeps,
    );
    await deps.store.saveExtraction(job.id, job.lease_token, extraction);
    return 'extracted';
  } catch (err) {
    return failJob(job, deps, err);
  }
}

/**
 * The extracting phase of a photo share: `requireFeature` and the kill switch (uncharged, as for a
 * link), images the job no longer has (`invalid_request`, uncharged), then `reserve` (the photo
 * limits), the pages downloaded from share-images (one that's gone is `invalid_request`), the
 * extraction (`extractRecipePhotoForImport`, no source URL and no photo) and the save. The pages are
 * never logged.
 */
async function extractPhotoJob(job: ShareImportJob, deps: WorkerDeps): Promise<'extracted' | 'lease_lost' | Release> {
  const importDeps = deps.importDeps(job);
  try {
    await importDeps.store.requireFeature('recipe_import', job.household_id);
    if (!isAiEnabled('extractRecipePhoto')) {
      throw new ImportRecipePhotoError({ code: 'unavailable', reason: 'ai_off' }, 'Photo import is turned off');
    }
    const paths = job.images;
    if (!paths || paths.length === 0) throw new ShareImagesMissingError();
    checkReserve(await deps.store.reserve(job.id, job.lease_token));
    const images: RecipePhoto[] = [];
    for (const path of paths) {
      images.push({ mediaType: 'image/jpeg', data: base64(await downloadShareImage(deps.pages, path)) });
    }
    const extraction = await extractRecipePhotoForImport(images, job.household_id, importDeps);
    await deps.store.saveExtraction(job.id, job.lease_token, extraction);
    return 'extracted';
  } catch (err) {
    return failJob(job, deps, err);
  }
}

async function downloadShareImage(pages: SharePageStorage, path: string): Promise<Uint8Array> {
  const bytes = await pages.downloadShareImage(path);
  if (!bytes) throw new ShareImagesMissingError();
  return bytes;
}

/** Standard base64, in chunks so a 2 MB page never goes into one call's arguments. */
export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * A photo share's page n (1-based) in recipe-pages, for the recipe it creates:
 * `<household_id>/<recipe_id>/<uuidv5(op id:page:n)>.jpg`, the same on every replan and retry.
 */
export async function recipePagePath(jobId: string, householdId: string, recipeId: string, n: number): Promise<string> {
  return `${householdId}/${recipeId}/${await uuidV5(`${jobId}:page:${n}`, IMPORT_ID_NAMESPACE)}.jpg`;
}

/**
 * A photo share's pages, before its commit: copies each image to recipe-pages for the recipe the
 * plan creates (downloaded and uploaded with replace, so a replan or retry overwrites), recording
 * the prefix in `copiedTo` first, and sets `source_pages` on the plan's recipe insert. Nothing when
 * the plan creates no recipe. Images the job no longer has are ShareImagesMissingError; any other
 * failure is thrown as is (a transient release).
 */
async function attachPages(
  job: ShareImportJob,
  plan: CommitPlan,
  target: CommitTarget,
  pages: SharePageStorage,
  copiedTo: Set<string>,
): Promise<CommitPlan> {
  const recipeId = plan.request.recipe_id;
  const insert = plan.writes.find((w) => w.op === 'insert' && w.table === 'recipes' && w.id === recipeId);
  if (!insert) return plan;
  const paths = job.images;
  if (!paths || paths.length === 0) throw new ShareImagesMissingError();
  copiedTo.add(`${target.householdId}/${recipeId}/`);
  const sourcePages: string[] = [];
  for (const [index, from] of paths.entries()) {
    const to = await recipePagePath(job.id, target.householdId, recipeId, index + 1);
    await pages.uploadRecipePage(to, await downloadShareImage(pages, from));
    sourcePages.push(to);
  }
  const writes: Write[] = plan.writes.map((w) => (w === insert ? { ...w, fields: { ...w.fields, source_pages: sourcePages } } : w));
  return { ...plan, writes };
}

/**
 * The committing phase of one job: the destination (`resolveTarget`; a sharer who left the
 * household fails `not_a_member` with nothing written), the snapshot and plan (`planCommit`), and
 * `commit_share_import`. On `plan_conflict` or `destination_changed` it reads, plans and commits
 * again, up to MAX_REPLANS times, then releases as transient with that code. A retry of a job
 * already committed gets its stored receipt back. A photo share's pages are copied to recipe-pages
 * before each commit (`attachPages`); when the job ends failed, the prefixes they went to (and
 * `<household_id>/<uuidv5(op id)>/`, for an earlier run's copies) are queued for deletion. Returns
 * `committed` or the release made; a lost lease ends the job here without a release.
 */
async function commitJob(job: ShareImportJob, deps: WorkerDeps): Promise<'committed' | 'lease_lost' | Release> {
  const now = deps.now ?? Date.now;
  const copiedTo = new Set<string>();
  try {
    const extraction = jobExtraction(job);
    for (let replans = 0; ; replans++) {
      try {
        const target = await resolveTarget(job, deps.commitStore);
        let plan = await planCommit(job, extraction, target, deps.commitStore, new Date(now()));
        if (job.kind === 'photo') plan = await attachPages(job, plan, target, deps.pages, copiedTo);
        await deps.commitStore.commit(job.id, job.lease_token, plan.request, plan.writes, plan.preconditions);
        return 'committed';
      } catch (err) {
        if (err instanceof CommitConflictError && replans < MAX_REPLANS) continue;
        throw err;
      }
    }
  } catch (err) {
    if (job.kind !== 'photo') return failJob(job, deps, err);
    copiedTo.add(`${job.household_id}/${await uuidV5(job.id, IMPORT_ID_NAMESPACE)}/`);
    return failJob(job, deps, err, () => queuePageDeletions(job, deps, copiedTo));
  }
}

/** Queues a failed photo share's recipe-pages prefixes; a failure is logged and reported, not thrown. */
async function queuePageDeletions(job: ShareImportJob, deps: WorkerDeps, prefixes: Set<string>): Promise<void> {
  for (const prefix of prefixes) {
    try {
      await deps.store.queueRecipePageDeletion(prefix);
    } catch (err) {
      const error = asError(err);
      console.error(JSON.stringify({ level: 'error', event: 'share_import_pages_not_queued', job: job.id, error: error.message.slice(0, 200) }));
      reportError('share-import-worker', error, { event: 'share_import_pages_not_queued' });
    }
  }
}

/**
 * Releases a job whose phase threw (reporting the unexpected), unless its lease was lost, then runs
 * `onFailed` when the release left the job failed.
 */
async function failJob(
  job: ShareImportJob,
  deps: WorkerDeps,
  err: unknown,
  onFailed?: () => Promise<void>,
): Promise<'lease_lost' | Release> {
  if (err instanceof LeaseLostError) return 'lease_lost';
  const release = releaseFor(err, (deps.now ?? Date.now)());
  if (release.code === 'internal') {
    const error = asError(err);
    console.error(JSON.stringify({ level: 'error', event: 'share_import_failed', job: job.id, error: error.message.slice(0, 200) }));
    reportError('share-import-worker', error, { event: 'share_import_failed' });
  }
  let status: string;
  try {
    status = await deps.store.release(job.id, job.lease_token, release);
  } catch (releaseErr) {
    if (releaseErr instanceof LeaseLostError) return 'lease_lost';
    throw releaseErr;
  }
  if (status === 'failed') await onFailed?.();
  return release;
}

/**
 * One run: claims jobs (both phases unless `kinds` says otherwise) until none is due or the budget
 * has passed, one at a time. A store error outside a job's phase (claim, release) ends the run;
 * leases recover the job.
 */
export async function runWorker(deps: WorkerDeps): Promise<RunResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const budget = deps.budgetMs ?? RUN_BUDGET_MS;
  const kinds = deps.kinds ?? ['extracting', 'committing'];
  const result: RunResult = { claimed: 0, extracted: 0, committed: 0, transient: 0, waiting: 0, permanent: 0, leaseLost: 0 };
  while (now() - started < budget) {
    const job = await deps.store.claim(kinds);
    if (!job) break;
    result.claimed++;
    const outcome = job.status === 'committing' ? await commitJob(job, deps) : await extractJob(job, deps);
    if (outcome === 'extracted') result.extracted++;
    else if (outcome === 'committed') result.committed++;
    else if (outcome === 'lease_lost') result.leaseLost++;
    else result[outcome.kind]++;
    console.log(
      JSON.stringify({
        level: 'info',
        event: `share_import_${job.status}`,
        job: job.id,
        outcome: typeof outcome === 'string' ? outcome : `${outcome.kind}:${outcome.code}`,
      }),
    );
  }
  return result;
}

/** POST → 200 RunResult · 405 · 500. */
export async function handleRequest(req: Request, run: () => Promise<RunResult>): Promise<Response> {
  if (req.method !== 'POST') return Response.json({ error: 'method_not_allowed', message: 'Use POST' }, { status: 405 });
  try {
    return Response.json(await run());
  } catch (err) {
    console.error('share-import-worker failed:', asError(err).message.slice(0, 200));
    reportError('share-import-worker', err);
    return Response.json({ error: 'internal', message: 'The share import run failed' }, { status: 500 });
  }
}
