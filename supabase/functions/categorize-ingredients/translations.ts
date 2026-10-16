// `yarn ai:translations`: exports the links a model made as a CSV for a person to review (spec
// 4.15), most-used names first, and with --mark-reviewed stamps the rows of a reviewed export so the
// next one leaves them out. Runs against whichever database SUPABASE_URL names, with the service
// role; the user runs it against hosted.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { csvField } from '../../../src/i18n/review-export.ts';

export const USAGE = `Usage: yarn ai:translations [--out <path>] [--since <YYYY-MM-DD>] [--all] [--unpaired] [--limit N]
       yarn ai:translations --mark-reviewed <csv> [--apply]

Writes a CSV of the links a model made (spec 4.15; linked_by not seed or admin), one row per pair:
the English and Spanish keys and names, linked_by, the aisle, the unit, household_count (the larger
of the two), created_at (the newer row's) and an empty notes column, most-used first. Only pairs
where neither name has been reviewed, unless --all.

Options:
  --out <path>            Where to write it (default exports/translations-<date>.csv)
  --since <YYYY-MM-DD>    Only links made on or after this day (UTC)
  --all                   Include reviewed names too
  --unpaired              Add grocery names a model categorized that have no link, to spot missed ones
  --limit N               At most N rows
  --mark-reviewed <csv>   Set reviewed_at on every name in a reviewed export (both rows of a pair).
                          Prints the count and changes nothing unless --apply
  --apply                 With --mark-reviewed: mark them
  -h, --help              Show this help

The names were typed by real households: keep exports out of git (exports/ is ignored).

Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, e.g. against hosted:
  SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<key> yarn ai:translations`;

export type TranslationsArgs = {
  out: string | null;
  since: string | null;
  all: boolean;
  unpaired: boolean;
  limit: number | null;
  markReviewed: string | null;
  apply: boolean;
  help: boolean;
};

export class TranslationsUsageError extends Error {
  override name = 'TranslationsUsageError';
}

/** A real calendar day as YYYY-MM-DD. */
function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** Pure: argv (without the script) → options. Throws TranslationsUsageError on a bad flag. */
export function parseArgs(argv: readonly string[]): TranslationsArgs {
  const args: TranslationsArgs = { out: null, since: null, all: false, unpaired: false, limit: null, markReviewed: null, apply: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    /** The flag's value, from `--flag value` or `--flag=value`. */
    const value = (flag: string, example: string) => {
      const v = (arg === flag ? argv[++i] : arg.slice(flag.length + 1))?.trim() ?? '';
      if (!v || (arg === flag && v.startsWith('-'))) throw new TranslationsUsageError(`${flag} needs a value, e.g. ${flag} ${example}`);
      return v;
    };
    const is = (flag: string) => arg === flag || arg.startsWith(`${flag}=`);

    if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else if (arg === '--all') {
      args.all = true;
    } else if (arg === '--unpaired') {
      args.unpaired = true;
    } else if (arg === '--apply') {
      args.apply = true;
    } else if (is('--out')) {
      args.out = value('--out', 'exports/review.csv');
    } else if (is('--since')) {
      const v = value('--since', '2026-10-01');
      if (!isDay(v)) throw new TranslationsUsageError(`--since needs a day as YYYY-MM-DD, not ${v}`);
      args.since = v;
    } else if (is('--limit')) {
      const v = value('--limit', '100');
      if (!/^\d+$/.test(v) || Number(v) < 1) throw new TranslationsUsageError(`--limit needs a whole number above 0, not ${v}`);
      args.limit = Number(v);
    } else if (is('--mark-reviewed')) {
      args.markReviewed = value('--mark-reviewed', 'exports/translations-2026-10-15.csv');
    } else {
      throw new TranslationsUsageError(`Unknown argument: ${arg}`);
    }
  }
  if (args.help) return args;
  if (args.markReviewed !== null) {
    const exportFlags = [args.out !== null && '--out', args.since !== null && '--since', args.all && '--all', args.unpaired && '--unpaired', args.limit !== null && '--limit'].filter(Boolean);
    if (exportFlags.length > 0) throw new TranslationsUsageError(`--mark-reviewed can't be combined with ${exportFlags.join(', ')}.`);
  } else if (args.apply) {
    throw new TranslationsUsageError('--apply only goes with --mark-reviewed.');
  }
  return args;
}

/** A catalog row as the script reads it; `aisle` is its category's slug. */
export type CatalogRow = {
  normalized_name: string;
  display_name: string;
  lang: string | null;
  same_as: string | null;
  linked_by: string | null;
  aisle: string | null;
  default_unit: string | null;
  household_count: number;
  created_at: string;
  reviewed_at: string | null;
};

/** `linked_by` and `categorized_by` values that aren't a model. */
export const NOT_A_MODEL = ['seed', 'admin'];

export type TranslationRow = {
  english_key: string;
  english_name: string;
  spanish_key: string;
  spanish_name: string;
  linked_by: string;
  aisle: string;
  unit: string;
  household_count: number;
  created_at: string;
};

export const HEADER = [
  'english_key',
  'english_name',
  'spanish_key',
  'spanish_name',
  'linked_by',
  'aisle',
  'unit',
  'household_count',
  'created_at',
  'notes',
] as const;

export type ExportOptions = { since: string | null; all: boolean; limit: number | null };

/**
 * Pure: the export's rows. One per model-made link in `links` whose target is in `targets`, the
 * linked (non-English) row on the Spanish side, plus one per name in `unpaired` with its twin's
 * columns empty (Spanish names on the Spanish side, the rest on the English). The aisle and unit
 * are the English row's, else the Spanish row's. Seed and admin links are left out; so are names
 * already reviewed (either row of a pair) unless `all`, and links made before `since` (the newer
 * row's created_at, UTC). Most-used first, then by key; at most `limit`.
 */
export function translationRows(
  links: readonly CatalogRow[],
  targets: ReadonlyMap<string, CatalogRow>,
  unpaired: readonly CatalogRow[],
  { since, all, limit }: ExportOptions,
): TranslationRow[] {
  const sinceTime = since === null ? null : new Date(`${since}T00:00:00Z`).getTime();
  const keep = (rows: readonly CatalogRow[], createdAt: string) =>
    (all || rows.every((r) => r.reviewed_at === null)) && (sinceTime === null || new Date(createdAt).getTime() >= sinceTime);
  const newer = (a: string, b: string) => (new Date(a).getTime() >= new Date(b).getTime() ? a : b);

  const rows: TranslationRow[] = [];
  for (const spanish of links) {
    if (spanish.same_as === null || spanish.linked_by === null || NOT_A_MODEL.includes(spanish.linked_by)) continue;
    const english = targets.get(spanish.same_as);
    if (!english) continue;
    const createdAt = newer(spanish.created_at, english.created_at);
    if (!keep([spanish, english], createdAt)) continue;
    rows.push({
      english_key: english.normalized_name,
      english_name: english.display_name,
      spanish_key: spanish.normalized_name,
      spanish_name: spanish.display_name,
      linked_by: spanish.linked_by,
      aisle: english.aisle ?? spanish.aisle ?? '',
      unit: english.default_unit ?? spanish.default_unit ?? '',
      household_count: Math.max(spanish.household_count, english.household_count),
      created_at: createdAt,
    });
  }
  for (const r of unpaired) {
    if (r.same_as !== null || !keep([r], r.created_at)) continue;
    const own = { key: r.normalized_name, name: r.display_name };
    const none = { key: '', name: '' };
    const [en, es] = r.lang === 'es' ? [none, own] : [own, none];
    rows.push({
      english_key: en.key,
      english_name: en.name,
      spanish_key: es.key,
      spanish_name: es.name,
      linked_by: '',
      aisle: r.aisle ?? '',
      unit: r.default_unit ?? '',
      household_count: r.household_count,
      created_at: r.created_at,
    });
  }

  rows.sort(
    (a, b) =>
      b.household_count - a.household_count ||
      (a.english_key || a.spanish_key).localeCompare(b.english_key || b.spanish_key) ||
      a.spanish_key.localeCompare(b.spanish_key),
  );
  return limit === null ? rows : rows.slice(0, limit);
}

/**
 * The export as CSV: the header, then the rows with an empty notes column, CRLF line ends, and a
 * UTF-8 byte order mark so Excel reads the accents right (like docs/i18n/es-review.csv).
 */
export function translationsCsv(rows: readonly TranslationRow[]): string {
  const lines = [
    [...HEADER],
    ...rows.map((r) => [
      r.english_key,
      r.english_name,
      r.spanish_key,
      r.spanish_name,
      r.linked_by,
      r.aisle,
      r.unit,
      String(r.household_count),
      r.created_at,
      '',
    ]),
  ];
  return `﻿${lines.map((fields) => fields.map(csvField).join(',')).join('\r\n')}\r\n`;
}

/** Pure: RFC 4180 CSV → rows of fields. Quoted fields may hold commas, doubled quotes and line breaks. A leading BOM is dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Pure: the names in a reviewed export, found by its `english_key` and `spanish_key` columns:
 * both rows of each pair, and the one row of an unpaired name. Blank lines are skipped. Throws
 * TranslationsUsageError when either column is missing.
 */
export function reviewedNames(csv: string): { names: string[]; pairs: number; unpaired: number } {
  const [header, ...rows] = parseCsv(csv);
  const enCol = header?.indexOf('english_key') ?? -1;
  const esCol = header?.indexOf('spanish_key') ?? -1;
  if (enCol < 0 || esCol < 0) throw new TranslationsUsageError('The file has no english_key and spanish_key columns: is it an ai:translations export?');
  const names = new Set<string>();
  let pairs = 0;
  let unpaired = 0;
  for (const row of rows) {
    const keys = [row[enCol]?.trim() ?? '', row[esCol]?.trim() ?? ''].filter(Boolean);
    if (keys.length === 2) pairs++;
    else if (keys.length === 1) unpaired++;
    for (const k of keys) names.add(k);
  }
  return { names: [...names], pairs, unpaired };
}

/** `ingredients` as the script sees it. translations.ts implements it with the service role. */
export interface TranslationsStore {
  /** Rows with a link a model made (linked_by not seed or admin). */
  modelLinks(): Promise<CatalogRow[]>;
  /** These rows, by key. */
  rowsByName(names: readonly string[]): Promise<CatalogRow[]>;
  /** Grocery rows a model categorized, with no link of their own and no link to them. */
  unpairedModelRows(): Promise<CatalogRow[]>;
  /** Sets reviewed_at on these rows where it isn't set yet. Returns how many changed. */
  markReviewed(names: readonly string[]): Promise<number>;
}

/** PostgREST's default row cap; pages are read at this size. */
const PAGE = 1000;
/** Names per request, to keep the URL short. */
const CHUNK = 200;

const COLUMNS = 'normalized_name, display_name, lang, same_as, linked_by, default_unit, household_count, created_at, reviewed_at, category:categories(slug)';

/** A row as PostgREST returns it: the category embedded (many-to-one, so an object or null). */
type DbRow = Omit<CatalogRow, 'aisle'> & { category: { slug: string | null } | null };

const toCatalogRow = ({ category, ...r }: DbRow): CatalogRow => ({ ...r, aisle: category?.slug ?? null });

export function createTranslationsStore(admin: SupabaseClient): TranslationsStore {
  const notAModel = `(${NOT_A_MODEL.join(',')})`;

  /** Every page of a query, built fresh per page. */
  // deno-lint-ignore no-explicit-any
  const readAll = async (build: () => any): Promise<CatalogRow[]> => {
    const rows: CatalogRow[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await build().order('normalized_name').range(from, from + PAGE - 1);
      if (error) throw error;
      rows.push(...(data as DbRow[]).map(toCatalogRow));
      if (data.length < PAGE) return rows;
    }
  };

  return {
    modelLinks() {
      return readAll(() => admin.from('ingredients').select(COLUMNS).not('same_as', 'is', null).not('linked_by', 'in', notAModel));
    },

    async rowsByName(names) {
      const rows: CatalogRow[] = [];
      for (let i = 0; i < names.length; i += CHUNK) {
        const { data, error } = await admin.from('ingredients').select(COLUMNS).in('normalized_name', names.slice(i, i + CHUNK));
        if (error) throw error;
        rows.push(...(data as unknown as DbRow[]).map(toCatalogRow));
      }
      return rows;
    },

    async unpairedModelRows() {
      const candidates = await readAll(() =>
        admin
          .from('ingredients')
          .select(COLUMNS)
          .is('same_as', null)
          .eq('is_grocery_item', true)
          .not('categorized_by', 'is', null)
          .not('categorized_by', 'in', notAModel),
      );
      const targets = new Set<string>();
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await admin
          .from('ingredients')
          .select('normalized_name, same_as')
          .not('same_as', 'is', null)
          .order('normalized_name')
          .range(from, from + PAGE - 1);
        if (error) throw error;
        for (const r of data as { same_as: string }[]) targets.add(r.same_as);
        if (data.length < PAGE) break;
      }
      return candidates.filter((r) => !targets.has(r.normalized_name));
    },

    async markReviewed(names) {
      let marked = 0;
      const now = new Date().toISOString();
      for (let i = 0; i < names.length; i += CHUNK) {
        const { data, error } = await admin
          .from('ingredients')
          .update({ reviewed_at: now })
          .in('normalized_name', names.slice(i, i + CHUNK))
          .is('reviewed_at', null)
          .select('normalized_name');
        if (error) throw error;
        marked += data.length;
      }
      return marked;
    },
  };
}

export type TranslationsIo = {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Reads an env var. Defaults to `Deno.env.get`. */
  env?: (key: string) => string | undefined;
  /** Tests inject a fake; otherwise built from SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. */
  store?: TranslationsStore;
  /** Writes the export, making its folder. Defaults to the file system. */
  writeFile?: (path: string, text: string) => Promise<void>;
  /** Reads a reviewed export. Defaults to the file system. */
  readFile?: (path: string) => Promise<string>;
  /** Today as YYYY-MM-DD, for the default file name. Defaults to the local date. */
  today?: () => string;
};

async function writeToDisk(path: string, text: string) {
  const slash = path.lastIndexOf('/');
  if (slash > 0) await Deno.mkdir(path.slice(0, slash), { recursive: true });
  await Deno.writeTextFile(path, text);
}

function localDay(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Runs the command. Returns the exit code: 0 done (or nothing to do), 2 bad usage, no database, or an error. */
export async function run(argv: readonly string[], io: TranslationsIo): Promise<number> {
  let args: TranslationsArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof TranslationsUsageError)) throw err;
    io.err(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    io.out(USAGE);
    return 0;
  }

  let store = io.store;
  if (!store) {
    const env = io.env ?? ((key: string) => Deno.env.get(key));
    const url = env('SUPABASE_URL')?.trim();
    const key = env('SUPABASE_SERVICE_ROLE_KEY')?.trim();
    if (!url || !key) {
      io.err(`SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.\n\n${USAGE}`);
      return 2;
    }
    store = createTranslationsStore(createClient(url, key, { auth: { persistSession: false } }));
  }

  if (args.markReviewed !== null) {
    let reviewed: ReturnType<typeof reviewedNames>;
    try {
      reviewed = reviewedNames(await (io.readFile ?? Deno.readTextFile)(args.markReviewed));
    } catch (err) {
      io.err(`Can't read ${args.markReviewed}: ${err instanceof Error ? err.message : String(err)}`);
      return 2;
    }
    const { names, pairs, unpaired } = reviewed;
    io.out(`${args.markReviewed}: ${plural(pairs, 'pair')} and ${plural(unpaired, 'unpaired name')}, ${plural(names.length, 'name')} in all.`);
    if (names.length === 0) return 0;
    if (!args.apply) {
      io.out('Dry run: nothing changed. Add --apply to mark them reviewed.');
      return 0;
    }
    try {
      const marked = await store.markReviewed(names);
      io.out(`Marked ${plural(marked, 'name')} reviewed (the rest were already reviewed or aren't in the catalog).`);
      return 0;
    } catch (err) {
      io.err(`Marking failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
      return 2;
    }
  }

  try {
    const links = await store.modelLinks();
    const targetNames = [...new Set(links.flatMap((r) => (r.same_as === null ? [] : [r.same_as])))];
    const targets = new Map((await store.rowsByName(targetNames)).map((r) => [r.normalized_name, r]));
    const unpaired = args.unpaired ? await store.unpairedModelRows() : [];
    const rows = translationRows(links, targets, unpaired, { since: args.since, all: args.all, limit: args.limit });
    const path = args.out ?? `exports/translations-${(io.today ?? localDay)()}.csv`;
    await (io.writeFile ?? writeToDisk)(path, translationsCsv(rows));
    io.out(`Wrote ${plural(rows.length, 'row')} to ${path}.`);
    return 0;
  } catch (err) {
    io.err(`Export failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    return 2;
  }
}

if (import.meta.main) {
  const code = await run(Deno.args, { out: (text) => console.log(text), err: (text) => console.error(text) });
  Deno.exit(code);
}
