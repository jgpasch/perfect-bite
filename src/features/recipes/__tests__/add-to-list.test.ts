import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { db, ingredientUsage } from '@/db';
import { groupByRecipe } from '@/domain/recipe-grouping';

import { addItem, checkItems, groupItems, listItemsQuery, removeRecipeFromList } from '@/features/lists/items';
import { ensureStarterData, getDefaultListId } from '@/features/lists/lists';
import { resetDb } from '@/test/db';

import { addRecipeToList, buildRecipeAdds, planRecipeAdd } from '../add-to-list';
import { addRecipeIngredient, createRecipe, recipeIngredientsQuery } from '../recipes';

jest.mock('@/db/client', () => require('@/test/db'));

const USER = 'user-1';
let listId: string;
let tacos: string;

beforeEach(() => {
  resetDb();
  ensureStarterData(USER);
  listId = getDefaultListId(USER)!;
  tacos = createRecipe('Tacos');
  for (const text of ['1 lb ground beef', '8 tortillas', '1 cup salsa', 'cilantro', '2 limes']) {
    addRecipeIngredient(tacos, text);
  }
});

const rows = () =>
  groupItems(listItemsQuery(listId, USER).all()).unchecked.map((i) =>
    i.amountText ? `${i.amountText} ${i.displayName}` : i.displayName,
  );

test('adds the chosen ingredients, scaled by servings', () => {
  const ingredients = recipeIngredientsQuery(tacos).all();
  const selected = new Set(ingredients.filter((i) => i.displayName !== 'cilantro').map((i) => i.id));
  addRecipeToList(listId, buildRecipeAdds(tacos, ingredients, selected, 2), USER, new Set());
  expect(rows()).toEqual(['2 lb ground beef', '16 tortillas', '2 cup salsa', '4 limes']);
});

test('acceptance 2: one ingredient already open → 4 new items, and the conflict is reported', () => {
  addItem(listId, 'limes', USER);
  const ingredients = recipeIngredientsQuery(tacos).all();
  const selected = new Set(ingredients.filter((i) => i.displayName !== 'cilantro').map((i) => i.id));
  const adds = buildRecipeAdds(tacos, ingredients, selected, 1);
  const conflicts = planRecipeAdd(listId, adds);
  expect(conflicts.map((c) => [c.index, c.displayName, c.existingAmountText, c.incomingAmountText])).toEqual([
    [3, 'limes', '', '2'],
  ]);
  addRecipeToList(listId, adds, USER, new Set([3]));
  expect(rows()).toEqual(['limes', '1 lb ground beef', '8 tortillas', '1 cup salsa']);
});

test('a half batch keeps unspecified amounts unspecified', () => {
  const ingredients = recipeIngredientsQuery(tacos).all();
  addRecipeToList(listId, buildRecipeAdds(tacos, ingredients, new Set(ingredients.map((i) => i.id)), 0.5), USER, new Set());
  expect(rows()).toEqual(['0.5 lb ground beef', '4 tortillas', '½ cup salsa', 'cilantro', '1 limes']);
});

describe('ingredient history (spec 4.2)', () => {
  // Deltas, so the counts don't depend on whether creating the recipe counted too.
  const counts = () =>
    Object.fromEntries(
      db
        .select({ key: ingredientUsage.ingredientName, n: ingredientUsage.useCount })
        .from(ingredientUsage)
        .all()
        .map((r) => [r.key, r.n]),
    );
  const delta = (before: Record<string, number>) =>
    Object.fromEntries(
      Object.entries(counts())
        .map(([k, n]) => [k, n - (before[k] ?? 0)])
        .filter(([, d]) => d !== 0),
    );

  test('adding a recipe to a list counts each chosen ingredient exactly once', () => {
    const ingredients = recipeIngredientsQuery(tacos).all();
    const selected = new Set(ingredients.filter((i) => i.displayName !== 'cilantro').map((i) => i.id));
    const before = counts();
    addRecipeToList(listId, buildRecipeAdds(tacos, ingredients, selected, 2), USER, new Set());
    expect(delta(before)).toEqual({ 'ground beef': 1, lime: 1, salsa: 1, tortilla: 1 });
  });

  test('a combined or kept-existing recipe ingredient still counts once', () => {
    addItem(listId, 'limes', USER);
    addItem(listId, 'salsa', USER);
    const ingredients = recipeIngredientsQuery(tacos).all();
    const all = new Set(ingredients.map((i) => i.id));
    const adds = buildRecipeAdds(tacos, ingredients, all, 1);
    const salsa = adds.findIndex((a) => 'parsed' in a && a.parsed.ingredientName === 'salsa');
    const before = counts();
    addRecipeToList(listId, adds, USER, new Set([salsa]));
    expect(delta(before)).toEqual({ cilantro: 1, 'ground beef': 1, lime: 1, salsa: 1, tortilla: 1 });
  });
});

describe('By recipe actions (spec 4.6)', () => {
  const addAll = (recipeId: string) => {
    const ingredients = recipeIngredientsQuery(recipeId).all();
    addRecipeToList(listId, buildRecipeAdds(recipeId, ingredients, new Set(ingredients.map((i) => i.id)), 1), USER, new Set());
  };

  test('acceptance 12: an item from two recipes shows under both; checking it checks it everywhere', () => {
    const soup = createRecipe('Lime soup');
    addRecipeIngredient(soup, '3 limes');
    addAll(tacos);
    addAll(soup);
    const { unchecked } = groupItems(listItemsQuery(listId, USER).all());
    const sections = groupByRecipe(unchecked);
    expect(sections.map((s) => s.name)).toEqual(['Lime soup', 'Tacos']);
    const limeInSoup = sections[0].entries[0];
    expect(limeInSoup).toMatchObject({ amountText: '3', alsoIn: ['Tacos'] });
    checkItems([limeInSoup.item.id], USER);
    const after = groupByRecipe(groupItems(listItemsQuery(listId, USER).all()).unchecked);
    expect(after.map((s) => s.name)).toEqual(['Tacos']);
    expect(after[0].entries.map((e) => e.item.displayName)).not.toContain('limes');
  });

  test('remove recipe from list drops its amounts and deletes items left empty', () => {
    addItem(listId, '2 limes', USER);
    addAll(tacos);
    removeRecipeFromList(listId, tacos);
    expect(rows()).toEqual(['2 limes']);
  });
});
