// Sends pending ingredient names to the `categorize-ingredients` Edge Function (spec 6.1, 6.3) and
// writes the answers to the local catalog. No timers or cron: each add sends its own names, and a
// catch-up run (launch, foreground, reconnect) retries whatever is still pending or failed. Every
// plan categorizes (spec 4.12).
import { and, asc, eq, inArray, ne } from 'drizzle-orm';

import { db, ingredients } from '@/db';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import { OTHER_CATEGORY_ID } from '@/shared';
import type { Exec } from '@/sync/clock';

/** The function's own input limit. */
export const MAX_NAMES_PER_REQUEST = 100;

/**
 * `categorized_by` for rows the server answered. The response doesn't say which model did it; the
 * server row has that, and sync (M5) brings it down.
 */
export const CATEGORIZED_BY_SERVER = 'server';

export type CategorizeResult = {
  status: 'pending' | 'categorized' | 'failed';
  category_id: string | null;
  is_grocery_item: boolean | null;
  /** A `unit_key`; absent from servers older than the default unit. */
  default_unit?: string | null;
  /** The name's language and link (spec 4.15); absent from servers older than linked ingredients. */
  lang?: 'en' | 'es' | null;
  same_as?: string | null;
  linked_by?: string | null;
};

/** A translation's row the server created or linked for this request (spec 4.15). */
export type TwinResult = CategorizeResult & { display_name: string };

let catchUp: Promise<void> | null = null;

/**
 * Categorizes `names` (normalized) in one request. With no argument, it's the catch-up run: up to
 * 100 local `pending` and `failed` names, at most one run in flight. Never throws; on any failure
 * (including 429 `rate_limited` and `daily_limit`, the user's safety limits, spec 4.12) the names
 * stay as they are, for the next catch-up.
 */
export function categorizePending(names?: readonly string[]): Promise<void> {
  if (names) return send(names);
  catchUp ??= send(catchUpNames()).finally(() => {
    catchUp = null;
  });
  return catchUp;
}

/** Local names still waiting for a category, for the catch-up run. */
export function catchUpNames(): string[] {
  return db
    .select({ name: ingredients.normalizedName })
    .from(ingredients)
    .where(inArray(ingredients.status, ['pending', 'failed']))
    .orderBy(asc(ingredients.normalizedName))
    .limit(MAX_NAMES_PER_REQUEST)
    .all()
    .map((r) => r.name);
}

async function send(names: readonly string[]): Promise<void> {
  if (names.length === 0 || !isSupabaseConfigured) return;
  try {
    const { data: auth } = await supabase.auth.getSession();
    if (!auth.session) return;
    const { data, error } = await supabase.functions.invoke('categorize-ingredients', { body: { names } });
    if (error) throw error;
    const body = data as { results?: unknown; twins?: unknown } | null;
    const results = body?.results;
    if (!results || typeof results !== 'object') throw new Error('categorize-ingredients: no results');
    const twins = body?.twins && typeof body.twins === 'object' ? (body.twins as Record<string, TwinResult>) : {};
    applyResults(results as Record<string, CategorizeResult>, db, twins);
  } catch (e) {
    console.warn('Categorization failed; names stay pending', e);
  }
}

/**
 * Writes the server's answers to local `ingredients` rows in one transaction. `pending` answers
 * change nothing; a `failed` answer goes to Other. Rows already categorized locally keep their
 * category, and overrides live in their own table, so they are never touched. A categorized answer
 * also brings the name's language and link (spec 4.15), as pull would. `twins`, the translations'
 * rows the server created or linked, are added to the catalog (or have their link updated), so a
 * name typed in the other language is known offline. `exec`: the caller's transaction.
 */
export function applyResults(
  results: Record<string, CategorizeResult>,
  exec: Exec = db,
  twins: Record<string, TwinResult> = {},
): void {
  exec.transaction((tx) => {
    for (const [name, r] of Object.entries(results)) {
      if (r.status !== 'categorized' && r.status !== 'failed') continue;
      const categorized = r.status === 'categorized';
      tx.update(ingredients)
        .set({
          status: r.status,
          defaultCategoryId: (categorized && r.category_id) || OTHER_CATEGORY_ID,
          isGroceryItem: r.is_grocery_item,
          categorizedBy: categorized ? CATEGORIZED_BY_SERVER : null,
          defaultUnit: (categorized && r.default_unit) || null,
        })
        .where(and(eq(ingredients.normalizedName, name), ne(ingredients.status, 'categorized')))
        .run();
      if (categorized) applyLink(tx, name, r);
    }
    for (const [name, r] of Object.entries(twins)) {
      if (r.status !== 'categorized' || typeof r.display_name !== 'string' || !r.display_name) continue;
      tx.insert(ingredients)
        .values({
          normalizedName: name,
          displayName: r.display_name,
          status: 'categorized',
          defaultCategoryId: r.category_id || OTHER_CATEGORY_ID,
          isGroceryItem: r.is_grocery_item,
          categorizedBy: CATEGORIZED_BY_SERVER,
          defaultUnit: r.default_unit || null,
        })
        .onConflictDoNothing()
        .run();
      applyLink(tx, name, r);
    }
  });
}

/** Copies the server's `lang`, `same_as` and `linked_by` onto a local row, when the answer has them. */
function applyLink(tx: Exec, name: string, r: CategorizeResult): void {
  if (!('same_as' in r)) return;
  tx.update(ingredients)
    .set({ lang: r.lang ?? null, sameAs: r.same_as ?? null, linkedBy: r.linked_by ?? null })
    .where(eq(ingredients.normalizedName, name))
    .run();
}
