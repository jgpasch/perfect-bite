import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { eq, inArray } from 'drizzle-orm';

import { db, ingredients } from '@/db';
import { addItem, addItemsBulk, groupItems, listItemsQuery, setItemChecked, updateItem } from '@/features/lists/items';
import { ensureStarterData, getDefaultListId } from '@/features/lists/lists';
import { addRecipeToList, buildRecipeAdds } from '@/features/recipes/add-to-list';
import { addItemsToRecipe, makeRecipeFromItems } from '@/features/recipes/from-list';
import {
  addParsedRecipeIngredients,
  addRecipeIngredient,
  createRecipe,
  recipeIngredientsQuery,
  updateRecipeIngredient,
} from '@/features/recipes/recipes';
import { normalizeIngredientName, OTHER_CATEGORY_ID } from '@/shared';
import { resetDb } from '@/test/db';

import { collectPendingNames, loadCatalogSeed } from '../categories';

jest.mock('@/db/client', () => require('@/test/db'));

// The names each add newly records as pending, which the screens pass to categorizePending.

const A = 'user-a';
const key = normalizeIngredientName;
let listId: string;

beforeEach(() => {
  resetDb();
  loadCatalogSeed();
  ensureStarterData(A);
  listId = getDefaultListId(A)!;
});

const itemNamed = (name: string) =>
  groupItems(listItemsQuery(listId, A).all()).unchecked.find((i) => i.displayName === name)!;
/** Simulates names whose catalog rows don't exist yet (an install from before pending rows). */
const forget = (...names: string[]) =>
  db.delete(ingredients).where(inArray(ingredients.normalizedName, names.map(key))).run();

describe('collectPendingNames', () => {
  test('collects every result’s names once each, in order, skipping nulls', () => {
    expect(
      collectPendingNames([
        { pendingNames: ['za’atar'] },
        null,
        { pendingNames: [] },
        { pendingNames: ['sumac', 'za’atar'] },
        { pendingNames: ['dukkah'] },
      ]),
    ).toEqual(['za’atar', 'sumac', 'dukkah']);
  });

  test('nothing in, nothing out', () => {
    expect(collectPendingNames([])).toEqual([]);
    expect(collectPendingNames([null, null])).toEqual([]);
    expect(collectPendingNames([{ pendingNames: [] }])).toEqual([]);
  });
});

describe('list adds', () => {
  test('a single add of an unknown name returns that one name', () => {
    expect(addItem(listId, '2 Flux Capacitors', A)!.pendingNames).toEqual([key('Flux Capacitors')]);
  });

  test('a seed name returns nothing', () => {
    expect(addItem(listId, '2 lbs chicken thighs', A)!.pendingNames).toEqual([]);
  });

  test('adding the same unknown name again (combine) returns nothing the second time', () => {
    addItem(listId, 'dukkah', A);
    const again = addItem(listId, '2 dukkah', A)!;
    expect(again.kind).toBe('combine');
    expect(again.pendingNames).toEqual([]);
  });

  test('reopening a checked unknown item returns nothing (its row is already there)', () => {
    const first = addItem(listId, 'dukkah', A)!;
    setItemChecked(first.itemId, true, A);
    const again = addItem(listId, 'dukkah', A)!;
    expect(again.kind).toBe('reopen');
    expect(again.pendingNames).toEqual([]);
  });

  test('a name already pending or failed is not newly marked (catch-up retries those)', () => {
    addItem(listId, 'flux capacitor', A);
    db.update(ingredients)
      .set({ status: 'failed', defaultCategoryId: OTHER_CATEGORY_ID })
      .where(eq(ingredients.normalizedName, key('flux capacitor')))
      .run();
    expect(addItem(listId, 'flux capacitor', A)!.pendingNames).toEqual([]);
  });

  test('empty text adds nothing and has no result', () => {
    expect(addItem(listId, '   ', A)).toBeNull();
  });

  test('a bulk add gives each new name once, in add order, for one request', () => {
    const results = addItemsBulk(
      listId,
      [{ text: 'yuzu kosho' }, { text: 'tomatoes' }, { text: ' ' }, { text: 'ssamjang' }, { text: '2 yuzu kosho' }],
      A,
    );
    expect(results.map((r) => r?.pendingNames ?? null)).toEqual([[key('yuzu kosho')], [], null, [key('ssamjang')], []]);
    expect(collectPendingNames(results)).toEqual([key('yuzu kosho'), key('ssamjang')]);
  });

  test('a bulk add of known names collects nothing', () => {
    expect(collectPendingNames(addItemsBulk(listId, [{ text: 'milk' }, { text: 'eggs' }], A))).toEqual([]);
  });
});

describe('item edit sheet', () => {
  test('renaming to an unknown name returns it', () => {
    addItem(listId, 'tomatoes', A);
    expect(updateItem(itemNamed('tomatoes').id, { name: 'Tomatillos', amount: '', note: '' }, A)).toEqual([
      key('Tomatillos'),
    ]);
  });

  test('renaming to a known name, or editing without a rename, returns nothing', () => {
    addItem(listId, 'tomatoes', A);
    const itemId = itemNamed('tomatoes').id;
    expect(updateItem(itemId, { name: 'tomatoes', amount: '3', note: 'ripe' }, A)).toEqual([]);
    expect(updateItem(itemId, { name: 'milk', amount: '3', note: '' }, A)).toEqual([]);
  });

  test('renaming to a name that is already pending returns nothing', () => {
    addItem(listId, 'dukkah', A);
    addItem(listId, 'tomatoes', A);
    setItemChecked(itemNamed('dukkah').id, true, A);
    expect(updateItem(itemNamed('tomatoes').id, { name: 'dukkah', amount: '', note: '' }, A)).toEqual([]);
  });
});

describe('recipes', () => {
  test('adding an unknown ingredient returns its id and name; a known one returns no name', () => {
    const pie = createRecipe('Pie');
    const garlic = addRecipeIngredient(pie, '1 tsp black garlic')!;
    expect(garlic.pendingNames).toEqual([key('black garlic')]);
    expect(recipeIngredientsQuery(pie).all().map((i) => i.id)).toEqual([garlic.id]);
    expect(addRecipeIngredient(pie, '2 cups flour')!.pendingNames).toEqual([]);
    expect(addRecipeIngredient(pie, '1 tsp black garlic')!.pendingNames).toEqual([]);
    expect(addRecipeIngredient(pie, '  ')).toBeNull();
  });

  test('parsed ingredients return only the new names, once each', () => {
    const r = createRecipe('Salad');
    const parsed = (name: string) => ({ ingredientName: key(name), displayName: name, quantity: null, unit: null });
    expect(
      addParsedRecipeIngredients(r, [parsed('urfa biber'), parsed('tomatoes'), parsed('urfa biber'), parsed('amchur')]),
    ).toEqual([key('urfa biber'), key('amchur')]);
    expect(addParsedRecipeIngredients(r, [])).toEqual([]);
  });

  test('editing an ingredient to an unknown name returns it; to a known one, nothing', () => {
    const pie = createRecipe('Pie');
    const { id } = addRecipeIngredient(pie, '2 cups flour')!;
    expect(updateRecipeIngredient(id, '100 g labneh')).toEqual([key('labneh')]);
    expect(updateRecipeIngredient(id, '200 g labneh')).toEqual([]);
    expect(updateRecipeIngredient(id, '2 cups flour')).toEqual([]);
  });

  test('acceptance 6: adding a recipe with 8 names the catalog lacks returns all 8 for one request', () => {
    const stew = createRecipe('Stew');
    const unknown = ['ajvar', 'amchur', 'black garlic', 'doenjang', 'gochugaru', 'kecap manis', 'sumac', 'urfa biber'];
    for (const name of [...unknown, 'onion', 'carrots', 'potatoes', 'milk']) addRecipeIngredient(stew, name);
    forget(...unknown);

    const ingredientsOfStew = recipeIngredientsQuery(stew).all();
    const adds = buildRecipeAdds(stew, ingredientsOfStew, new Set(ingredientsOfStew.map((i) => i.id)), 1);
    expect(addRecipeToList(listId, adds, A).pendingNames).toEqual(unknown.map(key));
  });

  test('adding a recipe whose names were already sent from the recipe returns nothing', () => {
    const stew = createRecipe('Stew');
    addRecipeIngredient(stew, 'ajvar');
    addRecipeIngredient(stew, 'onion');
    const ingredientsOfStew = recipeIngredientsQuery(stew).all();
    const adds = buildRecipeAdds(stew, ingredientsOfStew, new Set(ingredientsOfStew.map((i) => i.id)), 2);
    expect(addRecipeToList(listId, adds, A).pendingNames).toEqual([]);
  });

  test('a recipe ingredient that Combines into an open item still records its name', () => {
    const stew = createRecipe('Stew');
    addRecipeIngredient(stew, 'ajvar');
    addItem(listId, 'ajvar', A);
    forget('ajvar');
    const ingredientsOfStew = recipeIngredientsQuery(stew).all();
    const adds = buildRecipeAdds(stew, ingredientsOfStew, new Set(ingredientsOfStew.map((i) => i.id)), 1);
    expect(addRecipeToList(listId, adds, A).pendingNames).toEqual([key('ajvar')]);
  });

  test('Make recipe and Add to recipe return names that had no catalog row, and nothing otherwise', () => {
    const beef = addItem(listId, '2 lbs ground beef', A)!;
    const ajvar = addItem(listId, 'ajvar', A)!;
    const made = makeRecipeFromItems('Tacos', [beef.itemId, ajvar.itemId], A);
    expect(made.pendingNames).toEqual([]);
    expect(recipeIngredientsQuery(made.recipeId).all()).toHaveLength(2);

    const dukkah = addItem(listId, 'dukkah', A)!;
    forget('dukkah');
    const soup = createRecipe('Soup');
    expect(addItemsToRecipe(soup, [dukkah.itemId, beef.itemId], A)).toEqual([key('dukkah')]);
    expect(addItemsToRecipe(soup, [], A)).toEqual([]);
  });
});
