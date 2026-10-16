// Categories, the ingredient catalog cache, household overrides and custom aisles, and the user's
// aisle order (spec 4.3). Local reads and writes. Custom categories, overrides and order write
// through the sync helpers (outbox, spec 7.1); the catalog is local here and pull fills it.
import { and, eq, inArray, isNull, like, ne, notInArray, or, sql } from 'drizzle-orm';

import { categories, db, householdCategoryOverrides, ingredients, userCategoryOrder } from '@/db';
import { orderCategories, type IngredientStatus } from '@/domain/category-resolver';
import { fingerprint } from '@/domain/fingerprint';
import { positionBetween, positionForMove } from '@/domain/position';
import { rankCatalog } from '@/domain/suggestion-rank';
import { COUNT_KEY } from '@/domain/usual-unit';
import { hasFeature } from '@/features/plans/features';
import { getDeviceSetting, setDeviceSetting } from '@/features/settings/device-settings';
import { currentLanguage, i18n } from '@/i18n';
import { aisleName, systemAisleSlug, withAisleNames } from '@/i18n/vocabulary';
import { newId } from '@/lib/id';
import type { Exec } from '@/sync/clock';
import { insertRow, updateRows, upsertRow } from '@/sync/mutate';
import {
  familyKey,
  normalizeIngredientName,
  SEED_INGREDIENTS,
  SEED_INGREDIENTS_ES,
  seedEntries,
  seedEsEntries,
  SYSTEM_CATEGORIES,
} from '@/shared';

// --- Seed ----------------------------------------------------------------------------------

/** Changes whenever the bundled seed does (names, categories, units or links), so an app update re-applies it. */
const SEED_FINGERPRINT = fingerprint([SYSTEM_CATEGORIES, SEED_INGREDIENTS, SEED_INGREDIENTS_ES]);
export const SEED_KEY = 'catalog.seedFingerprint';

/**
 * Loads the bundled system categories and the English and Spanish seed ingredients (spec 6.2,
 * 4.15) into the local catalog, as the seed migration does on the server. Cheap when already
 * loaded. Seed rows never overwrite an ingredient the server categorized, but every seed name gets
 * its language where it has none, and the Spanish seed's links replace any but an admin's. Seed
 * rows the seed has dropped are deleted unless this device uses them (spec 6.2).
 */
export function loadCatalogSeed(): void {
  if (getDeviceSetting(SEED_KEY, 0) === SEED_FINGERPRINT) return;
  const slugToId = new Map<string, string>(SYSTEM_CATEGORIES.map((c) => [c.slug, c.id]));
  db.transaction((tx) => {
    SYSTEM_CATEGORIES.forEach((c, rank) => {
      tx.insert(categories)
        .values({ id: c.id, slug: c.slug, name: c.name, householdId: null, defaultRank: rank })
        .onConflictDoUpdate({ target: categories.id, set: { slug: c.slug, name: c.name, defaultRank: rank } })
        .run();
    });
    const seeds = [
      ...seedEntries().map((e) => ({ ...e, lang: 'en' as const, sameAs: null })),
      ...seedEsEntries().map((e) => ({ ...e, lang: 'es' as const })),
    ];
    // English first, so a Spanish name's target is already there.
    for (const { name: displayName, category, unit, lang } of seeds) {
      const row = {
        normalizedName: normalizeIngredientName(displayName),
        displayName,
        defaultCategoryId: slugToId.get(category)!,
        status: 'categorized' as const,
        isGroceryItem: true,
        categorizedBy: 'seed',
        defaultUnit: unit,
        lang,
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
    // Rows the seed doesn't own still learn their language: one statement per language.
    for (const lang of ['en', 'es'] as const) {
      const keys = JSON.stringify(seeds.filter((e) => e.lang === lang).map((e) => normalizeIngredientName(e.name)));
      tx.update(ingredients)
        .set({ lang })
        .where(and(isNull(ingredients.lang), sql`${ingredients.normalizedName} in (select value from json_each(${keys}))`))
        .run();
    }
    const linked = seeds.filter((e) => e.sameAs !== null).map((e) => normalizeIngredientName(e.name));
    // A seed link the seed no longer lists goes, as on the server.
    tx.update(ingredients)
      .set({ sameAs: null, linkedBy: null })
      .where(and(eq(ingredients.linkedBy, 'seed'), notInArray(ingredients.normalizedName, linked)))
      .run();
    for (const { name, sameAs } of seeds) {
      if (sameAs === null) continue;
      tx.update(ingredients)
        .set({ sameAs: normalizeIngredientName(sameAs), linkedBy: 'seed' })
        .where(
          and(
            eq(ingredients.normalizedName, normalizeIngredientName(name)),
            or(isNull(ingredients.linkedBy), ne(ingredients.linkedBy, 'admin')),
          ),
        )
        .run();
    }
    // A seed row the seed no longer lists goes, as the prune migration does on the server: only
    // while the seed still owns it, nothing on this device uses it and nothing that stays links to
    // it. Pull never deletes, so this is how a pruned name leaves the phone. Twice: a Spanish row
    // that goes first frees the English row it linked to.
    const allKeys = JSON.stringify(seeds.map((e) => normalizeIngredientName(e.name)));
    for (let pass = 0; pass < 2; pass++) {
      tx.run(sql`
        delete from ingredients
        where categorized_by = 'seed'
          and normalized_name not in (select value from json_each(${allKeys}))
          and normalized_name not in (select ingredient_name from list_items)
          and normalized_name not in (select ingredient_name from recipe_ingredients)
          and normalized_name not in (select ingredient_name from ingredient_usage)
          and normalized_name not in (select ingredient_name from ingredient_unit_usage)
          and normalized_name not in (select ingredient_name from household_category_overrides)
          and normalized_name not in (select ingredient_name from household_staples)
          and normalized_name not in (select same_as from ingredients where same_as is not null)
      `);
    }
  });
  setDeviceSetting(SEED_KEY, SEED_FINGERPRINT);
}

// --- Pending ingredients (spec 4.3.1, 6.3) -------------------------------------------------

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Records an ingredient name the catalog doesn't know yet as `pending`, so it can be sent for
 * categorization. Leaves an existing row (seed, categorized, pending or failed) alone. Returns
 * true when it added a row, so the caller can send that name to `categorizePending`. Without the
 * plan's `categorize` (spec 4.12) the row gets the default unit `count`, since no answer will bring one.
 */
export function ensureLocalIngredient(tx: Tx, normalizedName: string, displayName: string): boolean {
  return (
    tx
      .insert(ingredients)
      .values({ normalizedName, displayName, status: 'pending', defaultUnit: pendingDefaultUnit() })
      .onConflictDoNothing()
      .run().changes > 0
  );
}

/** The default unit for a new pending row: `count` without `categorize`, else none until it's categorized. */
function pendingDefaultUnit(): string | null {
  return hasFeature('categorize') ? null : COUNT_KEY;
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
    insert into ingredients (normalized_name, display_name, status, default_unit)
    select used.ingredient_name, min(used.display_name), 'pending', ${pendingDefaultUnit()}
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

/**
 * A household, or several: a list or recipe uses its own household's custom aisles, the aisle
 * order screen every household's the user is in.
 */
export type Households = string | readonly string[];

/**
 * System categories plus the custom ones of `households` (spec 4.3.2), each with the user's
 * position (if any). The order is the user's own (4.3.3).
 */
export function categoriesQuery(userId: string, households: Households) {
  const householdIds = typeof households === 'string' ? [households] : [...households];
  return db
    .select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      defaultRank: categories.defaultRank,
      householdId: categories.householdId,
      position: userCategoryOrder.position,
    })
    .from(categories)
    .leftJoin(
      userCategoryOrder,
      and(eq(userCategoryOrder.categoryId, categories.id), eq(userCategoryOrder.userId, userId)),
    )
    .where(or(isNull(categories.householdId), inArray(categories.householdId, householdIds)));
}
export type CategoryRow = Awaited<ReturnType<typeof categoriesQuery>>[number];

/**
 * The categories of `households`, in the user's order (spec 4.3.3), system aisles named in the
 * app's language (4.15).
 */
export function getOrderedCategories(userId: string, households: Households): CategoryRow[] {
  return orderCategories(withAisleNames(categoriesQuery(userId, households).all()));
}

/**
 * Writes a position for every category the user hasn't placed yet, keeping the current order,
 * so a move only ever needs one more write. Returns the categories in order.
 */
function placeAll(userId: string, households: Households): CategoryRow[] {
  const ordered = getOrderedCategories(userId, households);
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

/**
 * Moves the category at `from` to `to` in the user's order. The indexes are into the categories of
 * `households`, as the aisle order screen shows them.
 */
export function moveCategory(userId: string, households: Households, from: number, to: number): void {
  if (from === to) return;
  const ordered = placeAll(userId, households);
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

/**
 * "New aisle...": a custom category for the household (every member gets it), at the end of this
 * user's order. A name the household already has returns that one instead: a system aisle's
 * English or Spanish name ignoring case and accents (spec 4.15: `Lácteos` is Dairy & Eggs), or one
 * of its own in any case.
 */
export function createCategory(userId: string, householdId: string, name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (!trimmed) throw new Error(i18n.t('errors.categoryNeedsName'));
  const all = getOrderedCategories(userId, householdId);
  const slug = systemAisleSlug(trimmed);
  const existing =
    (slug && all.find((c) => c.slug === slug)) || all.find((c) => c.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) return existing.id;
  const ordered = placeAll(userId, householdId);
  const id = newId();
  db.transaction((tx) => {
    insertRow(tx, categories, { id, name: trimmed, householdId });
    insertRow(tx, userCategoryOrder, {
      userId,
      categoryId: id,
      position: positionBetween(ordered.at(-1)?.position ?? null, null),
    });
  });
  return id;
}

// --- Overrides (spec 4.3.2) ----------------------------------------------------------------
// Keyed by the ingredient's family key (spec 4.15), so `leche` and `milk` share one override.

/**
 * The family key of an ingredient in the local catalog: its `sameAs`, else its own key (also for a name the
 * catalog doesn't know).
 */
export function localFamilyKey(tx: Exec, ingredientName: string): string {
  const row = tx.select({ sameAs: ingredients.sameAs }).from(ingredients).where(eq(ingredients.normalizedName, ingredientName)).get();
  return familyKey(ingredientName, row?.sameAs);
}

/**
 * Moves an ingredient, and every name linked with it, to a category for everyone in the household,
 * on every list. `tx`: the caller's transaction.
 */
export function setCategoryOverride(householdId: string, ingredientName: string, categoryId: string, tx: Exec = db): void {
  const key = localFamilyKey(tx, ingredientName);
  upsertRow(tx, householdCategoryOverrides, { householdId, ingredientName: key, categoryId }, { categoryId });
}

/**
 * "Reset to default", for the whole household. Writes a null category rather than deleting the
 * row, so it syncs like any other change: the later of two conflicting changes wins (7.3).
 */
export function clearCategoryOverride(householdId: string, ingredientName: string, tx: Exec = db): void {
  const key = localFamilyKey(tx, ingredientName);
  upsertRow(tx, householdCategoryOverrides, { householdId, ingredientName: key, categoryId: null }, { categoryId: null });
}

/** An ingredient's category in a household, and the household's override for its family (null: the default). */
export function getIngredientCategory(
  householdId: string,
  ingredientName: string,
): { defaultCategoryId: string | null; overrideCategoryId: string | null; status: IngredientStatus | null } {
  const row = db
    .select({ defaultCategoryId: ingredients.defaultCategoryId, status: ingredients.status, sameAs: ingredients.sameAs })
    .from(ingredients)
    .where(eq(ingredients.normalizedName, ingredientName))
    .get();
  const override = db
    .select({ categoryId: householdCategoryOverrides.categoryId })
    .from(householdCategoryOverrides)
    .where(
      and(
        eq(householdCategoryOverrides.householdId, householdId),
        eq(householdCategoryOverrides.ingredientName, familyKey(ingredientName, row?.sameAs)),
      ),
    )
    .get();
  return {
    defaultCategoryId: row?.defaultCategoryId ?? null,
    overrideCategoryId: override?.categoryId ?? null,
    status: row?.status ?? null,
  };
}

/**
 * The aisle each ingredient shows under in a household (its override, else the default). Ingredients still sorting,
 * or unknown, are left out.
 */
export function ingredientAisles(
  householdId: string,
  ingredientNames: readonly string[],
): Map<string, { slug: string | null; name: string }> {
  const out = new Map<string, { slug: string | null; name: string }>();
  if (ingredientNames.length === 0) return out;
  const byId = new Map(
    db.select({ id: categories.id, slug: categories.slug, name: categories.name }).from(categories).all().map((c) => [c.id, c]),
  );
  for (const name of ingredientNames) {
    const { defaultCategoryId, overrideCategoryId } = getIngredientCategory(householdId, name);
    const category = byId.get(overrideCategoryId ?? defaultCategoryId ?? '');
    if (category) out.set(name, { slug: category.slug, name: aisleName(category) });
  }
  return out;
}

// --- Catalog search (autocomplete, spec 4.2) -----------------------------------------------

/**
 * Catalog ingredients whose name starts with `prefix`, or has a word that does, in `rankCatalog`'s order: names in
 * `language` (the app's, spec 4.15) first.
 */
export function searchCatalog(
  prefix: string,
  limit: number,
  language: string = currentLanguage(),
): { key: string; displayName: string }[] {
  const p = prefix.trim().toLowerCase().replace(/[%_]/g, '');
  if (!p) return [];
  const matches = db
    .select({ key: ingredients.normalizedName, displayName: ingredients.displayName, lang: ingredients.lang })
    .from(ingredients)
    .where(
      and(
        eq(ingredients.isGroceryItem, true),
        or(like(ingredients.displayName, `${p}%`), like(ingredients.displayName, `% ${p}%`)),
      ),
    )
    .all();
  return rankCatalog(matches, p, language, limit).map(({ key, displayName }) => ({ key, displayName }));
}
