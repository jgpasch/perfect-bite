import { assertEquals, assertStringIncludes, assertThrows } from '@std/assert';

import { parseArgs, run, UnlinkUsageError, type LinkFilter, type LinkRow, type LinkStore, type UnlinkIo } from './unlink.ts';

/** `ingredients` links in memory, with the real store's filters. */
class FakeLinkStore implements LinkStore {
  rows: LinkRow[] = [
    { normalized_name: 'leche', same_as: 'milk', linked_by: 'seed' },
    { normalized_name: 'pepino', same_as: 'cucumber', linked_by: 'google:gemini-3.8-flash' },
    { normalized_name: 'pepinillo', same_as: 'cucumber', linked_by: 'anthropic:claude-haiku-5-5' },
    { normalized_name: 'jitomate', same_as: 'tomato', linked_by: 'google:gemini-3.8-flash' },
  ];
  clearCalls: [string[], LinkFilter][] = [];

  matches(r: LinkRow, { by, name }: LinkFilter) {
    return (by === null || r.linked_by === by) && (name === null || r.normalized_name === name || r.same_as === name);
  }

  async findLinks(filter: LinkFilter) {
    return this.rows.filter((r) => this.matches(r, filter));
  }

  async clearLinks(names: readonly string[], filter: LinkFilter) {
    this.clearCalls.push([[...names], filter]);
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !(names.includes(r.normalized_name) && (filter.by === null || r.linked_by === filter.by)));
    return before - this.rows.length;
  }
}

function io(store?: LinkStore, env: Record<string, string> = {}) {
  let out = '';
  let err = '';
  const unlinkIo: UnlinkIo = { out: (t) => (out += `${t}\n`), err: (t) => (err += `${t}\n`), env: (k) => env[k], store };
  return { unlinkIo, out: () => out, err: () => err };
}

Deno.test('parseArgs: --by, --name (normalized), both, --apply, --help', () => {
  assertEquals(parseArgs(['--by', 'google:gemini-3.8-flash']), { by: 'google:gemini-3.8-flash', name: null, apply: false, help: false });
  assertEquals(parseArgs(['--name', 'Pepinos', '--apply']), { by: null, name: 'pepino', apply: true, help: false });
  assertEquals(parseArgs(['--name=Limón', '--by= seed ']), { by: 'seed', name: 'limon', apply: false, help: false });
  assertEquals(parseArgs(['--help']), { by: null, name: null, apply: false, help: true });
});

Deno.test('parseArgs: no filter, a missing value or an unknown flag throws', () => {
  assertThrows(() => parseArgs([]), UnlinkUsageError, 'Give --by, --name or both');
  assertThrows(() => parseArgs(['--apply']), UnlinkUsageError, 'Give --by, --name or both');
  assertThrows(() => parseArgs(['--by']), UnlinkUsageError, '--by needs a value');
  assertThrows(() => parseArgs(['--by', '--apply']), UnlinkUsageError, '--by needs a value');
  assertThrows(() => parseArgs(['--name', '!!!']), UnlinkUsageError, '--name needs an ingredient name');
  assertThrows(() => parseArgs(['--name']), UnlinkUsageError, '--name needs an ingredient name');
  assertThrows(() => parseArgs(['--by', 'seed', 'leche']), UnlinkUsageError, 'Unknown argument: leche');
});

Deno.test('run --by: a dry run lists the links and clears nothing', async () => {
  const store = new FakeLinkStore();
  const t = io(store);
  assertEquals(await run(['--by', 'google:gemini-3.8-flash'], t.unlinkIo), 0);
  assertEquals(
    t.out(),
    [
      '2 links made by google:gemini-3.8-flash:',
      '  pepino    -> cucumber  (google:gemini-3.8-flash)',
      '  jitomate  -> tomato  (google:gemini-3.8-flash)',
      '',
      'Dry run: nothing changed. Add --apply to clear them.',
      '',
    ].join('\n'),
  );
  assertEquals(store.clearCalls, []);
  assertEquals(store.rows.length, 4);
});

Deno.test('run --by --apply: clears only that model\'s links', async () => {
  const store = new FakeLinkStore();
  const t = io(store);
  assertEquals(await run(['--by', 'google:gemini-3.8-flash', '--apply'], t.unlinkIo), 0);
  assertStringIncludes(t.out(), 'Cleared 2 links.');
  assertEquals(store.clearCalls, [[['pepino', 'jitomate'], { by: 'google:gemini-3.8-flash', name: null }]]);
  assertEquals(store.rows.map((r) => r.normalized_name), ['leche', 'pepinillo']);
});

Deno.test('run --name --apply: the link on the name and every link to it', async () => {
  const store = new FakeLinkStore();
  const t = io(store);
  assertEquals(await run(['--name', 'Cucumbers', '--apply'], t.unlinkIo), 0);
  assertStringIncludes(t.out(), '2 links on or to "cucumber":');
  assertStringIncludes(t.out(), 'Cleared 2 links.');
  assertEquals(store.rows.map((r) => r.normalized_name), ['leche', 'jitomate']);
});

Deno.test('run --by --name: only links matching both', async () => {
  const store = new FakeLinkStore();
  const t = io(store);
  assertEquals(await run(['--by', 'anthropic:claude-haiku-5-5', '--name', 'cucumber', '--apply'], t.unlinkIo), 0);
  assertStringIncludes(t.out(), '1 link made by anthropic:claude-haiku-5-5, on or to "cucumber":');
  assertStringIncludes(t.out(), 'Cleared 1 link.');
  assertEquals(store.rows.map((r) => r.normalized_name), ['leche', 'pepino', 'jitomate']);
});

Deno.test('run: nothing matching is exit 0 with no change', async () => {
  const store = new FakeLinkStore();
  const t = io(store);
  assertEquals(await run(['--by', 'admin', '--apply'], t.unlinkIo), 0);
  assertEquals(t.out(), 'No links made by admin.\n');
  assertEquals(store.clearCalls, []);
});

Deno.test('run: without SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY is exit 2', async () => {
  const t = io(undefined, { SUPABASE_URL: 'http://127.0.0.1:55321' });
  assertEquals(await run(['--by', 'seed'], t.unlinkIo), 2);
  assertStringIncludes(t.err(), 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
});

Deno.test('run: a database error is exit 2 with the message', async () => {
  const store = new FakeLinkStore();
  store.findLinks = () => Promise.reject(new Error('permission denied'));
  const t = io(store);
  assertEquals(await run(['--by', 'seed'], t.unlinkIo), 2);
  assertEquals(t.err(), 'Unlink failed: permission denied\n');
});

Deno.test('run: bad usage is exit 2 with usage; --help is exit 0', async () => {
  const bad = io(new FakeLinkStore());
  assertEquals(await run([], bad.unlinkIo), 2);
  assertStringIncludes(bad.err(), 'Usage: yarn ai:unlink');
  const help = io();
  assertEquals(await run(['-h'], help.unlinkIo), 0);
  assertStringIncludes(help.out(), 'Lists what it would clear');
});
