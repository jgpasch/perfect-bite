// Categories, the ingredient catalog cache, and per-user overrides and order (spec 4.3).
// Local reads and writes. Per-user tables (custom categories, order, overrides) write through the
// sync helpers (outbox, spec 7.1); the catalog is local here and M6 fills it from the server.
import { and, asc, eq, isNull, like, or, sql } from 'drizzle-orm';

import { categories, db, ingredients, userCategoryOrder, userCategoryOverrides } from '@/db';
import { orderCategories, type IngredientStatus } from '@/domain/category-resolver';
import { positionBetween, positionForMove } from '@/domain/position';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { newId } from '@/lib/id';
import type { Exec } from '@/sync/clock';
import { deleteRows, insertRow, updateRows, upsertRow } from '@/sync/mutate';
import { normalizeIngredientName, SEED_INGREDIENTS, SYSTEM_CATEGORIES } from '@/shared';

// --- Seed ----------------------------------------------------------------------------------

/** Changes whenever the bundled seed does, so an app update re-applies it. */
const SEED_FINGERPRINT = JSON.stringify([SYSTEM_CATEGORIES, SEED_INGREDIENTS]).length;
const SEED_KEY = 'catalog.seedFingerprint';

/**
 * Loads the bundled system categories and seed ingredients (spec 6.2) into the local catalog.
 * Cheap when already loaded. Seed rows never overwrite an ingredient the server categorized.
 */
export function loadCatalogSeed(): void {
  if (getDeviceSetting(SEED_KEY, 0) === SEED_FINGERPRINT) return;
  const slugToId = new Map<string, string>(SYSTEM_CATEGORIES.map((c) => [c.slug, c.id]));
  db.transaction((tx) => {
    SYSTEM_CATEGORIES.forEach((c, rank) => {
      tx.insert(categories)
        .values({ id: c.id, slug: c.slug, name: c.name, ownerUserId: null, defaultRank: rank })
        .onConflictDoUpdate({ target: categories.id, set: { slug: c.slug, name: c.name, defaultRank: rank } })
        .run();
    });
    for (const [slug, names] of Object.entries(SEED_INGREDIENTS)) {
      for (const displayName of names) {
        const row = {
          normalizedName: normalizeIngredientName(displayName),
          displayName,
          defaultCategoryId: slugToId.get(slug)!,
          status: 'categorized' as const,
          isGroceryItem: true,
          categorizedBy: 'seed',
        };
        tx.insert(ingredients)
          .values(row)
          .onConflictDoUpdate({
            target: ingredients.normalizedName,
            set: row,
            setWhere: or(eq(ingredients.categorizedBy, 'seed'), sql`${ingredients.status} <> 'categorized'`),
          })
          .run();
      }
    }
  });
  setDeviceSetting(SEED_KEY, SEED_FINGERPRINT);
}

// --- Pending ingredients (spec 4.3.1, 6.3) -------------------------------------------------

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Records an ingredient name the catalog doesn't know yet as `pending`, so it can be sent for
 * categorization. Leaves an existing row (seed, categorized, pending or failed) alone. Returns
 * true when it added a row, so the caller can send that name to `categorizePending`.
 */
export function ensureLocalIngredient(tx: Tx, normalizedName: string, displayName: string): boolean {
  return (
    tx.insert(ingredients).values({ normalizedName, displayName, status: 'pending' }).onConflictDoNothing().run()
      .changes > 0
  );
}

/** The new pending names across several add results, once each, in order (one request per bulk add). */
export function collectPendingNames(results: readonly ({ pendingNames: readonly string[] } | null)[]): string[] {
  return [...new Set(results.flatMap((r) => r?.pendingNames ?? []))];
}

/**
 * Adds a pending row for every name used by a live list item or recipe ingredient that has no
 * catalog row (items added before pending rows existed). Idempotent.
 */
export function ensureMissingIngredients(): void {
  db.run(sql`
    insert into ingredients (normalized_name, display_name, status)
    select used.ingredient_name, min(used.display_name), 'pending'
    from (
      select ingredient_name, display_name from list_items where deleted_at is null
      union all
      select ri.ingredient_name, ri.display_name
      from recipe_ingredients ri join recipes r on r.id = ri.recipe_id
      where ri.deleted_at is null and r.deleted_at is null
    ) as used
    where used.ingredient_name not in (select normalized_name from ingredients)
    group by used.ingredient_name
    on conflict do nothing
  `);
}

// --- Categories and order ------------------------------------------------------------------

/** System categories plus the user's custom ones, each with the user's position (if any). */
export function categoriesQuery(userId: string) {
  return db
    .select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      defaultRank: categories.defaultRank,
      ownerUserId: categories.ownerUserId,
      position: userCategoryOrder.position,
    })
    .from(categories)
    .leftJoin(
      userCategoryOrder,
      and(eq(userCategoryOrder.categoryId, categories.id), eq(userCategoryOrder.userId, userId)),
    )
    .where(or(isNull(categories.ownerUserId), eq(categories.ownerUserId, userId)));
}
export type CategoryRow = Awaited<ReturnType<typeof categoriesQuery>>[number];

/** The user's categories in their order (spec 4.3.3). */
export function getOrderedCategories(userId: string): CategoryRow[] {
  return orderCategories(categoriesQuery(userId).all());
}

/**
 * Writes a position for every category the user hasn't placed yet, keeping the current order,
 * so a move only ever needs one more write. Returns the categories in order.
 */
function placeAll(userId: string): CategoryRow[] {
  const ordered = getOrderedCategories(userId);
  let last: number | null = null;
  db.transaction((tx) => {
    for (const c of ordered) {
      if (c.position === null) {
        c.position = positionBetween(last, null);
        insertRow(tx, userCategoryOrder, { userId, categoryId: c.id, position: c.position });
      }
      last = c.position;
    }
  });
  return ordered;
}

/** Moves the category at `from` to `to` in the user's order. */
export function moveCategory(userId: string, from: number, to: number): void {
  if (from === to) return;
  const ordered = placeAll(userId);
  if (!ordered[from]) return;
  const position = positionForMove(
    ordered.map((c) => c.position!),
    from,
    to,
  );
  updateRows(
    db,
    userCategoryOrder,
    and(eq(userCategoryOrder.userId, userId), eq(userCategoryOrder.categoryId, ordered[from].id)),
    { position },
  );
}

/** "New category...": a custom category for this user, at the end of their order. */
export function createCategory(userId: string, name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (!trimmed) throw new Error('A category needs a name');
  const existing = getOrderedCategories(userId).find((c) => c.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) return existing.id;
  const ordered = placeAll(userId);
  const id = newId();
  db.transaction((tx) => {
    insertRow(tx, categories, { id, name: trimmed, ownerUserId: userId });
    insertRow(tx, userCategoryOrder, {
      userId,
      categoryId: id,
      position: positionBetween(ordered.at(-1)?.position ?? null, null),
    });
  });
  return id;
}

// --- Overrides (spec 4.3.2) ----------------------------------------------------------------

/** Moves an ingredient to a category for this user only, on every list. `tx`: the caller's transaction. */
export function setCategoryOverride(userId: string, ingredientName: string, categoryId: string, tx: Exec = db): void {
  upsertRow(tx, userCategoryOverrides, { userId, ingredientName, categoryId }, { categoryId });
}

/** "Reset to default". */
export function clearCategoryOverride(userId: string, ingredientName: string, tx: Exec = db): void {
  deleteRows(
    tx,
    userCategoryOverrides,
    and(eq(userCategoryOverrides.userId, userId), eq(userCategoryOverrides.ingredientName, ingredientName)),
  );
}

/** An ingredient's category for this user, and whether it is their override. */
export function getIngredientCategory(
  userId: string,
  ingredientName: string,
): { defaultCategoryId: string | null; overrideCategoryId: string | null; status: IngredientStatus | null } {
  const row = db
    .select({ defaultCategoryId: ingredients.defaultCategoryId, status: ingredients.status })
    .from(ingredients)
    .where(eq(ingredients.normalizedName, ingredientName))
    .get();
  const override = db
    .select({ categoryId: userCategoryOverrides.categoryId })
    .from(userCategoryOverrides)
    .where(and(eq(userCategoryOverrides.userId, userId), eq(userCategoryOverrides.ingredientName, ingredientName)))
    .get();
  return {
    defaultCategoryId: row?.defaultCategoryId ?? null,
    overrideCategoryId: override?.categoryId ?? null,
    status: row?.status ?? null,
  };
}

/**
 * The aisle each ingredient shows under for this user (their override, else the default), for the
 * autocomplete panel's dot and short name. Ingredients still sorting, or unknown, are left out.
 */
export function ingredientAisles(
  userId: string | null,
  ingredientNames: readonly string[],
): Map<string, { slug: string | null; name: string }> {
  const out = new Map<string, { slug: string | null; name: string }>();
  if (ingredientNames.length === 0) return out;
  const byId = new Map(
    db.select({ id: categories.id, slug: categories.slug, name: categories.name }).from(categories).all().map((c) => [c.id, c]),
  );
  for (const name of ingredientNames) {
    // Signed out there are no overrides; '' matches none.
    const { defaultCategoryId, overrideCategoryId } = getIngredientCategory(userId ?? '', name);
    const category = byId.get(overrideCategoryId ?? defaultCategoryId ?? '');
    if (category) out.set(name, { slug: category.slug, name: category.name });
  }
  return out;
}

// --- Catalog search (autocomplete, spec 4.2) -----------------------------------------------

/** Catalog ingredients whose name starts with `prefix`, or has a word that does. */
export function searchCatalog(prefix: string, limit: number): { key: string; displayName: string }[] {
  const p = prefix.trim().toLowerCase().replace(/[%_]/g, '');
  if (!p) return [];
  return db
    .select({ key: ingredients.normalizedName, displayName: ingredients.displayName })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.isGroceryItem, true),
        or(like(ingredients.displayName, `${p}%`), like(ingredients.displayName, `% ${p}%`)),
      ),
    )
    // Whole-name prefix matches first, then shorter names.
    .orderBy(sql`${ingredients.displayName} not like ${`${p}%`}`, sql`length(${ingredients.displayName})`, asc(ingredients.displayName))
    .limit(limit)
    .all();
}
