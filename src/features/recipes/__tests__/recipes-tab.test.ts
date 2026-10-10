import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { db, households, recipes } from '@/db';
import { addItem, addItemsBulk, deleteContribution, deleteItem, setItemChecked } from '@/features/lists/items';
import { createList, deleteList, ensureStarterData, getDefaultListId, setListArchived } from '@/features/lists/lists';
import { resetDb } from '@/test/db';

import { groupRecipesByHousehold, onListByRecipe } from '../recipe-view';
import { addRecipeIngredient, createRecipe, deleteRecipe, recipesOnListsQuery, recipesQuery } from '../recipes';

jest.mock('@/db/client', () => require('@/test/db'));

const USER = 'user-1';
let groceries: string;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  groceries = getDefaultListId(USER)!;
});

/** Adds the recipe's text to a list as a recipe add; returns the bulk results. */
const addFromRecipe = (listId: string, recipeId: string, text: string) =>
  addItemsBulk(listId, [{ text, source: 'recipe', recipeId }], USER);

/** The badge each recipe would show, by recipe name. */
const badges = () => {
  const onList = onListByRecipe(recipesOnListsQuery().all());
  return Object.fromEntries(recipesQuery().all().map((r) => [r.name, onList.get(r.id) ?? null]));
};

describe('recipesQuery households (board 05)', () => {
  test('each recipe carries its household, and grouping keeps them under it', () => {
    const tacos = createRecipe('Tacos');
    addRecipeIngredient(tacos, '2 lb chicken thighs');
    db.insert(households).values({ id: 'lake', name: 'Lake house' }).run();
    db.insert(recipes).values({ id: 'chili', householdId: 'lake', name: 'Campfire chili' }).run();

    const rows = recipesQuery().all();
    expect(rows.map((r) => [r.name, r.householdName, r.ingredientCount])).toEqual(
      expect.arrayContaining([
        ['Tacos', 'Personal', 1],
        ['Campfire chili', 'Lake house', 0],
      ]),
    );
    const groups = groupRecipesByHousehold(rows);
    expect(groups.map((g) => [g.name, g.recipes.map((r) => r.name)]).sort()).toEqual([
      ['Lake house', ['Campfire chili']],
      ['Personal', ['Tacos']],
    ]);
  });
});

describe('recipesOnListsQuery ("On Groceries" badge)', () => {
  test('a recipe with an open item on a list shows that list; one never added shows none', () => {
    const tacos = createRecipe('Tacos');
    createRecipe('Dal');
    addFromRecipe(groceries, tacos, '3 limes');
    expect(badges()).toEqual({ Tacos: 'Groceries', Dal: null });
  });

  test('typed adds of the same ingredient do not count as the recipe', () => {
    createRecipe('Tacos');
    addItem(groceries, '3 limes', USER);
    expect(badges()).toEqual({ Tacos: null });
  });

  test('checked, deleted or removed items no longer count', () => {
    const tacos = createRecipe('Tacos');
    const [limes] = addFromRecipe(groceries, tacos, '3 limes');
    setItemChecked(limes!.itemId, true, USER);
    expect(badges()).toEqual({ Tacos: null });

    setItemChecked(limes!.itemId, false, USER);
    expect(badges()).toEqual({ Tacos: 'Groceries' });

    deleteItem(limes!.itemId);
    expect(badges()).toEqual({ Tacos: null });

    const [onions] = addFromRecipe(groceries, tacos, '1 onion');
    deleteContribution(onions!.contributionId);
    expect(badges()).toEqual({ Tacos: null });
  });

  test('archived and deleted lists do not count', () => {
    const tacos = createRecipe('Tacos');
    const costco = createList('Costco');
    addFromRecipe(costco, tacos, '3 limes');
    setListArchived(costco, true);
    expect(badges()).toEqual({ Tacos: null });
    setListArchived(costco, false);
    expect(badges()).toEqual({ Tacos: 'Costco' });
    deleteList(costco);
    expect(badges()).toEqual({ Tacos: null });
  });

  test('a deleted recipe drops out (its amounts lose the recipe)', () => {
    const tacos = createRecipe('Tacos');
    addFromRecipe(groceries, tacos, '3 limes');
    deleteRecipe(tacos);
    expect(recipesOnListsQuery().all()).toEqual([]);
  });

  test('on two lists, the badge names the one it was added to most recently', () => {
    const tacos = createRecipe('Tacos');
    const costco = createList('Costco');
    addFromRecipe(groceries, tacos, '3 limes');
    addFromRecipe(costco, tacos, '2 lb chicken thighs');
    const rows = recipesOnListsQuery().all();
    expect(rows.map((r) => r.listName).sort()).toEqual(['Costco', 'Groceries']);
    // Same-millisecond adds can tie in a fast test, so check the pick with explicit times.
    const at = (ms: number) => new Date(ms);
    expect(
      onListByRecipe([
        { recipeId: tacos, listName: 'Groceries', addedAt: at(1) },
        { recipeId: tacos, listName: 'Costco', addedAt: at(2) },
      ]).get(tacos),
    ).toBe('Costco');
  });
});
