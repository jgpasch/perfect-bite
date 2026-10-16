import { assertEquals, assertStringIncludes, assertThrows } from '@std/assert';

import {
  type CatalogRow,
  parseArgs,
  parseCsv,
  reviewedNames,
  run,
  translationRows,
  translationsCsv,
  type TranslationsIo,
  type TranslationsStore,
  TranslationsUsageError,
} from './translations.ts';

const GEMINI = 'google:gemini-3.8-flash';
const HAIKU = 'anthropic:claude-haiku-5-5';

function row(normalized_name: string, fields: Partial<CatalogRow> = {}): CatalogRow {
  return {
    normalized_name,
    display_name: normalized_name,
    lang: 'en',
    same_as: null,
    linked_by: null,
    aisle: 'produce',
    default_unit: 'count',
    household_count: 0,
    created_at: '2026-10-01T12:00:00+00:00',
    reviewed_at: null,
    ...fields,
  };
}

/** `ingredients` in memory, with the real store's filters; `grocery` and `categorizedBy` stand in for the columns the export doesn't print. */
class FakeStore implements TranslationsStore {
  rows: (CatalogRow & { grocery: boolean; categorizedBy: string | null })[] = [];
  marked: string[][] = [];

  add(r: CatalogRow, categorizedBy: string | null = GEMINI, grocery = true) {
    this.rows.push({ ...r, grocery, categorizedBy });
    return this;
  }

  strip = ({ grocery: _g, categorizedBy: _c, ...r }: CatalogRow & { grocery: boolean; categorizedBy: string | null }): CatalogRow => r;

  async modelLinks() {
    return this.rows.filter((r) => r.same_as !== null && !['seed', 'admin'].includes(r.linked_by!)).map(this.strip);
  }

  async rowsByName(names: readonly string[]) {
    return this.rows.filter((r) => names.includes(r.normalized_name)).map(this.strip);
  }

  async unpairedModelRows() {
    const targets = new Set(this.rows.map((r) => r.same_as));
    return this.rows
      .filter((r) => r.same_as === null && r.grocery && r.categorizedBy !== null && !['seed', 'admin'].includes(r.categorizedBy))
      .filter((r) => !targets.has(r.normalized_name))
      .map(this.strip);
  }

  async markReviewed(names: readonly string[]) {
    this.marked.push([...names]);
    let n = 0;
    for (const r of this.rows) {
      if (names.includes(r.normalized_name) && r.reviewed_at === null) {
        r.reviewed_at = '2026-10-15T00:00:00Z';
        n++;
      }
    }
    return n;
  }
}

/**
 * The catalog the run tests share: a model link each way (the Spanish name typed, and the English
 * one), a seed link, an admin link, a reviewed pair, and two unpaired model names.
 */
function catalog() {
  return new FakeStore()
    // Spanish typed first: the model made the English twin, so the English row is newer.
    .add(row('pepino', { lang: 'es', same_as: 'cucumber', linked_by: GEMINI, household_count: 4, created_at: '2026-10-02T09:00:00+00:00' }))
    .add(row('cucumber', { display_name: 'Cucumber', household_count: 1, created_at: '2026-10-02T09:00:01+00:00' }))
    // English typed first: the model made the Spanish twin.
    .add(row('zucchini', { display_name: 'Zucchini', household_count: 9, created_at: '2026-09-20T10:00:00+00:00' }))
    .add(row('calabacita', { lang: 'es', same_as: 'zucchini', linked_by: HAIKU, household_count: 0, created_at: '2026-10-05T10:00:00+00:00' }))
    .add(row('milk', { aisle: 'dairy-eggs', default_unit: 'gal', household_count: 50 }), 'seed')
    .add(row('leche', { lang: 'es', same_as: 'milk', linked_by: 'seed', aisle: 'dairy-eggs', default_unit: 'gal', household_count: 40 }), 'seed')
    .add(row('sugar', { aisle: 'baking', default_unit: 'lb', household_count: 30 }), 'seed')
    .add(row('azucar', { lang: 'es', display_name: 'azúcar', same_as: 'sugar', linked_by: 'admin', household_count: 20 }), 'admin')
    .add(row('beet', { household_count: 2, reviewed_at: '2026-10-10T00:00:00Z' }))
    .add(row('betabel', { lang: 'es', same_as: 'beet', linked_by: GEMINI, household_count: 3, created_at: '2026-10-03T00:00:00+00:00' }))
    .add(row('nopal', { lang: 'es', aisle: null, default_unit: null, household_count: 5, created_at: '2026-10-04T00:00:00+00:00' }))
    .add(row('kale', { display_name: 'Kale', household_count: 2, created_at: '2026-09-01T00:00:00+00:00' }))
    .add(row('dish soap', { household_count: 7 }), GEMINI, false);
}

function io(store?: TranslationsStore, files: Record<string, string> = {}, env: Record<string, string> = {}) {
  let out = '';
  let err = '';
  const written: Record<string, string> = {};
  const translationsIo: TranslationsIo = {
    out: (t) => (out += `${t}\n`),
    err: (t) => (err += `${t}\n`),
    env: (k) => env[k],
    store,
    writeFile: async (path, text) => {
      written[path] = text;
    },
    readFile: async (path) => {
      if (!(path in files)) throw new Error(`No such file: ${path}`);
      return files[path];
    },
    today: () => '2026-10-15',
  };
  return { translationsIo, out: () => out, err: () => err, written };
}

/** The data rows of a written export, as fields. */
const body = (csv: string) => parseCsv(csv).slice(1);

Deno.test('parseArgs: defaults, every export option, = forms and --help', () => {
  assertEquals(parseArgs([]), { out: null, since: null, all: false, unpaired: false, limit: null, markReviewed: null, apply: false, help: false });
  assertEquals(parseArgs(['--out', 'a/b.csv', '--since', '2026-10-01', '--all', '--unpaired', '--limit', '25']), {
    out: 'a/b.csv',
    since: '2026-10-01',
    all: true,
    unpaired: true,
    limit: 25,
    markReviewed: null,
    apply: false,
    help: false,
  });
  assertEquals(parseArgs(['--out=x.csv', '--since=2024-02-29', '--limit=1']).limit, 1);
  assertEquals(parseArgs(['--since=2024-02-29']).since, '2024-02-29');
  assertEquals(parseArgs(['--mark-reviewed', 'r.csv', '--apply']).markReviewed, 'r.csv');
  assertEquals(parseArgs(['--mark-reviewed', 'r.csv', '--apply']).apply, true);
  assertEquals(parseArgs(['-h']).help, true);
});

Deno.test('parseArgs: bad values, --apply alone, --mark-reviewed with export options, unknown flags throw', () => {
  assertThrows(() => parseArgs(['--since', '2026-13-01']), TranslationsUsageError, '--since needs a day as YYYY-MM-DD, not 2026-13-01');
  assertThrows(() => parseArgs(['--since', '2025-02-29']), TranslationsUsageError, 'not 2025-02-29');
  assertThrows(() => parseArgs(['--since', '10/01/2026']), TranslationsUsageError, '--since needs a day');
  assertThrows(() => parseArgs(['--since']), TranslationsUsageError, '--since needs a value');
  assertThrows(() => parseArgs(['--limit', '0']), TranslationsUsageError, '--limit needs a whole number above 0, not 0');
  assertThrows(() => parseArgs(['--limit', '2.5']), TranslationsUsageError, 'not 2.5');
  assertThrows(() => parseArgs(['--limit', '-3']), TranslationsUsageError, '--limit needs a value');
  assertThrows(() => parseArgs(['--out', '--all']), TranslationsUsageError, '--out needs a value');
  assertThrows(() => parseArgs(['--mark-reviewed']), TranslationsUsageError, '--mark-reviewed needs a value');
  assertThrows(() => parseArgs(['--apply']), TranslationsUsageError, '--apply only goes with --mark-reviewed');
  assertThrows(() => parseArgs(['--mark-reviewed', 'r.csv', '--all', '--limit', '3']), TranslationsUsageError, "can't be combined with --all, --limit");
  assertThrows(() => parseArgs(['--json']), TranslationsUsageError, 'Unknown argument: --json');
});

Deno.test('translationRows: a model link each way, the newer created_at, the larger count, the English aisle', () => {
  const links = [
    row('pepino', { lang: 'es', same_as: 'cucumber', linked_by: GEMINI, household_count: 4, aisle: null, created_at: '2026-10-02T09:00:00+00:00' }),
    row('calabacita', { lang: 'es', same_as: 'zucchini', linked_by: HAIKU, household_count: 0, aisle: 'produce', default_unit: 'lb', created_at: '2026-10-05T10:00:00+00:00' }),
  ];
  const targets = new Map([
    ['cucumber', row('cucumber', { display_name: 'Cucumber', household_count: 1, created_at: '2026-10-02T09:00:01+00:00' })],
    ['zucchini', row('zucchini', { display_name: 'Zucchini', aisle: null, default_unit: null, household_count: 9, created_at: '2026-09-20T10:00:00+00:00' })],
  ]);
  assertEquals(translationRows(links, targets, [], { since: null, all: false, limit: null }), [
    {
      english_key: 'zucchini',
      english_name: 'Zucchini',
      spanish_key: 'calabacita',
      spanish_name: 'calabacita',
      linked_by: HAIKU,
      aisle: 'produce',
      unit: 'lb',
      household_count: 9,
      created_at: '2026-10-05T10:00:00+00:00',
    },
    {
      english_key: 'cucumber',
      english_name: 'Cucumber',
      spanish_key: 'pepino',
      spanish_name: 'pepino',
      linked_by: GEMINI,
      aisle: 'produce',
      unit: 'count',
      household_count: 4,
      created_at: '2026-10-02T09:00:01+00:00',
    },
  ]);
});

Deno.test('translationRows: seed and admin links, missing targets and reviewed names are left out; --all keeps reviewed', () => {
  const links = [
    row('leche', { lang: 'es', same_as: 'milk', linked_by: 'seed' }),
    row('azucar', { lang: 'es', same_as: 'sugar', linked_by: 'admin' }),
    row('betabel', { lang: 'es', same_as: 'beet', linked_by: GEMINI }),
    row('ejote', { lang: 'es', same_as: 'green bean', linked_by: GEMINI, reviewed_at: '2026-10-11T00:00:00Z' }),
    row('huerfano', { lang: 'es', same_as: 'gone', linked_by: GEMINI }),
  ];
  const targets = new Map([
    ['milk', row('milk')],
    ['sugar', row('sugar')],
    ['green bean', row('green bean')],
    ['beet', row('beet', { reviewed_at: '2026-10-10T00:00:00Z' })],
  ]);
  assertEquals(translationRows(links, targets, [], { since: null, all: false, limit: null }), []);
  assertEquals(
    translationRows(links, targets, [], { since: null, all: true, limit: null }).map((r) => r.spanish_key),
    ['betabel', 'ejote'],
  );
});

Deno.test('translationRows: --since compares the newer row, inclusive of the day (UTC)', () => {
  const links = [
    row('pepino', { lang: 'es', same_as: 'cucumber', linked_by: GEMINI, created_at: '2026-09-30T23:59:59+00:00' }),
    row('calabacita', { lang: 'es', same_as: 'zucchini', linked_by: GEMINI, created_at: '2026-09-15T00:00:00+00:00' }),
    row('betabel', { lang: 'es', same_as: 'beet', linked_by: GEMINI, created_at: '2026-09-29T00:00:00+00:00' }),
  ];
  const targets = new Map([
    ['cucumber', row('cucumber', { created_at: '2026-09-01T00:00:00+00:00' })],
    ['zucchini', row('zucchini', { created_at: '2026-10-01T00:00:00+00:00' })],
    ['beet', row('beet', { created_at: '2026-09-02T00:00:00+00:00' })],
  ]);
  assertEquals(
    translationRows(links, targets, [], { since: '2026-10-01', all: false, limit: null }).map((r) => r.spanish_key),
    ['calabacita'],
  );
  assertEquals(
    translationRows(links, targets, [], { since: '2026-09-30', all: false, limit: null }).map((r) => r.spanish_key),
    ['pepino', 'calabacita'],
  );
});

Deno.test('translationRows: unpaired names go on their language side, are filtered like pairs, and sort with them', () => {
  const unpaired = [
    row('nopal', { lang: 'es', aisle: null, default_unit: null, household_count: 5 }),
    row('kale', { display_name: 'Kale', household_count: 2 }),
    row('mystery', { lang: null, household_count: 2 }),
    row('seen', { household_count: 99, reviewed_at: '2026-10-10T00:00:00Z' }),
  ];
  const links = [row('pepino', { lang: 'es', same_as: 'cucumber', linked_by: GEMINI, household_count: 3 })];
  const rows = translationRows(links, new Map([['cucumber', row('cucumber')]]), unpaired, { since: null, all: false, limit: null });
  assertEquals(
    rows.map((r) => [r.english_key, r.english_name, r.spanish_key, r.spanish_name, r.linked_by, r.aisle, r.unit, r.household_count]),
    [
      ['', '', 'nopal', 'nopal', '', '', '', 5],
      ['cucumber', 'cucumber', 'pepino', 'pepino', GEMINI, 'produce', 'count', 3],
      ['kale', 'Kale', '', '', '', 'produce', 'count', 2],
      ['mystery', 'mystery', '', '', '', 'produce', 'count', 2],
    ],
  );
  assertEquals(translationRows([], new Map(), unpaired, { since: null, all: false, limit: 2 }).map((r) => r.english_key || r.spanish_key), ['nopal', 'kale']);
});

Deno.test('translationsCsv: BOM, header, CRLF, quoted fields, empty notes', () => {
  const csv = translationsCsv([
    {
      english_key: 'chile',
      english_name: 'Chile, "hot"',
      spanish_key: 'chile picante',
      spanish_name: 'chile picante',
      linked_by: GEMINI,
      aisle: 'produce',
      unit: 'count',
      household_count: 3,
      created_at: '2026-10-02T09:00:00+00:00',
    },
  ]);
  assertEquals(
    csv,
    '﻿english_key,english_name,spanish_key,spanish_name,linked_by,aisle,unit,household_count,created_at,notes\r\n' +
      'chile,"Chile, ""hot""",chile picante,chile picante,google:gemini-3.8-flash,produce,count,3,2026-10-02T09:00:00+00:00,\r\n',
  );
  assertEquals(translationsCsv([]), '﻿english_key,english_name,spanish_key,spanish_name,linked_by,aisle,unit,household_count,created_at,notes\r\n');
});

Deno.test('parseCsv: BOM, quotes, commas and line breaks in fields, LF or CRLF, no final newline', () => {
  assertEquals(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
  assertEquals(parseCsv('a,b\n"two\nlines",\nlast,row'), [['a', 'b'], ['two\nlines', ''], ['last', 'row']]);
  assertEquals(parseCsv(''), []);
});

Deno.test('reviewedNames: both keys of a pair, the one key of an unpaired row, blank lines skipped, columns found by name', () => {
  const csv = '﻿notes,spanish_key,english_key\r\nok,pepino,cucumber\r\n,nopal,\r\n\r\nwrong!,calabacita,zucchini\r\n,,kale\r\n';
  assertEquals(reviewedNames(csv), { names: ['cucumber', 'pepino', 'nopal', 'zucchini', 'calabacita', 'kale'], pairs: 2, unpaired: 2 });
  assertThrows(() => reviewedNames('key,English,Spanish,notes\r\n'), TranslationsUsageError, 'no english_key and spanish_key columns');
  assertThrows(() => reviewedNames(''), TranslationsUsageError, 'no english_key and spanish_key columns');
});

Deno.test('run: exports model links only, most-used first, to the default path', async () => {
  const t = io(catalog());
  assertEquals(await run([], t.translationsIo), 0);
  assertEquals(t.out(), 'Wrote 2 rows to exports/translations-2026-10-15.csv.\n');
  const csv = t.written['exports/translations-2026-10-15.csv'];
  assertEquals(csv.startsWith('﻿english_key,'), true);
  assertEquals(body(csv), [
    ['zucchini', 'Zucchini', 'calabacita', 'calabacita', HAIKU, 'produce', 'count', '9', '2026-10-05T10:00:00+00:00', ''],
    ['cucumber', 'Cucumber', 'pepino', 'pepino', GEMINI, 'produce', 'count', '4', '2026-10-02T09:00:01+00:00', ''],
  ]);
});

Deno.test('run: --unpaired adds unlinked grocery names a model categorized, not errands or seed names', async () => {
  const t = io(catalog());
  assertEquals(await run(['--unpaired', '--out', 'review.csv'], t.translationsIo), 0);
  assertEquals(
    body(t.written['review.csv']).map((r) => [r[0], r[2], r[4], r[7]]),
    [
      ['zucchini', 'calabacita', HAIKU, '9'],
      ['', 'nopal', '', '5'],
      ['cucumber', 'pepino', GEMINI, '4'],
      ['kale', '', '', '2'],
    ],
  );
});

Deno.test('run: --all includes the reviewed pair; --since and --limit narrow it', async () => {
  const all = io(catalog());
  assertEquals(await run(['--all', '--out', 'a.csv'], all.translationsIo), 0);
  assertEquals(body(all.written['a.csv']).map((r) => r[2]), ['calabacita', 'pepino', 'betabel']);

  const since = io(catalog());
  assertEquals(await run(['--since', '2026-10-03', '--all', '--out', 's.csv'], since.translationsIo), 0);
  assertEquals(body(since.written['s.csv']).map((r) => r[2]), ['calabacita', 'betabel']);

  const limited = io(catalog());
  assertEquals(await run(['--limit', '1', '--out', 'l.csv'], limited.translationsIo), 0);
  assertEquals(limited.out(), 'Wrote 1 row to l.csv.\n');
  assertEquals(body(limited.written['l.csv']).map((r) => r[2]), ['calabacita']);
});

Deno.test('run --mark-reviewed: a dry run counts and changes nothing; --apply marks both rows of each pair', async () => {
  const store = catalog();
  const exported = io(store);
  await run(['--unpaired', '--out', 'r.csv'], exported.translationsIo);
  const files = { 'r.csv': exported.written['r.csv'] };

  const dry = io(store, files);
  assertEquals(await run(['--mark-reviewed', 'r.csv'], dry.translationsIo), 0);
  assertEquals(dry.out(), 'r.csv: 2 pairs and 2 unpaired names, 6 names in all.\nDry run: nothing changed. Add --apply to mark them reviewed.\n');
  assertEquals(store.marked, []);

  const apply = io(store, files);
  assertEquals(await run(['--mark-reviewed', 'r.csv', '--apply'], apply.translationsIo), 0);
  assertEquals(store.marked, [['zucchini', 'calabacita', 'nopal', 'cucumber', 'pepino', 'kale']]);
  assertStringIncludes(apply.out(), 'Marked 6 names reviewed');

  // The next export leaves them out.
  const next = io(store);
  assertEquals(await run(['--unpaired', '--out', 'n.csv'], next.translationsIo), 0);
  assertEquals(body(next.written['n.csv']), []);
});

Deno.test('run --mark-reviewed: a missing file or a foreign CSV fails without touching the store', async () => {
  const store = catalog();
  const missing = io(store);
  assertEquals(await run(['--mark-reviewed', 'nope.csv', '--apply'], missing.translationsIo), 2);
  assertStringIncludes(missing.err(), "Can't read nope.csv: No such file: nope.csv");

  const foreign = io(store, { 'es.csv': 'key,English,Spanish,notes\r\ncommon.undo,Undo,Deshacer,\r\n' });
  assertEquals(await run(['--mark-reviewed', 'es.csv', '--apply'], foreign.translationsIo), 2);
  assertStringIncludes(foreign.err(), 'no english_key and spanish_key columns');
  assertEquals(store.marked, []);
});

Deno.test('run: bad usage, --help, no database and a store error', async () => {
  const bad = io(catalog());
  assertEquals(await run(['--apply'], bad.translationsIo), 2);
  assertStringIncludes(bad.err(), '--apply only goes with --mark-reviewed.\n\nUsage: yarn ai:translations');

  const help = io(catalog());
  assertEquals(await run(['--help'], help.translationsIo), 0);
  assertStringIncludes(help.out(), '--mark-reviewed <csv>');

  const noDb = io(undefined, {}, { SUPABASE_URL: 'http://localhost:55321' });
  assertEquals(await run([], noDb.translationsIo), 2);
  assertStringIncludes(noDb.err(), 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');

  const store = catalog();
  store.modelLinks = () => Promise.reject(new Error('connection refused'));
  const failing = io(store);
  assertEquals(await run([], failing.translationsIo), 2);
  assertEquals(failing.err(), 'Export failed: connection refused\n');
  assertEquals(failing.written, {});
});
