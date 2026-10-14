import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import type { Unit } from '../shared/quantity-parser';
import type { RecipeTags } from '../shared/recipe-tags';
import type { Mutation } from '../sync/mutation';

/** Each synced field's HLC from its last write (spec 7.3), kept by `src/sync/mutate.ts`. */
export type FieldClock = Record<string, string>;
const fieldClock = () =>
  text('field_clock', { mode: 'json' }).$type<FieldClock>().notNull().default(sql`'{}'`);

/**
 * Per-device key/value settings that never sync, e.g. each list's last view mode (spec 4.6).
 * Values are JSON. Household data and per-user settings get their own tables (M1, M2).
 */
export const deviceSettings = sqliteTable('device_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
});

// --- Catalog (spec 5, 7.4) -----------------------------------------------------------------
// Global tables, cached on the device: the bundled seed now, plus server rows from M6.

/**
 * System categories (`household_id` null, from the seed and the server) and households' custom ones
 * (spec 4.3.2): every member of a household has its custom aisles.
 */
export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),
  /** e.g. 'produce'; null for custom categories. */
  slug: text('slug').unique(),
  name: text('name').notNull(),
  /** The household a custom category belongs to; null for system ones. */
  householdId: text('household_id').references(() => households.id),
  /** Default store-walk order for system categories. */
  defaultRank: integer('default_rank'),
  /** Custom categories only; system ones come from the seed and the server. */
  fieldClock: fieldClock(),
});

export const ingredients = sqliteTable('ingredients', {
  normalizedName: text('normalized_name').primaryKey(),
  displayName: text('display_name').notNull(),
  /** null while pending. */
  defaultCategoryId: text('default_category_id').references(() => categories.id),
  status: text('status', { enum: ['pending', 'categorized', 'failed'] })
    .notNull()
    .default('pending'),
  isGroceryItem: integer('is_grocery_item', { mode: 'boolean' }),
  categorizedBy: text('categorized_by'),
  /**
   * How the item is usually bought (spec 4.2): a `unit_key` (a unit, or `count`), from the seed or
   * the categorizer. The usual unit until the household has its own history; null when unknown.
   */
  defaultUnit: text('default_unit'),
});

// --- Per-user aisle order (spec 4.3.3). Never shared with the household. --------------------

export const userCategoryOrder = sqliteTable(
  'user_category_order',
  {
    userId: text('user_id').notNull(),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id),
    position: real('position').notNull(),
    fieldClock: fieldClock(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.categoryId] })],
);

// --- Household data (spec 5) ---------------------------------------------------------------
// Mirrors the Postgres tables so M5 sync can push rows as they are. Ids are client-generated
// UUIDv7. Deletes are soft (`deleted_at`) so they can be undone and synced. Every write goes
// through `src/sync/mutate.ts`, which keeps `field_clock` and appends to the outbox. Pulled rows
// take the server's `created_at` and the later `updated_at` (`src/sync/pull.ts`).

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
  fieldClock: fieldClock(),
};

const deletedAt = integer('deleted_at', { mode: 'timestamp_ms' });

export const households = sqliteTable('households', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ...timestamps,
});

export const lists = sqliteTable(
  'lists',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    name: text('name').notNull(),
    emoji: text('emoji'),
    /**
     * The list's colour (spec 4.1): an aisle hue key, null for Default. Shared by the household.
     * Read it through `listHue`, so a hue from a newer app version shows as Default.
     */
    color: text('color'),
    position: real('position').notNull(),
    archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
    deletedAt,
    ...timestamps,
  },
  (t) => [index('lists_household_idx').on(t.householdId)],
);

export const listItems = sqliteTable(
  'list_items',
  {
    id: text('id').primaryKey(),
    listId: text('list_id')
      .notNull()
      .references(() => lists.id),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    /** Ingredient key (`normalizeIngredientName`). M2 adds the local ingredient catalog. */
    ingredientName: text('ingredient_name').notNull(),
    /** What the user typed or said, without the amount. */
    displayName: text('display_name').notNull(),
    note: text('note'),
    checkedAt: integer('checked_at', { mode: 'timestamp_ms' }),
    checkedBy: text('checked_by'),
    addedBy: text('added_by'),
    deletedAt,
    ...timestamps,
  },
  (t) => [
    index('list_items_list_idx').on(t.listId),
    // At most one live unchecked item per ingredient per list (spec 5, 4.4).
    uniqueIndex('one_open_item_per_ingredient')
      .on(t.listId, t.ingredientName)
      .where(sql`${t.deletedAt} is null and ${t.checkedAt} is null`),
  ],
);

/** Recipes belong to the household (spec 4.5). */
export const recipes = sqliteTable(
  'recipes',
  {
    id: text('id').primaryKey(),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    name: text('name').notNull(),
    notes: text('notes'),
    sourceUrl: text('source_url'),
    /** Spec 4.14. Null = never tagged. Slugs this app doesn't know are kept. */
    tags: text('tags', { mode: 'json' }).$type<RecipeTags>(),
    /** A person has edited the tags (hides "Tagged when you imported it"). */
    tagsEdited: integer('tags_edited', { mode: 'boolean' }).notNull().default(false),
    totalMinutes: integer('total_minutes'),
    /** Method steps in order (spec 5). Null = none. */
    steps: text('steps', { mode: 'json' }).$type<string[]>(),
    servings: integer('servings'),
    /** The site's own photo URL, loaded remotely; we store no image. */
    imageUrl: text('image_url'),
    /** Set by the server to whoever inserted it; never sent (spec 5). */
    addedBy: text('added_by'),
    deletedAt,
    ...timestamps,
  },
  (t) => [index('recipes_household_idx').on(t.householdId)],
);

export const recipeIngredients = sqliteTable(
  'recipe_ingredients',
  {
    id: text('id').primaryKey(),
    recipeId: text('recipe_id')
      .notNull()
      .references(() => recipes.id),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    ingredientName: text('ingredient_name').notNull(),
    displayName: text('display_name').notNull(),
    quantity: real('quantity'),
    unit: text('unit').$type<Unit>(),
    note: text('note'),
    position: real('position').notNull(),
    deletedAt,
    ...timestamps,
  },
  (t) => [index('recipe_ingredients_recipe_idx').on(t.recipeId)],
);

/** An item's amounts: one row per add (spec 4.4). Quantity lives here, not on the item. */
export const listItemContributions = sqliteTable(
  'list_item_contributions',
  {
    id: text('id').primaryKey(),
    listItemId: text('list_item_id')
      .notNull()
      .references(() => listItems.id),
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    source: text('source', { enum: ['manual', 'recipe', 'siri'] })
      .notNull()
      .default('manual'),
    /** Set when source = 'recipe'; null once the recipe is deleted ("no recipe", spec 4.5). */
    recipeId: text('recipe_id').references(() => recipes.id),
    /** null = unspecified. */
    quantity: real('quantity'),
    unit: text('unit').$type<Unit>(),
    addedBy: text('added_by'),
    deletedAt,
    ...timestamps,
  },
  (t) => [index('list_item_contributions_item_idx').on(t.listItemId)],
);

/**
 * The household's ingredient history, for autocomplete (spec 4.2). One row per ingredient key.
 * Outlives list items and recipes: deleting an item doesn't forget that the household buys it.
 * `use_count` syncs as a counter (spec 7.1).
 */
export const ingredientUsage = sqliteTable(
  'ingredient_usage',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    /** Ingredient key (`normalizeIngredientName`). */
    ingredientName: text('ingredient_name').notNull(),
    /** The most recent text the household typed for it. */
    displayName: text('display_name').notNull(),
    useCount: integer('use_count').notNull().default(0),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }).notNull(),
    /** Set by "Remove from suggestions"; cleared by the next use. */
    hiddenAt: integer('hidden_at', { mode: 'timestamp_ms' }),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.householdId, t.ingredientName] })],
);

/**
 * The units the household buys each ingredient in (spec 4.2, 4.4). One row per ingredient and unit.
 * Its own table so sync merges `use_count` as a plain counter; `usualUnit` picks from these rows.
 */
export const ingredientUnitUsage = sqliteTable(
  'ingredient_unit_usage',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    /** Ingredient key (`normalizeIngredientName`). */
    ingredientName: text('ingredient_name').notNull(),
    /** A `Unit`, or `'count'` for a quantity with no unit (`unitKey`). */
    unitKey: text('unit_key').notNull(),
    useCount: integer('use_count').notNull().default(0),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }).notNull(),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.householdId, t.ingredientName, t.unitKey] })],
);

/**
 * The household's aisle for an ingredient (spec 4.3.2), on every list. `category_id` null is "the
 * default": Reset to default writes null rather than deleting the row, so the later change wins (7.3).
 */
export const householdCategoryOverrides = sqliteTable(
  'household_category_overrides',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    /** Ingredient key (`normalizeIngredientName`). */
    ingredientName: text('ingredient_name').notNull(),
    categoryId: text('category_id').references(() => categories.id),
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.householdId, t.ingredientName] })],
);

/**
 * The household's staples, "Always have": ingredients left off when a recipe is added to a list.
 * Unmarking sets `deleted_at`; marking again clears it, so the later change wins (7.3).
 */
export const householdStaples = sqliteTable(
  'household_staples',
  {
    householdId: text('household_id')
      .notNull()
      .references(() => households.id),
    /** Ingredient key (`normalizeIngredientName`). */
    ingredientName: text('ingredient_name').notNull(),
    /** Who marked it; set by the server, never sent. */
    createdBy: text('created_by'),
    deletedAt,
    ...timestamps,
  },
  (t) => [primaryKey({ columns: [t.householdId, t.ingredientName] })],
);

/** Per-user settings (spec 5). Synced in M5. */
export const userSettings = sqliteTable('user_settings', {
  userId: text('user_id').primaryKey(),
  defaultListId: text('default_list_id').references(() => lists.id),
  fieldClock: fieldClock(),
});

// --- Sync (spec 7.1) -----------------------------------------------------------------------

/**
 * Mutations waiting to be pushed, oldest first. Each is appended in the same transaction as the
 * local write it describes (`src/sync/mutate.ts`); the push drains them in `id` order.
 */
export const outbox = sqliteTable(
  'outbox',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** The household the row belongs to; null for per-user tables. Lets a lost membership drop its mutations (spec 7.2). */
    householdId: text('household_id'),
    /** The wire mutation (`Mutation` in `src/sync/mutation.ts`). */
    mutation: text('mutation', { mode: 'json' }).$type<Mutation>().notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    /** Set when the server rejected the mutation for good (`src/sync/push.ts`); the push skips it from then on. */
    rejectedAt: integer('rejected_at', { mode: 'timestamp_ms' }),
    /** Why it was rejected: the SQLSTATE (or HTTP status) and message. */
    error: text('error', { mode: 'json' }).$type<{ code: string; message: string }>(),
  },
  (t) => [index('outbox_household_idx').on(t.householdId)],
);

// --- Recipe import (spec 4.10) -------------------------------------------------------------

/** Why a shared recipe didn't import: `ImportRecipeError['error']` in `src/features/recipes/import.ts`. */
export type FailedImportReason = 'not_a_recipe' | 'offline' | 'rate_limited' | 'blocked' | 'not_entitled' | 'failed';

/** Shares that won't import, shown on the Recipes tab until retried or dismissed. Device-only, never synced. */
export const failedImports = sqliteTable('failed_imports', {
  id: text('id').primaryKey(),
  url: text('url').notNull(),
  /** The page title Safari captured; null when the share had none. */
  title: text('title'),
  reason: text('reason').$type<FailedImportReason>().notNull(),
  /**
   * Where the share was going (spec 4.10), so Try again goes there too: a list (and its household),
   * or a household alone for a recipe-only share. Both null on rows recorded before targets were
   * kept, which retry into the default list. No foreign keys: the household or list may be gone.
   */
  householdId: text('household_id'),
  listId: text('list_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type Category = typeof categories.$inferSelect;
export type FailedImport = typeof failedImports.$inferSelect;
export type Household = typeof households.$inferSelect;
export type IngredientUnitUsage = typeof ingredientUnitUsage.$inferSelect;
export type IngredientUsage = typeof ingredientUsage.$inferSelect;
export type List = typeof lists.$inferSelect;
export type OutboxRow = typeof outbox.$inferSelect;
export type ListItem = typeof listItems.$inferSelect;
export type ListItemContribution = typeof listItemContributions.$inferSelect;
export type Recipe = typeof recipes.$inferSelect;
export type RecipeIngredient = typeof recipeIngredients.$inferSelect;
