import { assertEquals, assertStringIncludes, assertThrows } from '@std/assert';

import { isModelMade, parseArgs, PruneUsageError, run, unlinkedTwins, type CatalogRow, type PruneIo, type PruneStore } from './prune-twins.ts';

const row = (normalized_name: string, over: Partial<CatalogRow> = {}): CatalogRow => ({
  normalized_name,
  lang: 'en',
  same_as: null,
  categorized_by: 'google:gemini-3.8-flash',
  household_count: 0,
  ...over,
});

/** `ingredients` and `ingredient_households` in memory, with the real store's filters. */
class FakePruneStore implements PruneStore {
  rows: CatalogRow[] = [
    // Unlinked model-made twins: pruned.
    row('tomato'),
    row('crema', { lang: 'es', categorized_by: 'anthropic:claude-haiku-5-5' }),
    // A link and its target: kept.
    row('pepino', { lang: 'es', same_as: 'cucumber' }),
    row('cucumber'),
    // The seed's unlinked Spanish name, an admin row, a pending name: kept.
    row('epazote', { lang: 'es', categorized_by: 'seed' }),
    row('queso fresco', { lang: 'es', categorized_by: 'admin' }),
    row('pao de queijo', { lang: null }),
    row('kimchi', { categorized_by: null }),
    // Used by a household: kept.
    row('elote', { lang: 'es', household_count: 2 }),
    row('nopal', { lang: 'es' }),
  ];
  households = new Set(['nopal']);
  /** Rows a list item or override still references, so the delete is refused. */
  referenced = new Set<string>();
  deleteCalls: string[][] = [];

  async findCandidates() {
    return this.rows.filter((r) => r.same_as === null && r.lang !== null && r.household_count === 0 && isModelMade(r.categorized_by));
  }

  async linkTargets() {
    return new Set(this.rows.flatMap((r) => (r.same_as ? [r.same_as] : [])));
  }

  async usedNames(names: readonly string[]) {
    return new Set(names.filter((n) => this.households.has(n)));
  }

  async deleteTwins(names: readonly string[]) {
    this.deleteCalls.push([...names]);
    const gone = names.filter((n) => !this.referenced.has(n));
    this.rows = this.rows.filter((r) => !gone.includes(r.normalized_name));
    return { deleted: gone.length, kept: names.filter((n) => this.referenced.has(n)) };
  }
}

function io(store?: PruneStore, env: Record<string, string> = {}) {
  let out = '';
  let err = '';
  const pruneIo: PruneIo = { out: (t) => (out += `${t}\n`), err: (t) => (err += `${t}\n`), env: (k) => env[k], store };
  return { pruneIo, out: () => out, err: () => err };
}

Deno.test('parseArgs: --apply, --help, nothing; an unknown flag throws', () => {
  assertEquals(parseArgs([]), { apply: false, help: false });
  assertEquals(parseArgs(['--apply']), { apply: true, help: false });
  assertEquals(parseArgs(['-h']), { apply: false, help: true });
  assertThrows(() => parseArgs(['--by', 'seed']), PruneUsageError, 'Unknown argument: --by');
});

Deno.test('isModelMade: a model id, not seed, admin or nothing', () => {
  assertEquals(['mock', 'google:gemini-3.8-flash', 'seed', 'admin', null].map(isModelMade), [true, true, false, false, false]);
});

Deno.test('unlinkedTwins: only unlinked, unused model rows with a language, sorted', () => {
  const store = new FakePruneStore();
  const targets = new Set(['cucumber']);
  assertEquals(unlinkedTwins(store.rows, targets, new Set(['nopal'])).map((r) => r.normalized_name), ['crema', 'tomato']);
  // Without the target and household checks, the target and the used name would be listed too.
  assertEquals(unlinkedTwins(store.rows, new Set(), new Set()).map((r) => r.normalized_name), ['crema', 'cucumber', 'nopal', 'tomato']);
  assertEquals(unlinkedTwins([], targets, new Set()), []);
});

Deno.test('run: a dry run lists the twins and deletes nothing', async () => {
  const store = new FakePruneStore();
  const t = io(store);
  assertEquals(await run([], t.pruneIo), 0);
  assertEquals(
    t.out(),
    [
      '2 unlinked model-made twins:',
      '  crema   es  (anthropic:claude-haiku-5-5)',
      '  tomato  en  (google:gemini-3.8-flash)',
      '',
      'Dry run: nothing changed. Add --apply to delete them.',
      '',
    ].join('\n'),
  );
  assertEquals(store.deleteCalls, []);
  assertEquals(store.rows.length, 10);
});

Deno.test('run --apply: deletes only the listed twins', async () => {
  const store = new FakePruneStore();
  const t = io(store);
  assertEquals(await run(['--apply'], t.pruneIo), 0);
  assertStringIncludes(t.out(), 'Deleted 2 twins.');
  assertEquals(store.deleteCalls, [['crema', 'tomato']]);
  assertEquals(
    store.rows.map((r) => r.normalized_name),
    ['pepino', 'cucumber', 'epazote', 'queso fresco', 'pao de queijo', 'kimchi', 'elote', 'nopal'],
  );
});

Deno.test('run --apply: a twin still referenced is kept and named', async () => {
  const store = new FakePruneStore();
  store.referenced.add('tomato');
  const t = io(store);
  assertEquals(await run(['--apply'], t.pruneIo), 0);
  assertStringIncludes(t.out(), 'Deleted 1 twin.\nKept 1 still in use or changed meanwhile: tomato');
  assertEquals(store.rows.some((r) => r.normalized_name === 'tomato'), true);
});

Deno.test('run: nothing to prune says so and deletes nothing', async () => {
  const store = new FakePruneStore();
  store.rows = store.rows.filter((r) => !['tomato', 'crema'].includes(r.normalized_name));
  const t = io(store);
  assertEquals(await run(['--apply'], t.pruneIo), 0);
  assertEquals(t.out(), 'No unlinked model-made twins.\n');
  assertEquals(store.deleteCalls, []);
});

Deno.test('run: bad usage, missing env and a store error exit 2', async () => {
  const bad = io(new FakePruneStore());
  assertEquals(await run(['--dry'], bad.pruneIo), 2);
  assertStringIncludes(bad.err(), 'Unknown argument: --dry');

  const noEnv = io(undefined, {});
  assertEquals(await run([], noEnv.pruneIo), 2);
  assertStringIncludes(noEnv.err(), 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');

  const store = new FakePruneStore();
  store.linkTargets = () => Promise.reject(new Error('connection refused'));
  const failing = io(store);
  assertEquals(await run([], failing.pruneIo), 2);
  assertEquals(failing.err(), 'Prune failed: connection refused\n');
});

Deno.test('run --help prints the usage', async () => {
  const t = io(new FakePruneStore());
  assertEquals(await run(['--help'], t.pruneIo), 0);
  assertStringIncludes(t.out(), 'Usage: yarn ai:prune-twins [--apply]');
});
