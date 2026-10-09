import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import type { Unit } from '../shared/quantity-parser';

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

/** System categories (`owner_user_id` null) and the user's custom ones. */
export const categories = sqliteTable('categories', {
  id: text('id').primaryKey(),
  /** e.g. 'produce'; null for custom categories. */
  slug: text('slug').unique(),
  name: text('name').notNull(),
  ownerUserId: text('owner_user_id'),
  /** Default store-walk order for system categories. */
  defaultRank: integer('default_rank'),
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
});

// --- Per-user preferences (spec 4.3.2, 4.3.3). Never shared with the household. ------------

export const userCategoryOverrides = sqliteTable(
  'user_category_overrides',
  {
    userId: text('user_id').notNull(),
    ingredientName: text('ingredient_name').notNull(),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id),
  },
  (t) => [primaryKey({ columns: [t.userId, t.ingredientName] })],
);

export const userCategoryOrder = sqliteTable(
  'user_category_order',
  {
    userId: text('user_id').notNull(),
    categoryId: text('category_id')
      .notNull()
      .references(() => categories.id),
    position: real('position').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.categoryId] })],
);

// --- Household data (spec 5) ---------------------------------------------------------------
// Mirrors the Postgres tables so M5 sync can push rows as they are. Ids are client-generated
// UUIDv7. Deletes are soft (`deleted_at`) so they can be undone now and synced later.
// TODO(M5): field_clock, and server-set timestamps on pull.

const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
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

/** Per-user settings (spec 5). Synced in M5. */
export const userSettings = sqliteTable('user_settings', {
  userId: text('user_id').primaryKey(),
  defaultListId: text('default_list_id').references(() => lists.id),
});

export type Category = typeof categories.$inferSelect;
export type Household = typeof households.$inferSelect;
export type IngredientUsage = typeof ingredientUsage.$inferSelect;
export type List = typeof lists.$inferSelect;
export type ListItem = typeof listItems.$inferSelect;
export type ListItemContribution = typeof listItemContributions.$inferSelect;
export type Recipe = typeof recipes.$inferSelect;
export type RecipeIngredient = typeof recipeIngredients.$inferSelect;
