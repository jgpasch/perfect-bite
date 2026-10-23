import { type ExtractedRecipe, type RecipeImportResponse } from '@shared/index.ts';
import { assert, assertEquals } from '@std/assert';
import { APICallError, type LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { mockRecipeModel } from '../_shared/ai/mock-model.ts';
import type { AiCallRecord } from '../_shared/ai/run-ai-task.ts';
import { NotEntitledError, type Feature } from '../_shared/entitlements.ts';
import { FetchPageError, type FetchedPage } from '../_shared/fetch-page.ts';
import type { LimitResult } from '../categorize-ingredients/handler.ts';
import type { CachedImport, ImportDeps, RecipeImportStore } from '../import-recipe/handler.ts';
import type { ShareImportCommitStore } from './commit.ts';
import {
  handleRequest,
  LeaseLostError,
  releaseFor,
  runWorker,
  type JobKind,
  type Release,
  type RunResult,
  type ShareImportJob,
  type ShareImportWorkerStore,
} from './handler.ts';

const NOW = Date.parse('2026-10-10T12:00:20Z');
const MINUTE = 60_000;
const USER = '11111111-1111-4111-8111-111111111111';
const HOUSEHOLD = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const PASTA_URL = 'https://www.example.com/garlic-pasta/?utm_source=pin';
const PASTA_KEY = 'https://example.com/garlic-pasta';
const PASTA_PAGE = {
  title: 'Garlic Pasta | Example',
  jsonLd: [
    JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Recipe',
      name: 'Garlic Pasta',
      recipeYield: '4 servings',
      recipeIngredient: ['2 cloves garlic, minced', '1 lb spaghetti'],
    }),
  ],
  text: 'Our favourite weeknight dinner.',
};
/** No JSON-LD and no text: not a recipe, without a model call. */
const EMPTY_PAGE = { title: 'Nothing', jsonLd: [], text: '' };

// --- Fakes --------------------------------------------------------------------------------------

type Row = {
  id: string;
  user_id: string;
  household_id: string;
  list_id: string | null;
  add_to_list: boolean;
  url: string;
  page: unknown;
  status: 'received' | 'extracting' | 'extracted' | 'committing' | 'done' | 'failed';
  attempts: number;
  next_attempt_at: number;
  lease_token: string | null;
  lease_expires_at: number | null;
  metered_at: number | null;
  extraction: RecipeImportResponse | null;
  error_kind: string | null;
  error_code: string | null;
  resets_at: string | null;
  created_at: number;
};

/** `share_imports` and its RPCs as 20261210093000_share_imports.sql defines them, on a fake clock. */
class FakeJobs implements ShareImportWorkerStore {
  now = NOW;
  rows: Row[] = [];
  /** What `check_recipe_import_limit` answers, and how many imports it counted. */
  limit: LimitResult = 'ok';
  charges = 0;
  calls: string[] = [];

  add(id: string, fields: Partial<Row> = {}): Row {
    const row: Row = {
      id,
      user_id: USER,
      household_id: HOUSEHOLD,
      list_id: null,
      add_to_list: true,
      url: PASTA_URL,
      page: PASTA_PAGE,
      status: 'received',
      attempts: 0,
      next_attempt_at: this.now,
      lease_token: null,
      lease_expires_at: null,
      metered_at: null,
      extraction: null,
      error_kind: null,
      error_code: null,
      resets_at: null,
      created_at: this.now + this.rows.length,
      ...fields,
    };
    this.rows.push(row);
    return row;
  }

  row(id: string): Row {
    return this.rows.find((r) => r.id === id)!;
  }

  private leased(id: string, lease: string, statuses: Row['status'][], unexpired: boolean): Row {
    const row = this.rows.find((r) => r.id === id);
    if (!row || row.lease_token !== lease || !statuses.includes(row.status) || (unexpired && row.lease_expires_at! <= this.now)) {
      throw new LeaseLostError();
    }
    return row;
  }

  async claim(kinds: JobKind[]): Promise<ShareImportJob | null> {
    this.calls.push('claim');
    for (;;) {
      const due = this.rows
        .filter(
          (r) =>
            (r.status === 'received' && kinds.includes('extracting') && r.next_attempt_at <= this.now) ||
            (r.status === 'extracted' && kinds.includes('committing') && r.next_attempt_at <= this.now) ||
            (kinds.includes(r.status as JobKind) && r.lease_expires_at !== null && r.lease_expires_at < this.now),
        )
        .sort((a, b) => a.created_at - b.created_at)[0];
      if (!due) return null;
      if ((due.status === 'extracting' || due.status === 'committing') && due.attempts >= 8) {
        Object.assign(due, { status: 'failed', error_kind: 'transient', error_code: 'lease_lost', page: null, lease_token: null, lease_expires_at: null });
        continue;
      }
      if (due.status === 'received') due.status = 'extracting';
      if (due.status === 'extracted') due.status = 'committing';
      due.lease_token = crypto.randomUUID();
      due.lease_expires_at = this.now + 2 * MINUTE;
      due.attempts++;
      return {
        id: due.id,
        user_id: due.user_id,
        household_id: due.household_id,
        list_id: due.list_id,
        add_to_list: due.add_to_list,
        url: due.url,
        page: due.page,
        extraction: due.extraction,
        status: due.status as JobKind,
        lease_token: due.lease_token,
        attempts: due.attempts,
      };
    }
  }

  async reserve(id: string, lease: string): Promise<LimitResult> {
    this.calls.push('reserve');
    const row = this.leased(id, lease, ['extracting'], true);
    if (row.metered_at !== null) return 'ok';
    if (this.limit === 'ok') {
      this.charges++;
      row.metered_at = this.now;
    }
    return this.limit;
  }

  async saveExtraction(id: string, lease: string, extraction: RecipeImportResponse): Promise<void> {
    this.calls.push('save');
    const row = this.leased(id, lease, ['extracting'], true);
    Object.assign(row, {
      status: 'extracted', extraction, next_attempt_at: this.now, lease_token: null, lease_expires_at: null,
      error_code: null, error_kind: null, resets_at: null,
    });
  }

  releases: Release[] = [];
  async release(id: string, lease: string, release: Release): Promise<string> {
    this.calls.push('release');
    const row = this.leased(id, lease, ['extracting', 'committing'], false);
    this.releases.push(release);
    const back = row.status === 'extracting' ? 'received' : 'extracted';
    if (release.kind === 'permanent' || (release.kind === 'transient' && row.attempts >= 8)) {
      Object.assign(row, {
        status: 'failed', error_kind: release.kind, error_code: release.code,
        resets_at: release.kind === 'permanent' ? (release.resetsAt ?? null) : null,
        page: null, lease_token: null, lease_expires_at: null,
      });
    } else if (release.kind === 'transient') {
      Object.assign(row, {
        status: back, error_kind: 'transient', error_code: release.code, resets_at: null,
        next_attempt_at: this.now + 30_000, lease_token: null, lease_expires_at: null,
      });
    } else {
      Object.assign(row, {
        status: back, error_kind: 'waiting', error_code: release.code, resets_at: null,
        next_attempt_at: Math.floor(this.now / MINUTE) * MINUTE + MINUTE, attempts: Math.max(row.attempts - 1, 0),
        lease_token: null, lease_expires_at: null,
      });
    }
    return row.status;
  }
}

/** import-recipe's store for the sharer: the plan check, the URL cache and `ai_calls`. */
class FakeRecipeStore implements RecipeImportStore {
  features = new Set<Feature>(['recipe_import']);
  notMemberOf = new Set<string>();
  featureChecks: string[] = [];
  limitChecks = 0;
  cache = new Map<string, CachedImport>();
  saves: { urlKey: string; result: ExtractedRecipe }[] = [];
  aiCalls: AiCallRecord[] = [];

  async checkLimit(): Promise<LimitResult> {
    this.limitChecks++;
    return 'ok';
  }
  async getCached(urlKey: string, promptVersion: string) {
    return this.cache.get(`${urlKey}|${promptVersion}`) ?? null;
  }
  async saveCached(urlKey: string, _promptVersion: string, result: ExtractedRecipe) {
    this.saves.push({ urlKey, result });
  }
  async logAiCall(call: AiCallRecord) {
    this.aiCalls.push(call);
  }
  async requireFeature(feature: Feature, householdId: string) {
    this.featureChecks.push(`${feature}:${householdId}`);
    if (!this.features.has(feature) || this.notMemberOf.has(householdId)) throw new NotEntitledError(feature);
  }
}

const FETCHED_PASTA: FetchedPage = {
  ...PASTA_PAGE,
  finalUrl: 'https://www.example.com/garlic-pasta/',
  imageUrl: null,
  imageCandidates: [],
};

function failingModel(error: Error): { instance: LanguageModel; modelId: string } {
  return {
    instance: new MockLanguageModelV4({
      doGenerate: async () => {
        throw error;
      },
    }),
    modelId: 'test:failing',
  };
}

/** The recipe mock, running `during` inside the model call (while no transaction is open). */
function modelDuring(during: () => void | Promise<void>): { instance: LanguageModel; modelId: string } {
  const inner = mockRecipeModel() as MockLanguageModelV4;
  return {
    instance: new MockLanguageModelV4({
      doGenerate: async (options) => {
        await during();
        return inner.doGenerate(options);
      },
    }),
    modelId: 'test:during',
  };
}

/** These tests never commit. */
const NO_COMMITS = new Proxy({} as ShareImportCommitStore, {
  get: () => () => Promise.reject(new Error('No commits in the extracting tests')),
});

function setup() {
  const jobs = new FakeJobs();
  const recipes = new FakeRecipeStore();
  const fetched: string[] = [];
  const importCallers: (string | null)[] = [];
  let fetchPage: (url: string) => Promise<FetchedPage> = async (url) => {
    fetched.push(url);
    return FETCHED_PASTA;
  };
  let model: ImportDeps['model'];
  const importDeps = (job: ShareImportJob): ImportDeps => {
    importCallers.push(job.user_id);
    return {
      store: recipes,
      categorize: async () => ({ results: {} }),
      fetchPage: (url) => fetchPage(url),
      model,
      caller: { userId: job.user_id, householdId: null },
      now: () => jobs.now,
    };
  };
  // The extracting phase only (commit.test.ts has the committing phase).
  const run = (budgetMs?: number) =>
    runWorker({ store: jobs, commitStore: NO_COMMITS, kinds: ['extracting'], importDeps, now: () => jobs.now, budgetMs });
  return {
    jobs,
    recipes,
    fetched,
    importCallers,
    run,
    setFetch(fn: (url: string) => Promise<FetchedPage>) {
      fetchPage = async (url) => {
        fetched.push(url);
        return fn(url);
      };
    },
    setModel(m: ImportDeps['model']) {
      model = m;
    },
  };
}

async function withEnv(vars: Record<string, string | null>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, Deno.env.get(k)]));
  const set = (k: string, v: string | null | undefined) => (v == null ? Deno.env.delete(k) : Deno.env.set(k, v));
  for (const [k, v] of Object.entries(vars)) set(k, v);
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) set(k, v);
  }
}

const test = (name: string, fn: () => Promise<void>) =>
  Deno.test(name, () => withEnv({ AI_MODEL_RECIPE: 'mock', AI_MODEL_CATEGORIZE: 'mock', AI_MODEL_RECIPE_FALLBACK: null }, fn));

const result = (fields: Partial<RunResult>): RunResult => ({ claimed: 0, extracted: 0, committed: 0, transient: 0, waiting: 0, permanent: 0, leaseLost: 0, ...fields });

const JOB = 'f0000000-0000-4000-8000-000000000001';

// --- Extracting ---------------------------------------------------------------------------------

test('extracts a share from its captured page, charged once and never cached by URL', async () => {
  const t = setup();
  t.jobs.add(JOB);
  assertEquals(await t.run(), result({ claimed: 1, extracted: 1 }));

  const row = t.jobs.row(JOB);
  assertEquals(row.status, 'extracted');
  assertEquals(row.lease_token, null);
  assertEquals(row.extraction?.name, 'Garlic Pasta');
  assertEquals(row.extraction?.sourceUrl, PASTA_KEY);
  assertEquals(row.extraction?.servings, 4);
  assertEquals(row.extraction?.ingredients.map((i) => i.ingredientName), ['garlic', 'spaghetti']);
  assertEquals(t.jobs.charges, 1);
  assertEquals(t.jobs.calls, ['claim', 'reserve', 'save', 'claim']);
  // The plan was checked for the share's household; import-recipe's own limit wasn't used.
  assertEquals(t.recipes.featureChecks, [`recipe_import:${HOUSEHOLD}`]);
  assertEquals(t.recipes.limitChecks, 0);
  assertEquals(t.fetched, []);
  assertEquals(t.recipes.saves, []);
  assertEquals(t.importCallers, [USER]);
  const extract = t.recipes.aiCalls.filter((c) => c.task === 'extractRecipe');
  assertEquals(extract.length, 1);
  assertEquals(extract[0].user_id, USER);
  assertEquals(extract[0].household_id, HOUSEHOLD);
});

test('a share without a page is fetched by the server, and that extraction is cached by URL', async () => {
  const t = setup();
  t.jobs.add(JOB, { page: null });
  assertEquals(await t.run(), result({ claimed: 1, extracted: 1 }));
  assertEquals(t.fetched, [PASTA_URL]);
  assertEquals(t.recipes.saves.map((s) => s.urlKey), [PASTA_KEY]);
  assertEquals(t.jobs.row(JOB).extraction?.name, 'Garlic Pasta');
});

test('works through every due job, oldest first, and leaves the rest', async () => {
  const t = setup();
  t.jobs.add('f0000000-0000-4000-8000-000000000002');
  t.jobs.add('f0000000-0000-4000-8000-000000000003');
  t.jobs.add('f0000000-0000-4000-8000-000000000004', { next_attempt_at: NOW + MINUTE });
  t.jobs.add('f0000000-0000-4000-8000-000000000005', { status: 'extracted' });
  assertEquals(await t.run(), result({ claimed: 2, extracted: 2 }));
  assertEquals(t.jobs.rows.map((r) => r.status), ['extracted', 'extracted', 'received', 'extracted']);
  assertEquals(t.jobs.charges, 2);
});

test('stops claiming once about 50 s have passed', async () => {
  const t = setup();
  for (let i = 1; i <= 3; i++) t.jobs.add(`f0000000-0000-4000-8000-00000000001${i}`);
  // Each extraction takes 30 s: the second starts at 30 s, the third would start at 60 s.
  t.setModel(modelDuring(() => void (t.jobs.now += 30_000)));
  assertEquals(await t.run(), result({ claimed: 2, extracted: 2 }));
  assertEquals(t.jobs.rows.map((r) => r.status), ['extracted', 'extracted', 'received']);
});

test('with nothing due it claims once and stops', async () => {
  const t = setup();
  assertEquals(await t.run(), result({}));
  assertEquals(t.jobs.calls, ['claim']);
});

// --- Crashes and leases -------------------------------------------------------------------------

test('a crash after reserving: the retry under a new lease isn\'t charged again', async () => {
  const t = setup();
  t.jobs.add(JOB);
  // A worker claims and reserves, then dies before saving.
  const lost = (await t.jobs.claim(['extracting']))!;
  assertEquals(await t.jobs.reserve(lost.id, lost.lease_token), 'ok');
  assertEquals(t.jobs.charges, 1);

  // Nothing is due until the lease expires.
  assertEquals(await t.run(), result({}));
  t.jobs.now += 2 * MINUTE + 1;
  assertEquals(await t.run(), result({ claimed: 1, extracted: 1 }));
  const row = t.jobs.row(JOB);
  assertEquals(row.status, 'extracted');
  assertEquals(row.attempts, 2);
  assertEquals(t.jobs.charges, 1);
});

test('a transient failure after reserving retries without charging again', async () => {
  const t = setup();
  t.jobs.add(JOB);
  t.setModel(failingModel(new APICallError({ message: 'overloaded', url: 'https://api.example', requestBodyValues: {}, statusCode: 529, isRetryable: false })));
  assertEquals(await t.run(), result({ claimed: 1, transient: 1 }));
  assertEquals(t.jobs.row(JOB).status, 'received');
  assertEquals(t.jobs.row(JOB).error_code, 'unavailable');
  assertEquals(t.jobs.charges, 1);

  t.setModel(undefined);
  t.jobs.now += 30_000;
  assertEquals(await t.run(), result({ claimed: 1, extracted: 1 }));
  assertEquals(t.jobs.charges, 1);
  assertEquals(t.jobs.row(JOB).error_code, null);
});

test('a lost lease stops the save: the worker that took over keeps the job', async () => {
  const t = setup();
  t.jobs.add(JOB);
  let takeover: ShareImportJob | null = null;
  // During the model call the lease expires and another run claims the job.
  t.setModel(
    modelDuring(async () => {
      t.jobs.now += 2 * MINUTE + 1;
      takeover = await t.jobs.claim(['extracting']);
    }),
  );
  assertEquals(await t.run(), result({ claimed: 1, leaseLost: 1 }));
  assert(takeover !== null);
  const row = t.jobs.row(JOB);
  assertEquals(row.status, 'extracting');
  assertEquals(row.lease_token, (takeover as ShareImportJob).lease_token);
  assertEquals(row.extraction, null);
  assertEquals(row.attempts, 2);
  // Refused at the save, and no release under the old lease.
  assertEquals(t.jobs.calls, ['claim', 'reserve', 'claim', 'save']);
  assertEquals(t.jobs.releases, []);
  assertEquals(t.jobs.charges, 1);
});

test('a lease lost before reserving stops the job without charging', async () => {
  const t = setup();
  t.jobs.add(JOB);
  const store = t.jobs;
  const reserve = store.reserve.bind(store);
  store.reserve = async (id, lease) => {
    store.now += 2 * MINUTE + 1;
    return reserve(id, lease);
  };
  assertEquals(await t.run(), result({ claimed: 1, leaseLost: 1 }));
  assertEquals(t.jobs.charges, 0);
  assertEquals(t.jobs.row(JOB).extraction, null);
});

// --- Error classes ------------------------------------------------------------------------------

test('not_entitled (plan without recipe_import) is permanent and charges nothing', async () => {
  const t = setup();
  t.jobs.add(JOB);
  t.recipes.features.clear();
  assertEquals(await t.run(), result({ claimed: 1, permanent: 1 }));
  const row = t.jobs.row(JOB);
  assertEquals([row.status, row.error_kind, row.error_code, row.page], ['failed', 'permanent', 'not_entitled', null]);
  assertEquals(t.jobs.charges, 0);
  assertEquals(t.jobs.calls, ['claim', 'release', 'claim']);
});

test('a sharer no longer in the household fails not_entitled, uncharged', async () => {
  const t = setup();
  t.jobs.add(JOB);
  t.recipes.notMemberOf.add(HOUSEHOLD);
  await t.run();
  assertEquals(t.jobs.row(JOB).error_code, 'not_entitled');
  assertEquals(t.jobs.charges, 0);
});

test('rate_limited waits for the next minute without counting an attempt', async () => {
  const t = setup();
  t.jobs.add(JOB);
  t.jobs.limit = 'user_limit';
  assertEquals(await t.run(), result({ claimed: 1, waiting: 1 }));
  const row = t.jobs.row(JOB);
  assertEquals([row.status, row.error_kind, row.error_code, row.attempts], ['received', 'waiting', 'rate_limited', 0]);
  assertEquals(row.next_attempt_at, Date.parse('2026-10-10T12:01:00Z'));
  assertEquals(t.jobs.charges, 0);
});

test('daily_limit fails at once, keeping when it resets', async () => {
  const t = setup();
  t.jobs.add(JOB);
  t.jobs.limit = 'daily_limit';
  assertEquals(await t.run(), result({ claimed: 1, permanent: 1 }));
  const row = t.jobs.row(JOB);
  assertEquals([row.status, row.error_code, row.resets_at], ['failed', 'daily_limit', '2026-10-11T00:00:00.000Z']);
  assertEquals(t.jobs.charges, 0);
});

test('limit_reached (the monthly allowance) fails at once, keeping when it resets', async () => {
  const t = setup();
  t.jobs.add(JOB);
  t.jobs.limit = 'monthly_limit';
  assertEquals(await t.run(), result({ claimed: 1, permanent: 1 }));
  const row = t.jobs.row(JOB);
  assertEquals([row.status, row.error_code, row.resets_at], ['failed', 'limit_reached', '2026-11-01T00:00:00.000Z']);
});

test('not_a_recipe is permanent, and charged (no refunds)', async () => {
  const t = setup();
  t.jobs.add(JOB, { page: EMPTY_PAGE });
  assertEquals(await t.run(), result({ claimed: 1, permanent: 1 }));
  const row = t.jobs.row(JOB);
  assertEquals([row.status, row.error_kind, row.error_code, row.extraction], ['failed', 'permanent', 'not_a_recipe', null]);
  assertEquals(t.jobs.charges, 1);
});

test('invalid_url: a non-http URL fails before reserving', async () => {
  const t = setup();
  t.jobs.add(JOB, { url: 'ftp://example.com/pasta' });
  assertEquals(await t.run(), result({ claimed: 1, permanent: 1 }));
  assertEquals(t.jobs.row(JOB).error_code, 'invalid_url');
  assertEquals(t.jobs.charges, 0);
});

test('invalid_url: a fetch to a private address is permanent', async () => {
  const t = setup();
  t.jobs.add(JOB, { page: null });
  t.setFetch(async () => {
    throw new FetchPageError('blocked_address', 'Resolves to a private address');
  });
  assertEquals(await t.run(), result({ claimed: 1, permanent: 1 }));
  assertEquals(t.jobs.row(JOB).error_code, 'invalid_url');
});

test('fetch_failed is transient', async () => {
  const t = setup();
  t.jobs.add(JOB, { page: null });
  t.setFetch(async () => {
    throw new FetchPageError('timeout', 'Timed out');
  });
  assertEquals(await t.run(), result({ claimed: 1, transient: 1 }));
  const row = t.jobs.row(JOB);
  assertEquals([row.status, row.error_kind, row.error_code], ['received', 'transient', 'fetch_failed']);
  assertEquals(row.next_attempt_at, NOW + 30_000);
  assertEquals(t.recipes.saves, []);
});

test('a model failure is transient unavailable', async () => {
  const t = setup();
  t.jobs.add(JOB);
  t.setModel(failingModel(new APICallError({ message: 'down', url: 'https://api.example', requestBodyValues: {}, statusCode: 500, isRetryable: false })));
  await t.run();
  const row = t.jobs.row(JOB);
  assertEquals([row.status, row.error_kind, row.error_code], ['received', 'transient', 'unavailable']);
});

Deno.test('the AI kill switch is transient unavailable, before any charge', () =>
  withEnv({ AI_MODEL_RECIPE: 'off', AI_MODEL_RECIPE_FALLBACK: null }, async () => {
    const t = setup();
    t.jobs.add(JOB);
    assertEquals(await t.run(), result({ claimed: 1, transient: 1 }));
    assertEquals(t.jobs.row(JOB).error_code, 'unavailable');
    assertEquals(t.jobs.charges, 0);
  }));

test('anything unexpected is transient internal', async () => {
  const t = setup();
  t.jobs.add(JOB, { page: null });
  t.setFetch(async () => {
    throw new Error('connection reset');
  });
  assertEquals(await t.run(), result({ claimed: 1, transient: 1 }));
  const row = t.jobs.row(JOB);
  assertEquals([row.status, row.error_kind, row.error_code], ['received', 'transient', 'internal']);
});

test('a transient failure on the 8th attempt fails the share', async () => {
  const t = setup();
  t.jobs.add(JOB, { attempts: 7 });
  t.setModel(failingModel(new APICallError({ message: 'down', url: 'https://api.example', requestBodyValues: {}, statusCode: 500, isRetryable: false })));
  await t.run();
  const row = t.jobs.row(JOB);
  assertEquals([row.status, row.error_kind, row.error_code, row.attempts], ['failed', 'transient', 'unavailable', 8]);
});

Deno.test('releaseFor maps each class', () => {
  const now = Date.parse('2026-12-31T23:59:00Z');
  assertEquals(releaseFor(new NotEntitledError('recipe_import'), now), { kind: 'permanent', code: 'not_entitled' });
  assertEquals(releaseFor(new Error('boom'), now), { kind: 'transient', code: 'internal' });
  assertEquals(releaseFor(new TypeError('fetch failed'), now), { kind: 'transient', code: 'internal' });
});

// --- HTTP ---------------------------------------------------------------------------------------

Deno.test('handleRequest: POST runs the worker, anything else is 405, a failed run is 500', async () => {
  const url = 'http://localhost/functions/v1/share-import-worker';
  const ok = await handleRequest(new Request(url, { method: 'POST', body: '{}' }), async () => result({ claimed: 1, extracted: 1 }));
  assertEquals(ok.status, 200);
  assertEquals(await ok.json(), result({ claimed: 1, extracted: 1 }));

  const get = await handleRequest(new Request(url), async () => result({}));
  assertEquals(get.status, 405);
  assertEquals((await get.json()).error, 'method_not_allowed');

  const failed = await handleRequest(new Request(url, { method: 'POST', body: '{}' }), async () => {
    throw new Error('database down');
  });
  assertEquals(failed.status, 500);
  assertEquals((await failed.json()).error, 'internal');
});
