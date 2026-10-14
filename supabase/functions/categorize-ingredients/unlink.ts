// `yarn ai:unlink --by google:gemini-3.8-flash`: clears ingredient links in bulk (spec 4.15), e.g.
// every link a model made once its links turn out wrong. A dry run unless --apply. Runs against
// whichever database SUPABASE_URL names, with the service role; the user runs it against hosted.
import { normalizeIngredientName } from '@shared/index.ts';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const USAGE = `Usage: yarn ai:unlink (--by <linked_by> | --name <name>) [--apply]

Clears ingredient links (spec 4.15): sets same_as and linked_by to null on every matching row.
Lists what it would clear and changes nothing unless --apply is given.

Options:
  --by <linked_by>  Links made by this: a model id (google:gemini-3.8-flash), seed or admin
  --name <name>     The link on this name and every link to it (normalized as the app does)
  --apply           Clear them
  -h, --help        Show this help

With both --by and --name, only links matching both are cleared. A seed link comes back with the
next seed migration: take it out of src/shared/seed/ingredients-es.ts instead.

Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, e.g. against hosted:
  SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=<key> yarn ai:unlink --by <model>`;

export type UnlinkArgs = { by: string | null; name: string | null; apply: boolean; help: boolean };

export class UnlinkUsageError extends Error {
  override name = 'UnlinkUsageError';
}

/** Pure: argv (without the script) → options. Throws UnlinkUsageError on a bad flag. */
export function parseArgs(argv: readonly string[]): UnlinkArgs {
  const args: UnlinkArgs = { by: null, name: null, apply: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      args.help = true;
    } else if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '--by' || arg.startsWith('--by=')) {
      const value = (arg === '--by' ? argv[++i] : arg.slice('--by='.length))?.trim() ?? '';
      if (!value || (arg === '--by' && value.startsWith('-'))) throw new UnlinkUsageError('--by needs a value, e.g. --by google:gemini-3.8-flash');
      args.by = value;
    } else if (arg === '--name' || arg.startsWith('--name=')) {
      const raw = arg === '--name' ? argv[++i] : arg.slice('--name='.length);
      const value = normalizeIngredientName(raw ?? '');
      if (!value || (arg === '--name' && raw.startsWith('-'))) throw new UnlinkUsageError('--name needs an ingredient name, e.g. --name leche');
      args.name = value;
    } else {
      throw new UnlinkUsageError(`Unknown argument: ${arg}`);
    }
  }
  if (!args.help && args.by === null && args.name === null) throw new UnlinkUsageError('Give --by, --name or both.');
  return args;
}

export type LinkRow = { normalized_name: string; same_as: string; linked_by: string };
export type LinkFilter = { by: string | null; name: string | null };

/** The linked rows of `ingredients`. unlink.ts implements it with the service role. */
export interface LinkStore {
  /** Rows with a link, made by `by` when set, on or to `name` when set. */
  findLinks(filter: LinkFilter): Promise<LinkRow[]>;
  /** Clears these rows' links, only where they still match `filter`. Returns how many were cleared. */
  clearLinks(names: readonly string[], filter: LinkFilter): Promise<number>;
}

/** PostgREST's default row cap; pages are read at this size. */
const PAGE = 1000;
/** Names per update, to keep the URL short. */
const CHUNK = 200;

export function createLinkStore(admin: SupabaseClient): LinkStore {
  /** Every linked row made by `filter.by` (when set) whose `column` is `name` (when given), page by page. */
  const readLinks = async (filter: LinkFilter, match?: { column: 'normalized_name' | 'same_as'; name: string }) => {
    const rows: LinkRow[] = [];
    for (let from = 0; ; from += PAGE) {
      let query = admin.from('ingredients').select('normalized_name, same_as, linked_by').not('same_as', 'is', null);
      if (filter.by !== null) query = query.eq('linked_by', filter.by);
      if (match) query = query.eq(match.column, match.name);
      const { data, error } = await query.order('normalized_name').range(from, from + PAGE - 1);
      if (error) throw error;
      rows.push(...(data as LinkRow[]));
      if (data.length < PAGE) return rows;
    }
  };

  return {
    async findLinks(filter) {
      if (filter.name === null) return readLinks(filter);
      const own = await readLinks(filter, { column: 'normalized_name', name: filter.name });
      const to = await readLinks(filter, { column: 'same_as', name: filter.name });
      return [...own, ...to];
    },

    async clearLinks(names, filter) {
      let cleared = 0;
      for (let i = 0; i < names.length; i += CHUNK) {
        let query = admin
          .from('ingredients')
          .update({ same_as: null, linked_by: null })
          .in('normalized_name', names.slice(i, i + CHUNK))
          .not('same_as', 'is', null);
        if (filter.by !== null) query = query.eq('linked_by', filter.by);
        const { data, error } = await query.select('normalized_name');
        if (error) throw error;
        cleared += data.length;
      }
      return cleared;
    },
  };
}

export type UnlinkIo = {
  out: (text: string) => void;
  err: (text: string) => void;
  /** Reads an env var. Defaults to `Deno.env.get`. */
  env?: (key: string) => string | undefined;
  /** Tests inject a fake; otherwise built from SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. */
  store?: LinkStore;
};

function describeFilter({ by, name }: LinkFilter): string {
  return [by !== null ? `made by ${by}` : null, name !== null ? `on or to "${name}"` : null].filter(Boolean).join(', ');
}

/** Runs the command. Returns the exit code: 0 done (or nothing to do), 2 bad usage, no database, or an error. */
export async function run(argv: readonly string[], io: UnlinkIo): Promise<number> {
  let args: UnlinkArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UnlinkUsageError)) throw err;
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
    store = createLinkStore(createClient(url, key, { auth: { persistSession: false } }));
  }

  const filter: LinkFilter = { by: args.by, name: args.name };
  try {
    const rows = await store.findLinks(filter);
    if (rows.length === 0) {
      io.out(`No links ${describeFilter(filter)}.`);
      return 0;
    }
    const width = Math.max(...rows.map((r) => [...r.normalized_name].length));
    io.out(`${rows.length} link${rows.length === 1 ? '' : 's'} ${describeFilter(filter)}:`);
    for (const r of rows) io.out(`  ${r.normalized_name.padEnd(width)}  -> ${r.same_as}  (${r.linked_by})`);
    if (!args.apply) {
      io.out('\nDry run: nothing changed. Add --apply to clear them.');
      return 0;
    }
    const cleared = await store.clearLinks(rows.map((r) => r.normalized_name), filter);
    io.out(`\nCleared ${cleared} link${cleared === 1 ? '' : 's'}.`);
    return 0;
  } catch (err) {
    io.err(`Unlink failed: ${err instanceof Error ? err.message : JSON.stringify(err)}`);
    return 2;
  }
}

if (import.meta.main) {
  const code = await run(Deno.args, { out: (text) => console.log(text), err: (text) => console.error(text) });
  Deno.exit(code);
}
