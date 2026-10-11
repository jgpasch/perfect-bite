import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { eq } from 'drizzle-orm';

import { db, households, ingredientUsage, listItemContributions, lists, recipes } from '@/db';
import { groupByRecipe } from '@/domain/recipe-grouping';
import { addItem, groupItems, listItemsQuery } from '@/features/lists/items';
import { ensureStarterData, getDefaultListId, listQuery } from '@/features/lists/lists';
import { resetDb } from '@/test/db';

import { addRecipeToList, buildRecipeAdds } from '../add-to-list';
import { addItemsToRecipe, makeRecipeFromItems } from '../from-list';
import {
  addRecipeIngredient,
  createRecipe,
  deleteRecipe,
  getRecipe,
  recipeIngredientsQuery,
  recipesForPicker,
} from '../recipes';

jest.mock('@/db/client', () => require('@/test/db'));

const USER = 'user-1';
let listId: string;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  listId = getDefaultListId(USER)!;
});

const view = () => groupItems(listItemsQuery(listId, USER).all()).unchecked;

test('acceptance 3: make a recipe from 3 selected items; they group under it', () => {
  const beef = addItem(listId, '2 lbs ground beef', USER)!;
  const lime = addItem(listId, 'limes', USER)!;
  addItem(listId, 'milk', USER);
  addItem(listId, '1 gal milk', USER); // combined: "1 + 1 gal" isn't one amount
  const milk = view().find((i) => i.displayName === 'milk')!;

  const { recipeId } = makeRecipeFromItems('Tacos', [beef.itemId, lime.itemId, milk.id], USER);

  expect(
    recipeIngredientsQuery(recipeId)
      .all()
      .map((i) => [i.displayName, i.quantity, i.unit]),
  ).toEqual([
    ['ground beef', 2, 'lb'],
    ['limes', null, null],
    ['milk', null, null],
  ]);
  const sections = groupByRecipe(view());
  expect(sections.map((s) => [s.name, s.entries.map((e) => e.item.displayName)])).toEqual([
    ['Tacos', ['ground beef', 'limes', 'milk']],
  ]);
  // The link adds no amount to the row.
  expect(view().map((i) => i.amountText)).toEqual(['2 lb', '', '1 + 1 gal']);
});

test('make recipe takes the counted total of adds with no amount', () => {
  const milk = addItem(listId, 'milk', USER)!;
  addItem(listId, 'milk', USER);
  const { recipeId } = makeRecipeFromItems('Breakfast', [milk.itemId], USER);
  expect(
    recipeIngredientsQuery(recipeId)
      .all()
      .map((i) => [i.displayName, i.quantity, i.unit]),
  ).toEqual([['milk', 2, null]]);
  // The new link adds nothing to the row's total.
  expect(view().map((i) => i.amountText)).toEqual(['2']);
});

test('add to an existing recipe appends; adding again neither repeats nor double-links', () => {
  const soup = createRecipe('Soup');
  const onion = addItem(listId, '2 onions', USER)!;
  addItemsToRecipe(soup, [onion.itemId], USER);
  addItemsToRecipe(soup, [onion.itemId], USER);
  expect(recipeIngredientsQuery(soup).all()).toHaveLength(1);
  expect(view()[0].contributions.filter((c) => c.recipeId === soup)).toHaveLength(1);
  addItemsToRecipe(soup, [], USER);
});

describe('ingredient history (spec 4.2)', () => {
  const counts = () =>
    Object.fromEntries(
      db
        .select({ key: ingredientUsage.ingredientName, n: ingredientUsage.useCount })
        .from(ingredientUsage)
        .all()
        .map((r) => [r.key, r.n]),
    );

  test('Make recipe counts each item once; adding the recipe to a list counts again', () => {
    const beef = addItem(listId, '2 lbs ground beef', USER)!;
    const lime = addItem(listId, 'limes', USER)!;
    addItem(listId, 'milk', USER);
    expect(counts()).toEqual({ 'ground beef': 1, lime: 1, milk: 1 });

    const tacos = makeRecipeFromItems('Tacos', [beef.itemId, lime.itemId], USER).recipeId;
    expect(counts()).toEqual({ 'ground beef': 2, lime: 2, milk: 1 });

    const ingredients = recipeIngredientsQuery(tacos).all();
    const all = new Set(ingredients.map((i) => i.id));
    addRecipeToList(listId, buildRecipeAdds(tacos, ingredients, all, 1), USER);
    expect(counts()).toEqual({ 'ground beef': 3, lime: 3, milk: 1 });
  });

  test('Add to recipe does not count an ingredient the recipe already has', () => {
    const soup = createRecipe('Soup');
    const onion = addItem(listId, '2 onions', USER)!;
    const carrot = addItem(listId, 'carrots', USER)!;
    addItemsToRecipe(soup, [onion.itemId], USER);
    addItemsToRecipe(soup, [onion.itemId, carrot.itemId], USER);
    expect(counts()).toEqual({ onion: 2, carrot: 2 });
  });
});

describe('Add to recipe sheet (spec 4.5)', () => {
  const householdId = () => listQuery(listId).get()!.householdId;
  const setUpdated = (recipeId: string, at: string) =>
    db.update(recipes).set({ updatedAt: new Date(at) }).where(eq(recipes.id, recipeId)).run();
  const setAdded = (recipeId: string, at: string) =>
    db.update(listItemContributions).set({ createdAt: new Date(at) }).where(eq(listItemContributions.recipeId, recipeId)).run();

  test('a new recipe goes in the list’s household, not the first one', () => {
    db.insert(households).values({ id: 'lake', name: 'Lake house', createdAt: new Date('2000-01-01') }).run();
    db.insert(lists).values({ id: 'lake-list', householdId: 'lake', name: 'Cabin', position: 1 }).run();
    const flour = addItem('lake-list', 'flour', USER)!;

    const { recipeId } = makeRecipeFromItems('Bread', [flour.itemId], USER, 'lake');
    expect(getRecipe(recipeId)!.householdId).toBe('lake');
    // Without a household it still goes in the first one, as before.
    expect(getRecipe(createRecipe('Soup'))!.householdId).toBe('lake');
  });

  test('offers only the list’s household’s live recipes, with ingredient counts, most recently used first', () => {
    db.insert(households).values({ id: 'lake', name: 'Lake house' }).run();
    db.insert(recipes).values({ id: 'other', householdId: 'lake', name: 'Lake chili' }).run();
    const tacos = createRecipe('Tacos', householdId());
    const dal = createRecipe('Dal', householdId());
    const soup = createRecipe('Soup', householdId());
    const gone = createRecipe('Gone', householdId());
    deleteRecipe(gone);
    addRecipeIngredient(tacos, '1 lb beef');
    addRecipeIngredient(tacos, 'limes');
    addRecipeIngredient(dal, 'lentils');
    setUpdated(tacos, '2026-10-01');
    setUpdated(dal, '2026-10-03');
    setUpdated(soup, '2026-10-02');

    const picked = () => recipesForPicker(householdId()).map((r) => [r.name, r.ingredientCount]);
    expect(picked()).toEqual([
      ['Dal', 1],
      ['Soup', 0],
      ['Tacos', 2],
    ]);

    // Adding Tacos to a list is a use, and moves it to the top.
    const ingredients = recipeIngredientsQuery(tacos).all();
    addRecipeToList(listId, buildRecipeAdds(tacos, ingredients, new Set(ingredients.map((i) => i.id)), 1), USER);
    setAdded(tacos, '2026-10-05');
    expect(picked().map(([name]) => name)).toEqual(['Tacos', 'Dal', 'Soup']);

    expect(recipesForPicker('lake').map((r) => r.name)).toEqual(['Lake chili']);
    expect(recipesForPicker('nowhere')).toEqual([]);
  });

  test('adding items to a recipe makes it the most recently used', () => {
    const tacos = createRecipe('Tacos', householdId());
    const dal = createRecipe('Dal', householdId());
    setUpdated(tacos, '2026-10-01');
    setUpdated(dal, '2026-10-02');
    expect(recipesForPicker(householdId()).map((r) => r.name)).toEqual(['Dal', 'Tacos']);

    addItemsToRecipe(tacos, [addItem(listId, 'limes', USER)!.itemId], USER);
    expect(recipesForPicker(householdId()).map((r) => [r.name, r.ingredientCount])).toEqual([
      ['Tacos', 1],
      ['Dal', 0],
    ]);
  });
});
