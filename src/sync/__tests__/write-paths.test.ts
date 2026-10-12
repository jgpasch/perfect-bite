// Each feature write goes through the sync helpers: it enqueues exactly the fields it changed, in
// the same transaction as the write, so a failed write leaves neither (spec 7.1).
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import {
  categories,
  db,
  householdCategoryOverrides,
  households,
  listItemContributions,
  listItems,
  lists,
  recipeIngredients,
  recipes,
} from '@/db';
import {
  clearCategoryOverride,
  createCategory,
  loadCatalogSeed,
  moveCategory,
  setCategoryOverride,
} from '@/features/categories/categories';
import {
  addItem,
  checkItems,
  clearChecked,
  deleteItem,
  DuplicateItemError,
  removeRecipeFromList,
  restoreItems,
  setItemAmount,
  setItemChecked,
  undeleteItem,
  undoAdd,
  updateItem,
} from '@/features/lists/items';
import {
  createList,
  deleteList,
  ensureStarterData,
  getDefaultListId,
  moveList,
  renameList,
  setDefaultList,
  setListArchived,
} from '@/features/lists/lists';
import { hideFromSuggestions } from '@/features/lists/usage';
import { addItemsToRecipe } from '@/features/recipes/from-list';
import {
  addRecipeIngredient,
  createRecipe,
  deleteRecipe,
  deleteRecipeIngredient,
  undeleteRecipeIngredient,
  updateRecipe,
  updateRecipeIngredient,
} from '@/features/recipes/recipes';
import { updateRows } from '@/sync/mutate';
import { resetDb } from '@/test/db';
import { clearOutbox, outboxMutations, outboxPatches, outboxRows } from '@/test/outbox';

jest.mock('@/db/client', () => require('@/test/db'));

const USER = 'user-1';
const ISO = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

let householdId: string;
let listId: string;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  householdId = db.select().from(households).get()!.id;
  listId = getDefaultListId(USER)!;
  clearOutbox();
});

const tables = () => outboxMutations().map((m) => m.table);

describe('households and lists', () => {
  test('first run enqueues the household, its list and the default list setting', () => {
    resetDb();
    ensureStarterData(USER);
    const household = db.select().from(households).get()!;
    const list = db.select().from(lists).get()!;
    expect(outboxPatches()).toEqual([
      { table: 'households', id: household.id, fields: { name: 'Personal', created_at: ISO } },
      {
        table: 'lists',
        id: list.id,
        fields: {
          household_id: household.id,
          name: 'Groceries',
          emoji: null,
          color: null,
          position: 1,
          archived_at: null,
          deleted_at: null,
          created_at: ISO,
        },
      },
      { table: 'user_settings', key: { user_id: USER }, fields: { default_list_id: list.id } },
    ]);
    expect(outboxRows().map((r) => r.householdId)).toEqual([household.id, household.id, null]);
  });

  test('a second run writes nothing', () => {
    ensureStarterData(USER);
    expect(outboxRows()).toEqual([]);
  });

  test('createList enqueues the new list', () => {
    const id = createList('Costco');
    expect(outboxPatches()).toEqual([
      {
        table: 'lists',
        id,
        fields: expect.objectContaining({ household_id: householdId, name: 'Costco', position: 2, deleted_at: null }),
      },
    ]);
  });

  test('rename, archive, delete, move and default each send just their field', () => {
    const other = createList('Costco');
    clearOutbox();

    renameList(listId, '  Weekly ');
    setListArchived(listId, true);
    setListArchived(listId, false);
    deleteList(other);
    setDefaultList(USER, listId);
    const visible = db.select().from(lists).where(eq(lists.id, listId)).all();
    moveList([...visible, { id: 'x', position: 5 }], 0, 1);

    expect(outboxPatches()).toEqual([
      { table: 'lists', id: listId, fields: { name: 'Weekly' } },
      { table: 'lists', id: listId, fields: { archived_at: ISO } },
      { table: 'lists', id: listId, fields: { archived_at: null } },
      { table: 'lists', id: other, fields: { deleted_at: ISO } },
      { table: 'user_settings', key: { user_id: USER }, fields: { default_list_id: listId } },
      { table: 'lists', id: listId, fields: { position: expect.any(Number) } },
    ]);
  });

  test('a blank rename writes nothing', () => {
    renameList(listId, '   ');
    expect(outboxRows()).toEqual([]);
  });

  test('the local clock of each field follows its last write', () => {
    renameList(listId, 'Weekly');
    const rename = outboxMutations()[0];
    const clock = db.select().from(lists).where(eq(lists.id, listId)).get()!.fieldClock;
    expect(clock.name).toBe(rename.hlc);
    expect(clock.position).not.toBe(rename.hlc);
  });
});

describe('list items', () => {
  test('a new item enqueues its usage, unit usage, item and amount', () => {
    const result = addItem(listId, '2 lbs chicken thighs', USER)!;
    expect(outboxPatches()).toEqual([
      {
        table: 'ingredient_usage',
        key: { household_id: householdId, ingredient_name: 'chicken thigh' },
        fields: { display_name: 'chicken thighs', last_used_at: ISO, hidden_at: null, created_at: ISO },
        counters: { use_count: 1 },
      },
      {
        table: 'ingredient_unit_usage',
        key: { household_id: householdId, ingredient_name: 'chicken thigh', unit_key: 'lb' },
        fields: { last_used_at: ISO, created_at: ISO },
        counters: { use_count: 1 },
      },
      {
        table: 'list_items',
        id: result.itemId,
        fields: {
          list_id: listId,
          household_id: householdId,
          ingredient_name: 'chicken thigh',
          display_name: 'chicken thighs',
          note: null,
          checked_at: null,
          checked_by: null,
          added_by: USER,
          deleted_at: null,
          created_at: ISO,
        },
      },
      {
        table: 'list_item_contributions',
        id: result.contributionId,
        fields: {
          list_item_id: result.itemId,
          household_id: householdId,
          source: 'manual',
          recipe_id: null,
          quantity: 2,
          unit: 'lb',
          added_by: USER,
          deleted_at: null,
          created_at: ISO,
        },
      },
    ]);
  });

  test('a Combine enqueues a usage update and the new amount, not the item', () => {
    addItem(listId, 'milk', USER);
    clearOutbox();
    const result = addItem(listId, 'Milk', USER)!;
    expect(result.kind).toBe('combine');
    expect(outboxPatches()).toEqual([
      {
        table: 'ingredient_usage',
        key: { household_id: householdId, ingredient_name: 'milk' },
        fields: { display_name: 'Milk', last_used_at: ISO, hidden_at: null },
        counters: { use_count: 1 },
      },
      {
        table: 'list_item_contributions',
        id: result.contributionId,
        fields: expect.objectContaining({ list_item_id: result.itemId, quantity: null, unit: null }),
      },
    ]);
  });

  test('a reopen deletes the old amounts and unchecks the item', () => {
    const first = addItem(listId, 'milk', USER)!;
    setItemChecked(first.itemId, true, USER);
    clearOutbox();
    const result = addItem(listId, 'milk', USER)!;
    expect(result.kind).toBe('reopen');
    expect(outboxPatches().slice(1)).toEqual([
      { table: 'list_item_contributions', id: first.contributionId, fields: { deleted_at: ISO } },
      { table: 'list_items', id: first.itemId, fields: { checked_at: null, checked_by: null } },
      { table: 'list_item_contributions', id: result.contributionId, fields: expect.objectContaining({ deleted_at: null }) },
    ]);
  });

  test('check, uncheck, delete and undelete send just the fields they change', () => {
    const { itemId } = addItem(listId, 'milk', USER)!;
    clearOutbox();
    setItemChecked(itemId, true, USER);
    setItemChecked(itemId, false, USER);
    deleteItem(itemId);
    undeleteItem(itemId);
    expect(outboxPatches()).toEqual([
      { table: 'list_items', id: itemId, fields: { checked_at: ISO, checked_by: USER } },
      { table: 'list_items', id: itemId, fields: { deleted_at: null, checked_at: null, checked_by: null } },
      { table: 'list_items', id: itemId, fields: { deleted_at: ISO } },
      { table: 'list_items', id: itemId, fields: { deleted_at: null, checked_at: null, checked_by: null } },
    ]);
  });

  test('undo of a new add takes back its use and deletes the amount and item', () => {
    const result = addItem(listId, 'milk', USER)!;
    clearOutbox();
    undoAdd(result);
    expect(outboxPatches()).toEqual([
      {
        table: 'ingredient_usage',
        key: { household_id: householdId, ingredient_name: 'milk' },
        fields: {},
        counters: { use_count: -1 },
      },
      { table: 'list_item_contributions', id: result.contributionId, fields: { deleted_at: ISO } },
      { table: 'list_items', id: result.itemId, fields: { deleted_at: ISO } },
    ]);
  });

  test('checkItems and clearChecked enqueue one mutation per item they touch', () => {
    const a = addItem(listId, 'milk', USER)!.itemId;
    const b = addItem(listId, 'eggs', USER)!.itemId;
    addItem(listId, 'bread', USER);
    clearOutbox();
    checkItems([a, b], USER);
    expect(clearChecked(listId).ids).toHaveLength(2);
    const patches = outboxPatches();
    expect(patches.slice(0, 2).map((p) => [p.id, p.fields])).toEqual(
      expect.arrayContaining([
        [a, { checked_at: ISO, checked_by: USER }],
        [b, { checked_at: ISO, checked_by: USER }],
      ]),
    );
    expect(patches.slice(2).map((p) => [p.id, p.fields])).toEqual(
      expect.arrayContaining([
        [a, { deleted_at: ISO }],
        [b, { deleted_at: ISO }],
      ]),
    );
    expect(patches).toHaveLength(4);
  });

  test("restoreItems enqueues each restored item's deleted_at, and nothing for its amounts", () => {
    const a = addItem(listId, 'milk', USER)!.itemId;
    const b = addItem(listId, 'eggs', USER)!.itemId;
    checkItems([a, b], USER);
    const cleared = clearChecked(listId);
    clearOutbox();
    expect(restoreItems(cleared.ids, cleared.deletedAt)).toBe(2);
    const patches = outboxPatches();
    expect(patches.every((p) => p.table === 'list_items')).toBe(true);
    expect(patches.map((p) => [p.id, p.fields.deleted_at])).toEqual(
      expect.arrayContaining([
        [a, null],
        [b, null],
      ]),
    );
    expect(patches).toHaveLength(2);
  });

  test('editing the name and note leaves the amounts alone', () => {
    const { itemId } = addItem(listId, '2 lb milk', USER)!;
    clearOutbox();
    updateItem(itemId, { name: 'oat milk', amount: '2 lb', note: ' cold ' });
    expect(outboxPatches()).toEqual([
      { table: 'list_items', id: itemId, fields: { display_name: 'oat milk', ingredient_name: 'oat milk', note: 'cold' } },
    ]);
  });

  test("editing the category enqueues the household's override in the same save", () => {
    loadCatalogSeed();
    const { itemId } = addItem(listId, 'milk', USER)!;
    const produce = db.select().from(categories).where(eq(categories.slug, 'produce')).get()!;
    clearOutbox();
    updateItem(itemId, { name: 'milk', amount: '', note: '', categoryId: produce.id });
    updateItem(itemId, { name: 'milk', amount: '', note: '', categoryId: null });
    expect(tables()).toEqual(['list_items', 'household_category_overrides', 'list_items', 'household_category_overrides']);
    const key = { household_id: householdId, ingredient_name: 'milk' };
    const overrides = outboxPatches().filter((p) => p.table === 'household_category_overrides');
    expect(overrides).toEqual([
      { table: 'household_category_overrides', key, fields: { category_id: produce.id } },
      { table: 'household_category_overrides', key, fields: { category_id: null } },
    ]);
    expect(outboxRows().every((r) => r.householdId === householdId)).toBe(true);
  });

  test('a rename onto an open item fails and enqueues nothing', () => {
    addItem(listId, 'milk', USER);
    const { itemId } = addItem(listId, 'eggs', USER)!;
    clearOutbox();
    expect(() => updateItem(itemId, { name: 'milk', amount: '', note: '' })).toThrow(DuplicateItemError);
    expect(outboxRows()).toEqual([]);
  });

  test('an unreadable amount rolls back the rename it came with, mutation included', () => {
    const { itemId } = addItem(listId, 'milk', USER)!;
    clearOutbox();
    expect(() => updateItem(itemId, { name: 'oat milk', amount: 'lots', note: '' })).toThrow("isn't an amount");
    expect(db.select().from(listItems).where(eq(listItems.id, itemId)).get()!.displayName).toBe('milk');
    expect(outboxRows()).toEqual([]);
  });

  test('setting the amount edits the one amount in place', () => {
    const { itemId, contributionId } = addItem(listId, '2 lb milk', USER)!;
    clearOutbox();
    setItemAmount(itemId, { quantity: 3, unit: 'lb' });
    expect(outboxPatches()).toEqual([
      { table: 'list_item_contributions', id: contributionId, fields: { quantity: 3, unit: 'lb' } },
    ]);
  });

  test('removing a recipe from the list deletes its amounts and the items left empty', () => {
    const recipeId = createRecipe('Tacos');
    const { itemId } = addItem(listId, 'tortillas', USER)!;
    addItemsToRecipe(recipeId, [itemId], USER);
    const link = db.select().from(listItemContributions).where(eq(listItemContributions.recipeId, recipeId)).get()!;
    const { itemId: onlyFromRecipe } = addItem(listId, 'salsa', USER)!;
    clearOutbox();
    // salsa's only amount is the recipe's, so it goes; tortillas keeps its typed amount.
    db.transaction((tx) => {
      const typed = tx.select().from(listItemContributions).where(eq(listItemContributions.listItemId, onlyFromRecipe)).get()!;
      tx.update(listItemContributions).set({ recipeId }).where(eq(listItemContributions.id, typed.id)).run();
    });
    const salsaAmount = db.select().from(listItemContributions).where(eq(listItemContributions.listItemId, onlyFromRecipe)).get()!;

    removeRecipeFromList(listId, recipeId);

    const patches = outboxPatches();
    expect(patches.slice(0, 2)).toEqual(
      expect.arrayContaining([
        { table: 'list_item_contributions', id: link.id, fields: { deleted_at: ISO } },
        { table: 'list_item_contributions', id: salsaAmount.id, fields: { deleted_at: ISO } },
      ]),
    );
    expect(patches.slice(2)).toEqual([{ table: 'list_items', id: onlyFromRecipe, fields: { deleted_at: ISO } }]);
  });
});

describe('recipes', () => {
  test('create, edit and delete send the recipe fields they change', () => {
    const id = createRecipe('Tacos');
    updateRecipe(id, { name: 'Fish tacos', notes: '', sourceUrl: ' https://example.com ' });
    deleteRecipe(id);
    expect(outboxPatches()).toEqual([
      {
        table: 'recipes',
        id,
        fields: { household_id: householdId, name: 'Tacos', notes: null, source_url: null, deleted_at: null, created_at: ISO },
      },
      { table: 'recipes', id, fields: { name: 'Fish tacos', notes: null, source_url: 'https://example.com' } },
      { table: 'recipes', id, fields: { deleted_at: ISO } },
    ]);
  });

  test('deleting a recipe unlinks its amounts on lists', () => {
    const recipeId = createRecipe('Tacos');
    const { itemId } = addItem(listId, 'tortillas', USER)!;
    addItemsToRecipe(recipeId, [itemId], USER);
    const link = db.select().from(listItemContributions).where(eq(listItemContributions.recipeId, recipeId)).get()!;
    clearOutbox();
    deleteRecipe(recipeId);
    expect(outboxPatches()).toEqual([
      { table: 'recipes', id: recipeId, fields: { deleted_at: ISO } },
      { table: 'list_item_contributions', id: link.id, fields: { recipe_id: null } },
    ]);
  });

  test('recipe ingredients: add counts a use, edit and delete send their fields', () => {
    const recipeId = createRecipe('Bread');
    clearOutbox();
    const { id } = addRecipeIngredient(recipeId, '2 cups flour')!;
    expect(tables()).toEqual(['recipe_ingredients', 'ingredient_usage', 'ingredient_unit_usage']);
    expect(outboxPatches()[0]).toEqual({
      table: 'recipe_ingredients',
      id,
      fields: {
        recipe_id: recipeId,
        household_id: householdId,
        ingredient_name: 'flour',
        display_name: 'flour',
        quantity: 2,
        unit: 'cup',
        note: null,
        position: expect.any(Number),
        deleted_at: null,
        created_at: ISO,
      },
    });

    clearOutbox();
    updateRecipeIngredient(id, '3 cups flour', 'sifted');
    deleteRecipeIngredient(id);
    undeleteRecipeIngredient(id);
    expect(outboxPatches()).toEqual([
      {
        table: 'recipe_ingredients',
        id,
        fields: { ingredient_name: 'flour', display_name: 'flour', quantity: 3, unit: 'cup', note: 'sifted' },
      },
      { table: 'recipe_ingredients', id, fields: { deleted_at: ISO } },
      { table: 'recipe_ingredients', id, fields: { deleted_at: null } },
    ]);
    expect(db.select().from(recipeIngredients).where(eq(recipeIngredients.id, id)).get()!.quantity).toBe(3);
  });

  test('linking list items to a recipe enqueues the amount-less recipe links', () => {
    const recipeId = createRecipe('Tacos');
    const { itemId } = addItem(listId, 'tortillas', USER)!;
    clearOutbox();
    addItemsToRecipe(recipeId, [itemId], USER);
    const link = outboxPatches().find((p) => p.table === 'list_item_contributions')!;
    expect(link.fields).toEqual(
      expect.objectContaining({ list_item_id: itemId, source: 'recipe', recipe_id: recipeId, quantity: null, unit: null }),
    );
    expect(tables()).toEqual(['recipe_ingredients', 'ingredient_usage', 'list_item_contributions']);
    // The local sort bump (`touch`) is local only.
    expect(db.select().from(recipes).where(eq(recipes.id, recipeId)).get()!.fieldClock).not.toHaveProperty('updated_at');
  });
});

describe('usage and per-user preferences', () => {
  test('Remove from suggestions sends hidden_at', () => {
    addItem(listId, 'milk', USER);
    clearOutbox();
    hideFromSuggestions(householdId, 'milk', new Date('2026-10-01T00:00:00.000Z'));
    hideFromSuggestions(householdId, 'nothing here');
    expect(outboxPatches()).toEqual([
      {
        table: 'ingredient_usage',
        key: { household_id: householdId, ingredient_name: 'milk' },
        fields: { hidden_at: '2026-10-01T00:00:00.000Z' },
      },
    ]);
  });

  test("a custom category enqueues the household's category and the user's order rows it needs", () => {
    loadCatalogSeed();
    const id = createCategory(USER, householdId, ' Bulk  bin ');
    const patches = outboxPatches();
    const orders = patches.filter((p) => p.table === 'user_category_order');
    // No slug or rank: those are system categories' and the server doesn't take them.
    expect(patches.filter((p) => p.table === 'categories')).toEqual([
      { table: 'categories', id, fields: { name: 'Bulk bin', household_id: householdId } },
    ]);
    expect(orders.at(-1)).toEqual({
      table: 'user_category_order',
      key: { user_id: USER, category_id: id },
      fields: { position: expect.any(Number) },
    });
    // Every system category got placed too, so later moves write one row.
    expect(orders.length).toBeGreaterThan(1);
    // The category is household data; the order is the user's.
    const householdOf = (table: string) => outboxRows().filter((r) => r.mutation.table === table).map((r) => r.householdId);
    expect(householdOf('categories')).toEqual([householdId]);
    expect(new Set(householdOf('user_category_order'))).toEqual(new Set([null]));

    clearOutbox();
    moveCategory(USER, householdId, 0, 2);
    expect(outboxPatches()).toEqual([
      { table: 'user_category_order', key: { user_id: USER, category_id: expect.any(String) }, fields: { position: expect.any(Number) } },
    ]);
  });

  test('overrides upsert; reset writes a null category rather than deleting', () => {
    loadCatalogSeed();
    const id = createCategory(USER, householdId, 'Bulk');
    clearOutbox();
    setCategoryOverride(householdId, 'rice', id);
    setCategoryOverride(householdId, 'rice', id);
    clearCategoryOverride(householdId, 'rice');
    const key = { household_id: householdId, ingredient_name: 'rice' };
    expect(outboxPatches()).toEqual([
      { table: 'household_category_overrides', key, fields: { category_id: id } },
      { table: 'household_category_overrides', key, fields: { category_id: id } },
      { table: 'household_category_overrides', key, fields: { category_id: null } },
    ]);
    expect(db.select().from(householdCategoryOverrides).all()).toMatchObject([
      { householdId, ingredientName: 'rice', categoryId: null },
    ]);
  });

  test("renaming a household's custom category isn't a patchable slug", () => {
    loadCatalogSeed();
    const id = createCategory(USER, householdId, 'Bulk');
    clearOutbox();
    updateRows(db, categories, eq(categories.id, id), { name: 'Bulk bins' });
    expect(outboxPatches()).toEqual([{ table: 'categories', id, fields: { name: 'Bulk bins' } }]);
    expect(() => updateRows(db, categories, eq(categories.id, id), { slug: 'bulk' })).toThrow("categories.slug can't be patched");
  });
});
