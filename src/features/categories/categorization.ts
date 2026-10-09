// Sends pending ingredient names to the `categorize-ingredients` Edge Function (spec 6.1, 6.3) and
// writes the answers to the local catalog. No timers or cron: each add sends its own names, and a
// catch-up run (launch, foreground, reconnect) retries whatever is still pending or failed.
import { and, asc, eq, inArray, ne } from 'drizzle-orm';

import { db, ingredients } from '@/db';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import { OTHER_CATEGORY_ID } from '@/shared';

/** The function's own input limit. */
export const MAX_NAMES_PER_REQUEST = 100;

/**
 * `categorized_by` for rows the server answered. The response doesn't say which model did it; the
 * server row has that, and sync (M5) brings it down.
 */
export const CATEGORIZED_BY_SERVER = 'server';

type CategorizeResult = {
  status: 'pending' | 'categorized' | 'failed';
  category_id: string | null;
  is_grocery_item: boolean | null;
};

let catchUp: Promise<void> | null = null;

/**
 * Categorizes `names` (normalized) in one request. With no argument, it's the catch-up run: up to
 * 100 local `pending` and `failed` names, at most one run in flight. Never throws; on any failure
 * the names stay as they are, for the next catch-up.
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
    const results = (data as { results?: unknown } | null)?.results;
    if (!results || typeof results !== 'object') throw new Error('categorize-ingredients: no results');
    applyResults(results as Record<string, CategorizeResult>);
  } catch (e) {
    console.warn('Categorization failed; names stay pending', e);
  }
}

/**
 * Writes the server's answers to local `ingredients` rows in one transaction. `pending` answers
 * change nothing; a `failed` answer goes to Other. Rows already categorized locally are kept, and
 * overrides live in their own table, so they are never touched.
 */
export function applyResults(results: Record<string, CategorizeResult>): void {
  db.transaction((tx) => {
    for (const [name, r] of Object.entries(results)) {
      if (r.status !== 'categorized' && r.status !== 'failed') continue;
      const categorized = r.status === 'categorized';
      tx.update(ingredients)
        .set({
          status: r.status,
          defaultCategoryId: (categorized && r.category_id) || OTHER_CATEGORY_ID,
          isGroceryItem: r.is_grocery_item,
          categorizedBy: categorized ? CATEGORIZED_BY_SERVER : null,
        })
        .where(and(eq(ingredients.normalizedName, name), ne(ingredients.status, 'categorized')))
        .run();
    }
  });
}
