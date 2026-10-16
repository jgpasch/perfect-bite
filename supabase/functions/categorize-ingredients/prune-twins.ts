// `yarn ai:prune-twins`: deletes the unlinked twins the categorizer made before a model-made twin
// was always a link (spec 4.15, 6.4). A dry run unless --apply. Runs against whichever database
// SUPABASE_URL names, with the service role; the user runs it against hosted.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const USAGE = `Usage: yarn ai:prune-twins [--apply]

Lists unlinked model-made twins (spec 4.15): catalog rows a model categorized, with a language,
no link of their own, no link to them, household_count 0 and no ingredient_households row.
Deletes them only with --apply.

Options:
  --apply      Delete them
  -h, --help   Show this help

Seed and admin rows are never listed: the seed may still have unlinked Spanish names. A row a
list, staple or override still uses is kept.

Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, e.g. against hosted:
  SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<key> yarn ai:prune-twins`;

export type PruneArgs = { apply: boolean; help: boolean };

export class PruneUsageError extends Error {
  override name = 'PruneUsageError';
}

/** Pure: argv (without the script) → options. Throws PruneUsageError on a bad flag. */
export function parseArgs(argv: readonly string[]): PruneArgs {
  const args: PruneArgs = { apply: false, help: false };
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') args.help = true;
    else if (arg === '--apply') args.apply = true;
    else throw new PruneUsageError(`Unknown argument: ${arg}`);
  }
  return args;
}

export type CatalogRow = {
  normalized_name: string;
  lang: string | null;
  same_as: string | null;
  categorized_by: string | null;
  household_count: number;
};

/** `categorized_by` values that aren't a model. */
const NOT_A_MODEL = ['seed', 'admin'];

export function isModelMade(categorizedBy: string | null): boolean {
  return categorizedBy !== null && !NOT_A_MODEL.includes(categorizedBy);
}

/**
 * Pure: the rows to prune, by key. A row a model categorized, with a language, no `same_as`, not a
 * link's target (`targets`), household_count 0 and no ingredient_households row (`used`).
 */
export function unlinkedTwins(rows: readonly CatalogRow[], targets: ReadonlySet<string>, used: ReadonlySet<string>): CatalogRow[] {
  return rows
    .filter(
      (r) =>
        isModelMade(r.categorized_by) &&
        r.lang !== null &&
        r.same_as === null &&
        r.household_count === 0 &&
        !targets.has(r.normalized_name) &&
        !used.has(r.normalized_name),
    )
    .toSorted((a, b) => a.normalized_name.localeCompare(b.normalized_name));
}

/** `ingredients` as the script sees it. prune-twins.ts implements it with the service role. */
export interface PruneStore {
  /** Unlinked, unused model rows with a language; may include link targets and used names. */
  findCandidates(): Promise<CatalogRow[]>;
  /** The keys some row's `same_as` points at. */
  linkTargets(): Promise<Set<string>>;
  /** The keys among `names` with an ingredient_households row. */
  usedNames(names: readonly string[]): Promise<Set<string>>;
  /**
   * Deletes these rows, only while they're still unlinked, unused and a model's. A row something
   * still references (a list item, an override, a link made since) is kept, not an error.
   */
  deleteTwins(names: readonly string[]): Promise<{ deleted: number; kept: string[] }>;
}

/** PostgREST's default row cap; pages are read at this size. */
const PAGE = 1000;
/** Names per request, to keep the URL short. */
const CHUNK = 200;
/** foreign_key_violation: something still references the row. */
const FK_VIOLATION = '23503';

export function createPruneStore(admin: SupabaseClient): PruneStore {
  const notAModel = `(${NOT_A_MODEL.join(',')})`;

  return {
    async findCandidates() {
      const rows: CatalogRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await admin
          .from('ingredients')
          .select('normalized_name, lang, same_as, categorized_by, household_count')
          .is('same_as', null)
          .not('lang', 'is', null)
          .not('categorized_by', 'is', null)
          .not('categorized_by', 'in', notAModel)
          .eq('household_count', 0)
          .order('normalized_name')
          .range(from, from + PAGE - 1);
        if (error) throw error;
        rows.push(...(data as CatalogRow[]));
        if (data.length < PAGE) return rows;
      }
    },

    async linkTargets() {
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
        if (data.length < PAGE) return targets;
      }
    },

    async usedNames(names) {
      const used = new Set<string>();
      for (let i = 0; i < names.length; i += CHUNK) {
        const { data, error } = await admin
          .from('ingredient_households')
          .select('ingredient_name')
          .in('ingredient_name', names.slice(i, i + CHUNK));
        if (error) throw error;
        for (const r of data as { ingredient_name: string }[]) used.add(r.ingredient_name);
      }
      return used;
    },

    async deleteTwins(names) {
      const remove = async (batch: readonly string[]) => {
        const { data, error } = await admin
          .from('ingredients')
          .delete()
          .in('normalized_name', batch)
          .is('same_as', null)
          .eq('household_count', 0)
          .not('categorized_by', 'in', notAModel)
          .select('normalized_name');
        if (error?.code === FK_VIOLATION) return null;
        if (error) throw error;
        return (data as { normalized_name: string }[]).map((r) => r.normalized_name);
      };

      const deleted = new Set<string>();
      for (let i = 0; i < names.length; i += CHUNK) {
        const batch = names.slice(i, i + CHUNK);
        const gone = await remove(batch);
        if (gone) {
          for (const n of gone) deleted.add(n);
          continue;
        }
        // One row in the batch is still referenced: delete one at a time and keep that one.
        for (const n of batch) for (const g of (await remove([n])) ?? []) deleted.add(g);
      }
      return { deleted: deleted.size, kept: names.filter((n) => !deleted.has(n)) };
    },
  };
}

export type PruneIo = {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Reads an env var. Defaults to `Deno.env.get`. */
  env?: (key: string) => string | undefined;
  /** Tests inject a fake; otherwise built from SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. */
  store?: PruneStore;
};

/** Runs the command. Returns the exit code: 0 done (or nothing to do), 2 bad usage, no database, or an error. */
export async function run(argv: readonly string[], io: PruneIo): Promise<number> {
  let args: PruneArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof PruneUsageError)) throw err;
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
    store = createPruneStore(createClient(url, key, { auth: { persistSession: false } }));
  }

  try {
    const candidates = await store.findCandidates();
    const targets = await store.linkTargets();
    const used = await store.usedNames(candidates.map((r) => r.normalized_name));
    const rows = unlinkedTwins(candidates, targets, used);
    if (rows.length === 0) {
      io.out('No unlinked model-made twins.');
      return 0;
    }
    const width = Math.max(...rows.map((r) => [...r.normalized_name].length));
    io.out(`${rows.length} unlinked model-made twin${rows.length === 1 ? '' : 's'}:`);
    for (const r of rows) io.out(`  ${r.normalized_name.padEnd(width)}  ${r.lang}  (${r.categorized_by})`);
    if (!args.apply) {
      io.out('\nDry run: nothing changed. Add --apply to delete them.');
      return 0;
    }
    const { deleted, kept } = await store.deleteTwins(rows.map((r) => r.normalized_name));
    io.out(`\nDeleted ${deleted} twin${deleted === 1 ? '' : 's'}.`);
    if (kept.length > 0) io.out(`Kept ${kept.length} still in use or changed meanwhile: ${kept.join(', ')}`);
    return 0;
  } catch (err) {
    io.err(`Prune failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    return 2;
  }
}

if (import.meta.main) {
  const code = await run(Deno.args, { out: (text) => console.log(text), err: (text) => console.error(text) });
  Deno.exit(code);
}
