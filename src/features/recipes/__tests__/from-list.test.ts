import { beforeEach, expect, jest, test } from '@jest/globals';

import { groupByRecipe } from '@/domain/recipe-grouping';
import { addItem, groupItems, listItemsQuery } from '@/features/lists/items';
import { ensureStarterData, getDefaultListId } from '@/features/lists/lists';
import { resetDb } from '@/test/db';

import { addItemsToRecipe, makeRecipeFromItems } from '../from-list';
import { createRecipe, recipeIngredientsQuery } from '../recipes';

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

  const recipeId = makeRecipeFromItems('Tacos', [beef.itemId, lime.itemId, milk.id], USER);

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

test('add to an existing recipe appends; adding again neither repeats nor double-links', () => {
  const soup = createRecipe('Soup');
  const onion = addItem(listId, '2 onions', USER)!;
  addItemsToRecipe(soup, [onion.itemId], USER);
  addItemsToRecipe(soup, [onion.itemId], USER);
  expect(recipeIngredientsQuery(soup).all()).toHaveLength(1);
  expect(view()[0].contributions.filter((c) => c.recipeId === soup)).toHaveLength(1);
  addItemsToRecipe(soup, [], USER);
});
