import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { db, ingredientUsage } from '@/db';
import { addItemsBulk, contributionsQuery } from '@/features/lists/items';
import { ensureStarterData, getDefaultListId } from '@/features/lists/lists';
import { resetDb } from '@/test/db';

import { addRecipeToList, buildRecipeAdds } from '../add-to-list';

import {
  addParsedRecipeIngredients,
  addRecipeIngredient,
  createRecipe,
  deleteRecipe,
  deleteRecipeIngredient,
  getRecipe,
  recipeIngredientsQuery,
  recipesQuery,
  undeleteRecipeIngredient,
  updateRecipe,
  updateRecipeIngredient,
} from '../recipes';

jest.mock('@/db/client', () => require('@/test/db'));

const USER = 'user-1';

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
});

const ingredientsOf = (id: string) =>
  recipeIngredientsQuery(id)
    .all()
    .map((i) => [i.displayName, i.quantity, i.unit]);

describe('recipes', () => {
  test('create, edit and list with ingredient counts', () => {
    const tacos = createRecipe('  Tacos ');
    createRecipe('Soup');
    addRecipeIngredient(tacos, '1 lb ground beef');
    updateRecipe(tacos, { name: 'Beef tacos', notes: ' Tuesday ', sourceUrl: '' });
    expect(getRecipe(tacos)).toMatchObject({ name: 'Beef tacos', notes: 'Tuesday', sourceUrl: null });
    const rows = recipesQuery().all();
    expect(rows.map((r) => [r.name, r.ingredientCount])).toEqual([
      ['Beef tacos', 1],
      ['Soup', 0],
    ]);
    expect(() => createRecipe(' ')).toThrow();
    expect(() => updateRecipe(tacos, { name: '', notes: '', sourceUrl: '' })).toThrow();
  });

  test('ingredients parse like list adds, keep order, and can repeat', () => {
    const pie = createRecipe('Pie');
    addRecipeIngredient(pie, '2 cups flour');
    addRecipeIngredient(pie, '1/2 cup butter');
    addRecipeIngredient(pie, '4 tbsp butter');
    expect(addRecipeIngredient(pie, '  ')).toBeNull();
    expect(ingredientsOf(pie)).toEqual([
      ['flour', 2, 'cup'],
      ['butter', 0.5, 'cup'],
      ['butter', 4, 'tbsp'],
    ]);
  });

  test('edit, delete and undo an ingredient', () => {
    const pie = createRecipe('Pie');
    const flour = addRecipeIngredient(pie, '2 cups flour')!;
    updateRecipeIngredient(flour, '3 cups bread flour', 'sifted');
    expect(recipeIngredientsQuery(pie).all()[0]).toMatchObject({
      displayName: 'bread flour',
      ingredientName: 'bread flour',
      quantity: 3,
      note: 'sifted',
    });
    deleteRecipeIngredient(flour);
    expect(ingredientsOf(pie)).toEqual([]);
    undeleteRecipeIngredient(flour);
    expect(ingredientsOf(pie)).toHaveLength(1);
    expect(() => updateRecipeIngredient(flour, '!')).toThrow();
  });

  test('parsed ingredients append in order', () => {
    const r = createRecipe('Salad');
    addRecipeIngredient(r, 'lettuce');
    addParsedRecipeIngredients(r, [
      { ingredientName: 'tomato', displayName: 'tomatoes', quantity: 2, unit: null },
      { ingredientName: 'feta', displayName: 'feta', quantity: null, unit: null },
    ]);
    expect(ingredientsOf(r)).toEqual([
      ['lettuce', null, null],
      ['tomatoes', 2, null],
      ['feta', null, null],
    ]);
  });

  test('deleting a recipe keeps list items; their amounts become "no recipe"', () => {
    const tacos = createRecipe('Tacos');
    const listId = getDefaultListId(USER)!;
    const [beef] = addItemsBulk(listId, [{ text: '1 lb ground beef', source: 'recipe', recipeId: tacos }], USER);
    deleteRecipe(tacos);
    expect(recipesQuery().all()).toEqual([]);
    expect(contributionsQuery(beef!.itemId).all()).toMatchObject([{ quantity: 1, recipeId: null }]);
  });
});

describe('ingredient history (spec 4.2)', () => {
  const usage = () =>
    db
      .select()
      .from(ingredientUsage)
      .orderBy(ingredientUsage.ingredientName)
      .all()
      .map((r) => [r.ingredientName, r.displayName, r.useCount]);

  test('a recipe-only ingredient is counted once, under the recipe household and typed name', () => {
    const pie = createRecipe('Pie');
    const before = Date.now();
    addRecipeIngredient(pie, '2 cups Flour');
    const [row] = db.select().from(ingredientUsage).all();
    expect(row).toMatchObject({
      householdId: getRecipe(pie)!.householdId,
      ingredientName: 'flour',
      displayName: 'Flour',
      useCount: 1,
      hiddenAt: null,
    });
    expect(row.lastUsedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  test('each ingredient row counts, including a repeat; empty text counts nothing', () => {
    const pie = createRecipe('Pie');
    addRecipeIngredient(pie, '1/2 cup butter');
    addRecipeIngredient(pie, '4 tbsp Butter');
    addRecipeIngredient(pie, '   ');
    expect(usage()).toEqual([['butter', 'Butter', 2]]);
  });

  test('parsed ingredients count once each', () => {
    const salad = createRecipe('Salad');
    addParsedRecipeIngredients(salad, [
      { ingredientName: 'tomato', displayName: 'tomatoes', quantity: 2, unit: null },
      { ingredientName: 'feta', displayName: 'feta', quantity: null, unit: null },
    ]);
    addParsedRecipeIngredients(salad, []);
    expect(usage()).toEqual([
      ['feta', 'feta', 1],
      ['tomato', 'tomatoes', 1],
    ]);
  });

  test('editing, deleting or undeleting an ingredient does not count', () => {
    const pie = createRecipe('Pie');
    const flour = addRecipeIngredient(pie, '2 cups flour')!;
    updateRecipeIngredient(flour, '3 cups bread flour');
    deleteRecipeIngredient(flour);
    undeleteRecipeIngredient(flour);
    expect(usage()).toEqual([['flour', 'flour', 1]]);
  });

  test('a missing recipe throws and counts nothing', () => {
    expect(() => addRecipeIngredient('nope', 'flour')).toThrow('No recipe nope');
    expect(() =>
      addParsedRecipeIngredients('nope', [{ ingredientName: 'feta', displayName: 'feta', quantity: null, unit: null }]),
    ).toThrow('No recipe nope');
    expect(usage()).toEqual([]);
  });

  test('adding the recipe to a list counts again', () => {
    const tacos = createRecipe('Tacos');
    addRecipeIngredient(tacos, '8 tortillas');
    const ingredients = recipeIngredientsQuery(tacos).all();
    addRecipeToList(
      getDefaultListId(USER)!,
      buildRecipeAdds(tacos, ingredients, new Set(ingredients.map((i) => i.id)), 1),
      USER,
      new Set(),
    );
    expect(usage()).toEqual([['tortilla', 'tortillas', 2]]);
  });
});
