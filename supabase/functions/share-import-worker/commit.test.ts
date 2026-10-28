import type { Precondition, ReuseCandidate, Write } from '@shared/domain/index.ts';
import type { RecipeImportResponse } from '@shared/index.ts';
import { assert, assertEquals, assertRejects } from '@std/assert';

import {
  CommitConflictError,
  CommitRefusedError,
  planCommit,
  readSnapshot,
  resolveTarget,
  uuidV5,
  type CatalogRow,
  type CommitRequest,
  type ContributionRow,
  type ItemRow,
  type ListRow,
  type ShareImportCommitStore,
  type ShareImportReceipt,
  type UnitUsageDbRow,
} from './commit.ts';
import {
  LeaseLostError,
  MAX_REPLANS,
  runWorker,
  type JobKind,
  type Release,
  type RunResult,
  type SharePageStorage,
  type ShareImportJob,
  type ShareImportWorkerStore,
} from './handler.ts';

const NOW = Date.parse('2026-10-23T10:00:00Z');
const NAMESPACE = '6f3b2a91-4c7e-4d1a-9b8e-2a5c7d0e4f13';
const OP = 'f0000000-0000-4000-8000-000000000001';
const LEASE = 'e0000000-0000-4000-8000-000000000001';
const USER = '11111111-1111-4111-8111-111111111111';
const HOME = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const WORK = 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const GROCERIES = 'c1000000-0000-4000-8000-000000000001';
const COSTCO = 'c1000000-0000-4000-8000-000000000002';
const OFFICE = 'c1000000-0000-4000-8000-000000000003';

const PASTA: RecipeImportResponse = {
  name: 'Garlic Pasta',
  sourceUrl: 'https://example.com/garlic-pasta',
  servings: 4,
  ingredients: [
    { ingredientName: 'garlic', displayName: 'garlic', quantity: 2, unit: 'clove', note: 'minced', categoryId: null, status: 'categorized' },
    { ingredientName: 'spaghetti', displayName: 'spaghetti', quantity: 1, unit: 'lb', note: '', categoryId: null, status: 'categorized' },
    { ingredientName: 'lime', displayName: 'lime', quantity: null, unit: null, note: '', categoryId: null, status: 'categorized' },
  ],
  tags: null,
  totalMinutes: 20,
  steps: ['Boil the pasta.', 'Fry the garlic.'],
  stepIngredients: [[{ index: 1, quantity: null }], [{ index: 0, quantity: null }]],
  imageUrl: null,
};

function job(fields: Partial<ShareImportJob> = {}): ShareImportJob {
  return {
    id: OP,
    user_id: USER,
    household_id: HOME,
    list_id: GROCERIES,
    add_to_list: true,
    kind: 'link',
    url: 'https://www.example.com/garlic-pasta/',
    images: null,
    page: null,
    extraction: PASTA,
    status: 'committing',
    lease_token: LEASE,
    attempts: 1,
    ...fields,
  };
}

const list = (id: string, householdId: string, fields: Partial<ListRow> = {}): ListRow => ({
  id,
  householdId,
  archivedAt: null,
  deletedAt: null,
  ...fields,
});

/** What the committing phase reads, in memory, and `commit_share_import` as a script. */
class FakeCommitStore implements ShareImportCommitStore {
  members = new Set([`${USER}:${HOME}`, `${USER}:${WORK}`]);
  lists: ListRow[] = [list(GROCERIES, HOME), list(COSTCO, HOME), list(OFFICE, WORK)];
  defaultList: string | null = null;
  combine = false;
  catalogRows: CatalogRow[] = [];
  items: (ItemRow & { listId: string })[] = [];
  contributions: ContributionRow[] = [];
  usage: (UnitUsageDbRow & { householdId: string })[] = [];
  recipes: ReuseCandidate[] = [];
  reads = 0;
  commits: { target: CommitRequest; writes: Write[]; preconditions: Precondition[] }[] = [];
  /** What each commit does, in order; `ok` once they run out. */
  outcomes: (Error | 'ok')[] = [];
  /** Runs before each commit's outcome (a device writing between plan and commit). */
  beforeCommit?: (attempt: number) => void;

  async isMember(userId: string, householdId: string) {
    this.reads++;
    return this.members.has(`${userId}:${householdId}`);
  }
  async list(listId: string) {
    return this.lists.find((l) => l.id === listId) ?? null;
  }
  async defaultListId() {
    return this.defaultList;
  }
  async memberLists(userId: string) {
    return this.lists.filter((l) => this.members.has(`${userId}:${l.householdId}`) && !l.deletedAt && !l.archivedAt);
  }
  async combineLanguages() {
    return this.combine;
  }
  async catalog(names: string[]) {
    return this.catalogRows.filter((c) => names.includes(c.normalizedName));
  }
  async liveItems(listId: string) {
    return this.items.filter((i) => i.listId === listId).map(({ listId: _, ...i }) => i);
  }
  async liveContributions(itemIds: string[]) {
    return this.contributions.filter((c) => itemIds.includes(c.listItemId));
  }
  async unitUsage(householdId: string, names: string[]) {
    return this.usage.filter((u) => u.householdId === householdId && names.includes(u.ingredientName));
  }
  async recipeExists(id: string) {
    return this.recipes.some((r) => r.id === id);
  }
  async reuseCandidates(householdId: string, importRecipeId: string) {
    return this.recipes.filter((r) => r.deletedAt === null && (r.id === importRecipeId || (r.householdId === householdId && r.sourceUrl)));
  }
  async commit(_id: string, _lease: string, target: CommitRequest, writes: Write[], preconditions: Precondition[]): Promise<ShareImportReceipt> {
    this.commits.push({ target, writes, preconditions });
    this.beforeCommit?.(this.commits.length);
    const outcome = this.outcomes.shift() ?? 'ok';
    if (outcome !== 'ok') throw outcome;
    return {
      recipe_id: target.recipe_id,
      applied_list_id: target.list_id,
      list_gone: target.list_gone,
      items_added: target.items_added,
      items_combined: target.items_combined,
      committed_at: new Date(NOW).toISOString(),
    };
  }
}

/** One extracted job, claimed for committing, and its release. */
class FakeJobs implements ShareImportWorkerStore {
  pending: ShareImportJob[] = [];
  claims: JobKind[][] = [];
  releases: Release[] = [];
  releaseError?: Error;
  /** The status a transient release leaves (`failed` on the 8th attempt). */
  transientStatus = 'extracted';
  queued: string[] = [];
  queueError?: Error;

  async claim(kinds: JobKind[]) {
    this.claims.push(kinds);
    return this.pending.shift() ?? null;
  }
  async reserve(): Promise<never> {
    throw new Error('Not extracting');
  }
  async saveExtraction(): Promise<never> {
    throw new Error('Not extracting');
  }
  async release(_id: string, _lease: string, release: Release) {
    if (this.releaseError) throw this.releaseError;
    this.releases.push(release);
    return release.kind === 'permanent' ? 'failed' : this.transientStatus;
  }
  async queueRecipePageDeletion(prefix: string) {
    if (this.queueError) throw this.queueError;
    this.queued.push(prefix);
  }
}

/** share-images and recipe-pages in memory. */
class FakePages implements SharePageStorage {
  shareImages = new Map<string, Uint8Array>();
  recipePages = new Map<string, Uint8Array>();
  uploads: string[] = [];
  uploadError?: Error;

  async downloadShareImage(path: string) {
    return this.shareImages.get(path) ?? null;
  }
  async uploadRecipePage(path: string, bytes: Uint8Array) {
    if (this.uploadError) throw this.uploadError;
    this.uploads.push(path);
    this.recipePages.set(path, bytes);
  }
}

function setup(j: ShareImportJob = job()) {
  const store = new FakeCommitStore();
  const jobs = new FakeJobs();
  const pages = new FakePages();
  jobs.pending.push(j);
  const run = () =>
    runWorker({
      store: jobs,
      commitStore: store,
      pages,
      importDeps: () => {
        throw new Error('Not extracting');
      },
      now: () => NOW,
    });
  return { store, jobs, pages, run };
}

const result = (fields: Partial<RunResult>): RunResult => ({ claimed: 0, extracted: 0, committed: 0, transient: 0, waiting: 0, permanent: 0, leaseLost: 0, ...fields });

const silently = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
};

// --- uuidV5 -------------------------------------------------------------------------------------

Deno.test('uuidV5 is RFC 4122 version 5', async () => {
  // Python's uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org').
  assertEquals(await uuidV5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '886313e1-3b8a-5372-9b90-0c9aee199e5d');
  const id = await uuidV5(OP, NAMESPACE);
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id));
  assertEquals(await uuidV5(OP, NAMESPACE), id);
  assert((await uuidV5(`${OP}:item:0`, NAMESPACE)) !== id);
  await assertRejects(() => uuidV5(OP, 'not-a-namespace'), Error, 'Invalid namespace');
});

// --- resolveTarget ------------------------------------------------------------------------------

Deno.test('resolveTarget: the share\'s list while it\'s live, unarchived and in the household', async () => {
  const store = new FakeCommitStore();
  assertEquals(await resolveTarget(job(), store), { householdId: HOME, listId: GROCERIES, listGone: false });
});

Deno.test('resolveTarget: an archived, deleted or moved list falls back to the default list', async () => {
  const store = new FakeCommitStore();
  store.defaultList = OFFICE;
  store.lists[0].archivedAt = '2026-10-22T00:00:00Z';
  assertEquals(await resolveTarget(job(), store), { householdId: WORK, listId: OFFICE, listGone: false });

  store.lists[0] = list(GROCERIES, HOME, { deletedAt: '2026-10-22T00:00:00Z' });
  assertEquals((await resolveTarget(job(), store)).listId, OFFICE);

  store.lists[0] = list(GROCERIES, WORK);
  assertEquals((await resolveTarget(job(), store)).listId, OFFICE, 'a list now in another household isn\'t the share\'s');
});

Deno.test('resolveTarget: without a usable default list, the share household\'s first list, then any', async () => {
  const store = new FakeCommitStore();
  store.lists = [list(OFFICE, WORK), list(GROCERIES, HOME, { archivedAt: '2026-10-22T00:00:00Z' }), list(COSTCO, HOME)];
  store.defaultList = GROCERIES; // archived
  assertEquals(await resolveTarget(job(), store), { householdId: HOME, listId: COSTCO, listGone: false });

  store.lists = [list(OFFICE, WORK)];
  assertEquals(await resolveTarget(job(), store), { householdId: WORK, listId: OFFICE, listGone: false });

  // No list asked for: the default list.
  store.lists = [list(GROCERIES, HOME), list(COSTCO, HOME)];
  store.defaultList = COSTCO;
  assertEquals((await resolveTarget(job({ list_id: null }), store)).listId, COSTCO);
});

Deno.test('resolveTarget: with no lists at all, recipe-only into the share\'s household, list gone', async () => {
  const store = new FakeCommitStore();
  store.lists = [];
  assertEquals(await resolveTarget(job(), store), { householdId: HOME, listId: null, listGone: true });
});

Deno.test('resolveTarget: a recipe-only share stays recipe-only', async () => {
  const store = new FakeCommitStore();
  assertEquals(await resolveTarget(job({ add_to_list: false, list_id: null }), store), { householdId: HOME, listId: null, listGone: false });
});

Deno.test('resolveTarget: a sharer no longer in the household is refused', async () => {
  const store = new FakeCommitStore();
  store.members.delete(`${USER}:${HOME}`);
  const err = await assertRejects(() => resolveTarget(job(), store), CommitRefusedError);
  assertEquals(err.code, 'not_a_member');
  await assertRejects(() => resolveTarget(job({ add_to_list: false }), store), CommitRefusedError);
});

// --- readSnapshot -------------------------------------------------------------------------------

Deno.test('readSnapshot: the batch\'s items with their amounts, and unit knowledge', async () => {
  const store = new FakeCommitStore();
  store.catalogRows = [
    { normalizedName: 'lime', sameAs: null, defaultUnit: null },
    { normalizedName: 'lima', sameAs: 'lime', defaultUnit: null },
    { normalizedName: 'garlic', sameAs: null, defaultUnit: 'clove' },
  ];
  store.items = [
    { listId: GROCERIES, id: 'i1', ingredientName: 'garlic', displayName: 'Garlic', checkedAt: '2026-10-20T10:00:00.123Z', checkedBy: USER },
    { listId: GROCERIES, id: 'i2', ingredientName: 'lima', displayName: 'Lima', checkedAt: null, checkedBy: null },
    { listId: GROCERIES, id: 'i3', ingredientName: 'milk', displayName: 'Milk', checkedAt: null, checkedBy: null },
    { listId: COSTCO, id: 'i4', ingredientName: 'garlic', displayName: 'Garlic', checkedAt: null, checkedBy: null },
  ];
  store.contributions = [
    { id: 'c1', listItemId: 'i1', source: 'manual', quantity: 3, unit: 'clove' },
    { id: 'c2', listItemId: 'i2', source: 'recipe', quantity: null, unit: null },
  ];
  store.usage = [
    { householdId: HOME, ingredientName: 'garlic', unitKey: 'clove', useCount: 4, lastUsedAt: '2026-10-01T00:00:00Z' },
    { householdId: WORK, ingredientName: 'garlic', unitKey: 'head', useCount: 9, lastUsedAt: '2026-10-01T00:00:00Z' },
  ];
  const names = ['garlic', 'lime'];

  const off = await readSnapshot(store, { id: GROCERIES, householdId: HOME }, names);
  assertEquals(off.snapshot.combineLanguages, false);
  assertEquals(off.snapshot.families, { garlic: 'garlic', lime: 'lime' });
  assertEquals(off.snapshot.items.map((i) => i.id), ['i1'], 'without combine-languages a twin isn\'t the same item');
  assertEquals(off.snapshot.items[0], {
    id: 'i1',
    ingredientName: 'garlic',
    displayName: 'Garlic',
    familyKey: 'garlic',
    checkedAt: new Date('2026-10-20T10:00:00.123Z'),
    checkedBy: USER,
    liveContributions: [{ id: 'c1', source: 'manual', quantity: 3, unit: 'clove' }],
  });
  assertEquals(off.unitKnowledge, {
    garlic: { unitUsage: [{ unitKey: 'clove', useCount: 4, lastUsedAt: new Date('2026-10-01T00:00:00Z') }], defaultUnit: 'clove' },
    lime: { unitUsage: [], defaultUnit: null },
  });

  store.combine = true;
  const on = await readSnapshot(store, { id: GROCERIES, householdId: HOME }, names);
  assertEquals(on.snapshot.items.map((i) => [i.id, i.familyKey]), [['i1', 'garlic'], ['i2', 'lime']]);
  assertEquals(Object.keys(on.unitKnowledge).sort(), ['garlic', 'lima', 'lime']);
});

// --- planCommit ---------------------------------------------------------------------------------

Deno.test('planCommit: a new recipe gets uuidv5(op id), every other row uuidv5(op id:purpose:index)', async () => {
  const store = new FakeCommitStore();
  // Limes are bought by count here.
  store.usage = [{ householdId: HOME, ingredientName: 'lime', unitKey: 'count', useCount: 2, lastUsedAt: '2026-10-01T00:00:00Z' }];
  const at = new Date(NOW);
  const plan = await planCommit(job(), PASTA, { householdId: HOME, listId: GROCERIES, listGone: false }, store, at);
  const recipeId = await uuidV5(OP, NAMESPACE);
  assertEquals(plan.request, {
    household_id: HOME,
    list_id: GROCERIES,
    list_gone: false,
    recipe_id: recipeId,
    items_added: 3,
    items_combined: 0,
  });
  const ids = (table: string) => plan.writes.filter((w) => w.table === table && w.op === 'insert').map((w) => w.id);
  assertEquals(ids('recipes'), [recipeId]);
  assertEquals(ids('recipe_ingredients'), await Promise.all([0, 1, 2].map((i) => uuidV5(`${OP}:recipeIngredient:${i}`, NAMESPACE))));
  assertEquals(ids('list_items'), await Promise.all([0, 1, 2].map((i) => uuidV5(`${OP}:item:${i}`, NAMESPACE))));
  assertEquals(ids('list_item_contributions'), await Promise.all([0, 1, 2].map((i) => uuidV5(`${OP}:contribution:${i}`, NAMESPACE))));
  assertEquals(plan.preconditions[0], { kind: 'recipeAbsent', recipeId });
  assertEquals(plan.preconditions.slice(1), ['garlic', 'spaghetti', 'lime'].map((key) => ({ kind: 'new', listId: GROCERIES, key })));
  // The sharer adds; a lime with no amount is one of it.
  const contribution = plan.writes.find((w) => w.table === 'list_item_contributions' && w.fields.quantity === 1 && w.fields.unit === null);
  assertEquals(contribution?.fields.added_by, USER);
  assertEquals(contribution?.fields.created_at, at.toISOString());

  // A replan makes the same ids.
  const again = await planCommit(job(), PASTA, { householdId: HOME, listId: GROCERIES, listGone: false }, store, at);
  assertEquals(again.writes, plan.writes);
});

Deno.test('planCommit: a deleted recipe holding uuidv5(op id) leaves the new one uuidv5(op id:recipe:0)', async () => {
  const store = new FakeCommitStore();
  const own = await uuidV5(OP, NAMESPACE);
  store.recipes = [{ id: own, name: 'Old', householdId: HOME, sourceUrl: null, deletedAt: '2026-10-22T00:00:00Z' }];
  const plan = await planCommit(job(), PASTA, { householdId: HOME, listId: null, listGone: true }, store, new Date(NOW));
  const id = await uuidV5(`${OP}:recipe:0`, NAMESPACE);
  assertEquals(plan.request.recipe_id, id);
  assertEquals(plan.preconditions, [{ kind: 'recipeAbsent', recipeId: id }]);
  assertEquals(plan.request.list_gone, true);
  assertEquals(plan.request.items_added, 0);
  assertEquals(plan.writes.some((w) => w.table === 'list_items' || w.table === 'list_item_contributions'), false);
});

Deno.test('planCommit: reuses a live recipe with the same canonical URL, and Combines and reopens', async () => {
  const store = new FakeCommitStore();
  store.recipes = [{ id: 'r-old', name: 'Grandma\'s pasta', householdId: HOME, sourceUrl: 'https://www.example.com/garlic-pasta/?utm_source=pin', deletedAt: null }];
  store.items = [
    { listId: GROCERIES, id: 'i-garlic', ingredientName: 'garlic', displayName: 'Garlic', checkedAt: null, checkedBy: null },
    { listId: GROCERIES, id: 'i-lime', ingredientName: 'lime', displayName: 'Lime', checkedAt: '2026-10-20T10:00:00.123Z', checkedBy: USER },
  ];
  store.contributions = [
    { id: 'c-garlic', listItemId: 'i-garlic', source: 'manual', quantity: 1, unit: 'head' },
    { id: 'c-lime', listItemId: 'i-lime', source: 'manual', quantity: 2, unit: null },
  ];
  const plan = await planCommit(job(), PASTA, { householdId: HOME, listId: GROCERIES, listGone: false }, store, new Date(NOW));
  assertEquals(plan.request.recipe_id, 'r-old');
  assertEquals(plan.request.items_added, 3);
  assertEquals(plan.request.items_combined, 1);
  assertEquals(plan.writes.some((w) => w.table === 'recipes' || w.table === 'recipe_ingredients'), false);
  assertEquals(plan.preconditions, [
    { kind: 'recipeReuse', recipeId: 'r-old' },
    { kind: 'combine', itemId: 'i-garlic' },
    { kind: 'new', listId: GROCERIES, key: 'spaghetti' },
    { kind: 'reopen', itemId: 'i-lime', checkedAt: '2026-10-20T10:00:00.123Z', contributionIds: ['c-lime'] },
  ]);
});

// --- The committing phase -----------------------------------------------------------------------

Deno.test('commits an extracted share: claims both phases, plans and commits once', async () => {
  const t = setup();
  assertEquals(await silently(t.run), result({ claimed: 1, committed: 1 }));
  assertEquals(t.jobs.claims, [['extracting', 'committing'], ['extracting', 'committing']]);
  assertEquals(t.store.commits.length, 1);
  assertEquals(t.store.commits[0].target.list_id, GROCERIES);
  assertEquals(t.store.commits[0].target.items_added, 3);
  assertEquals(t.jobs.releases, []);
});

Deno.test('a plan_conflict replans from a fresh read: an item checked meanwhile is reopened', async () => {
  const t = setup();
  t.store.items = [{ listId: GROCERIES, id: 'i-garlic', ingredientName: 'garlic', displayName: 'Garlic', checkedAt: null, checkedBy: null }];
  t.store.contributions = [{ id: 'c-garlic', listItemId: 'i-garlic', source: 'manual', quantity: 1, unit: 'head' }];
  t.store.outcomes = [new CommitConflictError('plan_conflict')];
  // Between the plan and the commit, a device checks the garlic off.
  t.store.beforeCommit = (attempt) => {
    if (attempt === 1) t.store.items[0].checkedAt = '2026-10-23T09:59:00.000Z';
  };
  assertEquals(await silently(t.run), result({ claimed: 1, committed: 1 }));
  assertEquals(t.store.commits.length, 2);
  assertEquals(t.store.commits[0].preconditions[1], { kind: 'combine', itemId: 'i-garlic' });
  assertEquals(t.store.commits[1].preconditions[1], {
    kind: 'reopen',
    itemId: 'i-garlic',
    checkedAt: '2026-10-23T09:59:00.000Z',
    contributionIds: ['c-garlic'],
  });
  assertEquals(t.store.commits[1].target.items_combined, 0);
});

Deno.test(`conflicts ${MAX_REPLANS + 1} times running release the share as transient`, async () => {
  const t = setup();
  t.store.outcomes = [
    new CommitConflictError('plan_conflict'),
    new CommitConflictError('destination_changed'),
    new CommitConflictError('plan_conflict'),
    new CommitConflictError('plan_conflict'),
  ];
  assertEquals(await silently(t.run), result({ claimed: 1, transient: 1 }));
  assertEquals(t.store.commits.length, MAX_REPLANS + 1);
  assertEquals(t.jobs.releases, [{ kind: 'transient', code: 'plan_conflict' }]);
});

Deno.test('destination_changed replans to the new destination, and a sharer who left fails permanently', async () => {
  const t = setup();
  t.store.outcomes = [new CommitConflictError('destination_changed')];
  t.store.beforeCommit = (attempt) => {
    if (attempt === 1) t.store.lists[0].archivedAt = '2026-10-23T09:59:00Z';
  };
  assertEquals(await silently(t.run), result({ claimed: 1, committed: 1 }));
  assertEquals(t.store.commits.map((c) => c.target.list_id), [GROCERIES, COSTCO]);

  const left = setup();
  left.store.outcomes = [new CommitConflictError('destination_changed')];
  left.store.beforeCommit = () => left.store.members.delete(`${USER}:${HOME}`);
  assertEquals(await silently(left.run), result({ claimed: 1, permanent: 1 }));
  assertEquals(left.store.commits.length, 1);
  assertEquals(left.jobs.releases, [{ kind: 'permanent', code: 'not_a_member' }]);
});

Deno.test('a sharer no longer in the household fails permanently, committing nothing', async () => {
  const t = setup();
  t.store.members.clear();
  assertEquals(await silently(t.run), result({ claimed: 1, permanent: 1 }));
  assertEquals(t.store.commits, []);
  assertEquals(t.jobs.releases, [{ kind: 'permanent', code: 'not_a_member' }]);
});

Deno.test('with no lists left, the recipe is committed recipe-only with list_gone', async () => {
  const t = setup();
  t.store.lists = [];
  assertEquals(await silently(t.run), result({ claimed: 1, committed: 1 }));
  assertEquals(t.store.commits[0].target, {
    household_id: HOME,
    list_id: null,
    list_gone: true,
    recipe_id: await uuidV5(OP, NAMESPACE),
    items_added: 0,
    items_combined: 0,
  });
});

Deno.test('a lost lease at the commit ends the job without a release', async () => {
  const t = setup();
  t.store.outcomes = [new LeaseLostError()];
  assertEquals(await silently(t.run), result({ claimed: 1, leaseLost: 1 }));
  assertEquals(t.jobs.releases, []);
});

Deno.test('a missing extraction, or a database error, is transient internal', async () => {
  const t = setup(job({ extraction: null }));
  assertEquals(await silently(t.run), result({ claimed: 1, transient: 1 }));
  assertEquals(t.store.commits, []);
  assertEquals(t.jobs.releases, [{ kind: 'transient', code: 'internal' }]);

  const db = setup();
  db.store.outcomes = [Object.assign(new Error('could not serialize'), { code: '57014' })];
  assertEquals(await silently(db.run), result({ claimed: 1, transient: 1 }));
  assertEquals(db.store.commits.length, 1, 'only conflicts are replanned');
  assertEquals(db.jobs.releases, [{ kind: 'transient', code: 'internal' }]);
});

Deno.test('a release that finds the lease lost counts as lease lost', async () => {
  const t = setup();
  t.store.members.clear();
  t.jobs.releaseError = new LeaseLostError();
  assertEquals(await silently(t.run), result({ claimed: 1, leaseLost: 1 }));
});

// --- Photo shares -------------------------------------------------------------------------------

/** A photo share's extraction: no source URL, no photo, and here no name. */
const PHOTO: RecipeImportResponse = { ...PASTA, name: '', sourceUrl: null, imageUrl: null };
const PAGE_1 = `${USER}/${OP}/1.jpg`;
const PAGE_2 = `${USER}/${OP}/2.jpg`;
const BYTES_1 = new Uint8Array([0xff, 0xd8, 0xff, 1]);
const BYTES_2 = new Uint8Array([0xff, 0xd8, 0xff, 2]);

function photoSetup(fields: Partial<ShareImportJob> = {}) {
  const t = setup(job({ kind: 'photo', url: null, images: [PAGE_1, PAGE_2], extraction: PHOTO, ...fields }));
  t.pages.shareImages.set(PAGE_1, BYTES_1);
  t.pages.shareImages.set(PAGE_2, BYTES_2);
  return t;
}

const recipeInsert = (writes: Write[]) => writes.find((w) => w.op === 'insert' && w.table === 'recipes');

Deno.test('a photo share commits a new recipe uuidv5(op id) named "Recipe", with its pages copied to recipe-pages', async () => {
  const t = photoSetup();
  // A recipe with a URL in the household is never reused for a photo.
  t.store.recipes = [{ id: 'r-pasta', name: 'Garlic Pasta', householdId: HOME, sourceUrl: 'https://example.com/garlic-pasta', deletedAt: null }];
  assertEquals(await silently(t.run), result({ claimed: 1, committed: 1 }));

  const recipeId = await uuidV5(OP, NAMESPACE);
  const pages = [
    `${HOME}/${recipeId}/${await uuidV5(`${OP}:page:1`, NAMESPACE)}.jpg`,
    `${HOME}/${recipeId}/${await uuidV5(`${OP}:page:2`, NAMESPACE)}.jpg`,
  ];
  assertEquals(t.store.commits.length, 1);
  const { target, writes, preconditions } = t.store.commits[0];
  assertEquals(target.recipe_id, recipeId);
  assertEquals(target.list_id, GROCERIES);
  assertEquals(preconditions[0], { kind: 'recipeAbsent', recipeId });
  const insert = recipeInsert(writes)!;
  assertEquals(insert.id, recipeId);
  assertEquals(insert.fields.name, 'Recipe');
  assertEquals(insert.fields.source_url, null);
  assertEquals(insert.fields.image_url, null);
  assertEquals(insert.fields.source_pages, pages);
  // Each page, its own bytes, in order.
  assertEquals(t.pages.uploads, pages);
  assertEquals(t.pages.recipePages.get(pages[0]), BYTES_1);
  assertEquals(t.pages.recipePages.get(pages[1]), BYTES_2);
  assertEquals(t.jobs.queued, []);
  assertEquals(t.jobs.releases, []);
});

Deno.test("a photo share's replan copies to the same paths again, overwriting", async () => {
  const t = photoSetup();
  t.store.outcomes = [new CommitConflictError('plan_conflict')];
  assertEquals(await silently(t.run), result({ claimed: 1, committed: 1 }));
  assertEquals(t.store.commits.length, 2);
  const first = recipeInsert(t.store.commits[0].writes)!.fields.source_pages as string[];
  assertEquals(recipeInsert(t.store.commits[1].writes)!.fields.source_pages, first);
  assertEquals(t.pages.uploads, [...first, ...first]);
  assertEquals(t.pages.recipePages.size, 2);
});

Deno.test("a photo share's pages go under the household it lands in, and a deleted recipe's id is skipped", async () => {
  const t = photoSetup({ list_id: null });
  t.store.defaultList = OFFICE;
  const own = await uuidV5(OP, NAMESPACE);
  t.store.recipes = [{ id: own, name: 'Old', householdId: HOME, sourceUrl: null, deletedAt: '2026-10-01T00:00:00Z' }];
  assertEquals(await silently(t.run), result({ claimed: 1, committed: 1 }));
  const recipeId = await uuidV5(`${OP}:recipe:0`, NAMESPACE);
  assertEquals(t.store.commits[0].target.household_id, WORK);
  assertEquals(t.store.commits[0].target.recipe_id, recipeId);
  assertEquals(recipeInsert(t.store.commits[0].writes)!.fields.source_pages, [
    `${WORK}/${recipeId}/${await uuidV5(`${OP}:page:1`, NAMESPACE)}.jpg`,
    `${WORK}/${recipeId}/${await uuidV5(`${OP}:page:2`, NAMESPACE)}.jpg`,
  ]);
});

Deno.test('a recipe-only photo share still keeps its pages', async () => {
  const t = photoSetup({ add_to_list: false, list_id: null });
  assertEquals(await silently(t.run), result({ claimed: 1, committed: 1 }));
  assertEquals(t.store.commits[0].target.list_id, null);
  assertEquals((recipeInsert(t.store.commits[0].writes)!.fields.source_pages as string[]).length, 2);
});

Deno.test('a failed copy releases the photo share as transient, committing and queueing nothing', async () => {
  const t = photoSetup();
  t.pages.uploadError = new Error('recipe-pages upload failed: 503');
  assertEquals(await silently(t.run), result({ claimed: 1, transient: 1 }));
  assertEquals(t.store.commits, []);
  assertEquals(t.jobs.releases, [{ kind: 'transient', code: 'internal' }]);
  assertEquals(t.jobs.queued, []);
});

Deno.test('a failed copy on the last attempt fails the share and queues its recipe-pages prefix', async () => {
  const t = photoSetup({ attempts: 8 });
  t.pages.uploadError = new Error('recipe-pages upload failed: 503');
  t.jobs.transientStatus = 'failed';
  assertEquals(await silently(t.run), result({ claimed: 1, transient: 1 }));
  assertEquals(t.jobs.queued, [`${HOME}/${await uuidV5(OP, NAMESPACE)}/`]);
});

Deno.test("a photo share's image gone from share-images fails permanently invalid_request, queueing its prefix", async () => {
  const t = photoSetup();
  t.pages.shareImages.delete(PAGE_2);
  assertEquals(await silently(t.run), result({ claimed: 1, permanent: 1 }));
  assertEquals(t.store.commits, []);
  assertEquals(t.jobs.releases, [{ kind: 'permanent', code: 'invalid_request' }]);
  // Page 1 was copied before page 2 was found missing; the prefix covers it.
  assertEquals(t.pages.uploads.length, 1);
  assertEquals(t.jobs.queued, [`${HOME}/${await uuidV5(OP, NAMESPACE)}/`]);

  const gone = photoSetup({ images: null });
  assertEquals(await silently(gone.run), result({ claimed: 1, permanent: 1 }));
  assertEquals(gone.jobs.releases, [{ kind: 'permanent', code: 'invalid_request' }]);
  assertEquals(gone.pages.uploads, []);
});

Deno.test('a photo commit that ends permanently failed queues every prefix its pages went to', async () => {
  const recipeId = await uuidV5(OP, NAMESPACE);
  // Copied under Work (the share's list was gone; the default list is Work's), then the commit
  // finds the destination changed and the replan finds the sharer gone from Home: not_a_member.
  const t = photoSetup({ list_id: null });
  t.store.defaultList = OFFICE;
  t.store.outcomes = [new CommitConflictError('destination_changed')];
  t.store.beforeCommit = () => t.store.members.delete(`${USER}:${HOME}`);
  assertEquals(await silently(t.run), result({ claimed: 1, permanent: 1 }));
  assertEquals(t.jobs.releases, [{ kind: 'permanent', code: 'not_a_member' }]);
  assertEquals(t.jobs.queued, [`${WORK}/${recipeId}/`, `${HOME}/${recipeId}/`]);

  // A sharer gone before anything was copied: the share household's prefix, for an earlier run's copies.
  const left = photoSetup();
  left.store.members.clear();
  assertEquals(await silently(left.run), result({ claimed: 1, permanent: 1 }));
  assertEquals(left.pages.uploads, []);
  assertEquals(left.jobs.queued, [`${HOME}/${recipeId}/`]);
});

Deno.test('a photo share released but not failed, or whose lease was lost, queues nothing', async () => {
  const conflict = photoSetup();
  conflict.store.outcomes = Array.from({ length: MAX_REPLANS + 1 }, () => new CommitConflictError('plan_conflict'));
  assertEquals(await silently(conflict.run), result({ claimed: 1, transient: 1 }));
  assertEquals(conflict.jobs.queued, []);

  const lost = photoSetup();
  lost.store.outcomes = [new LeaseLostError()];
  assertEquals(await silently(lost.run), result({ claimed: 1, leaseLost: 1 }));
  assertEquals(lost.jobs.queued, []);
});

Deno.test('a failure to queue the pages is reported, and the share still counts as failed', async () => {
  const t = photoSetup();
  t.store.members.clear();
  t.jobs.queueError = new Error('database down');
  assertEquals(await silently(t.run), result({ claimed: 1, permanent: 1 }));
  assertEquals(t.jobs.releases, [{ kind: 'permanent', code: 'not_a_member' }]);
});

Deno.test('a link share that fails permanently queues no pages', async () => {
  const t = setup();
  t.store.members.clear();
  assertEquals(await silently(t.run), result({ claimed: 1, permanent: 1 }));
  assertEquals(t.jobs.queued, []);
  assertEquals(t.pages.uploads, []);
});
