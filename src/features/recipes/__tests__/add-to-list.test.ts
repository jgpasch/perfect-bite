import { beforeEach, describe, expect, jest, test } from '@jest/globals';

import { db, ingredientUnitUsage, ingredientUsage, listItems } from '@/db';
import { groupByRecipe } from '@/domain/recipe-grouping';

import {
  addItem,
  checkItems,
  contributionsQuery,
  groupItems,
  listItemsQuery,
  removeRecipeFromList,
  setItemChecked,
} from '@/features/lists/items';
import { ensureStarterData, getDefaultListId } from '@/features/lists/lists';
import { resetDb } from '@/test/db';

import { addRecipeToList, buildRecipeAdds, undoRecipeAdd } from '../add-to-list';
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
  addRecipeToList(listId, buildRecipeAdds(tacos, ingredients, selected, 2), USER);
  expect(rows()).toEqual(['2 lb ground beef', '16 tortillas', '2 cup salsa', '4 limes']);
});

test('acceptance 2: one ingredient already open → 3 new items, and the open one Combines', () => {
  addItem(listId, 'limes', USER);
  const ingredients = recipeIngredientsQuery(tacos).all();
  const selected = new Set(ingredients.filter((i) => i.displayName !== 'cilantro').map((i) => i.id));
  const added = addRecipeToList(listId, buildRecipeAdds(tacos, ingredients, selected, 1), USER);
  expect(added.count).toBe(4);
  expect(added.results.map((r) => r?.kind)).toEqual(['new', 'new', 'new', 'combine']);
  // `limes` (counts as one) + 2 limes; the Combined row stays where it was.
  expect(rows()).toEqual(['3 limes', '1 lb ground beef', '8 tortillas', '1 cup salsa']);
});

test('a half batch keeps unspecified amounts unspecified', () => {
  const ingredients = recipeIngredientsQuery(tacos).all();
  addRecipeToList(listId, buildRecipeAdds(tacos, ingredients, new Set(ingredients.map((i) => i.id)), 0.5), USER);
  expect(rows()).toEqual(['0.5 lb ground beef', '4 tortillas', '½ cup salsa', 'cilantro', '1 limes']);
});

describe('clashes Combine like single adds (spec 4.4)', () => {
  const allAdds = (servings = 1) => {
    const ingredients = recipeIngredientsQuery(tacos).all();
    return buildRecipeAdds(tacos, ingredients, new Set(ingredients.map((i) => i.id)), servings);
  };
  const checkedRows = () =>
    groupItems(listItemsQuery(listId, USER).all()).checked.map((i) => (i.amountText ? `${i.amountText} ${i.displayName}` : i.displayName));

  test('every clashing ingredient Combines, none asks or is skipped', () => {
    addItem(listId, '2 lbs ground beef', USER);
    addItem(listId, '4 tortillas', USER);
    addItem(listId, '1 cup salsa', USER);
    addItem(listId, 'cilantro', USER);
    addItem(listId, '3 limes', USER);
    const added = addRecipeToList(listId, allAdds(), USER);
    expect(added.count).toBe(5);
    expect(added.results.map((r) => r?.kind)).toEqual(['combine', 'combine', 'combine', 'combine', 'combine']);
    // The recipe's cilantro has no amount: a link to the recipe, which adds nothing to the total.
    expect(added.results.map((r) => r?.totalAmountText)).toEqual(['3 lb', '12', '2 cup', '', '5']);
    expect(rows()).toEqual(['3 lb ground beef', '12 tortillas', '2 cup salsa', 'cilantro', '5 limes']);
  });

  test('each Combined amount is a recipe contribution, so the item groups under the recipe', () => {
    const beef = addItem(listId, '2 lbs ground beef', USER)!;
    addRecipeToList(listId, allAdds(2), USER);
    expect(contributionsQuery(beef.itemId).all().map((c) => [c.source, c.recipeId, c.quantity, c.unit])).toEqual([
      ['manual', null, 2, 'lb'],
      ['recipe', tacos, 2, 'lb'],
    ]);
  });

  test('a checked match is reopened with its amounts replaced', () => {
    const beef = addItem(listId, '5 lbs ground beef', USER)!;
    setItemChecked(beef.itemId, true, USER);
    const added = addRecipeToList(listId, allAdds(), USER);
    expect(added.results[0]).toMatchObject({ itemId: beef.itemId, kind: 'reopen' });
    expect(checkedRows()).toEqual([]);
    expect(rows()).toContain('1 lb ground beef');
    expect(contributionsQuery(beef.itemId).all().map((c) => [c.source, c.quantity])).toEqual([['recipe', 1]]);
  });
});

describe('Undo (spec 4.4)', () => {
  const allAdds = () => {
    const ingredients = recipeIngredientsQuery(tacos).all();
    return buildRecipeAdds(tacos, ingredients, new Set(ingredients.map((i) => i.id)), 1);
  };
  // Everything Undo must put back: every item (live or not), its checked state and live amounts,
  // and the household's use counts.
  const snapshot = () => ({
    items: db
      .select({ id: listItems.id, deletedAt: listItems.deletedAt, checkedAt: listItems.checkedAt, checkedBy: listItems.checkedBy })
      .from(listItems)
      .orderBy(listItems.id)
      .all()
      .map((i) => ({ ...i, amounts: contributionsQuery(i.id).all() })),
    usage: db
      .select({ key: ingredientUsage.ingredientName, n: ingredientUsage.useCount })
      .from(ingredientUsage)
      .orderBy(ingredientUsage.ingredientName)
      .all(),
    units: db
      .select({ key: ingredientUnitUsage.ingredientName, unit: ingredientUnitUsage.unitKey, n: ingredientUnitUsage.useCount })
      .from(ingredientUnitUsage)
      .orderBy(ingredientUnitUsage.ingredientName, ingredientUnitUsage.unitKey)
      .all(),
  });
  const live = (s: ReturnType<typeof snapshot>) => s.items.filter((i) => i.deletedAt === null).map(({ deletedAt: _, ...i }) => i);

  test('restores the list exactly: new items gone, Combined amounts and checked items as they were', () => {
    addItem(listId, '2 lbs ground beef', USER);
    addItem(listId, 'cilantro', USER);
    const limes = addItem(listId, '6 limes', USER)!;
    addItem(listId, 'limes', USER);
    setItemChecked(limes.itemId, true, USER);
    addItem(listId, 'milk', USER);
    const before = snapshot();
    const shownBefore = rows();

    const added = addRecipeToList(listId, allAdds(), USER);
    expect(rows()).not.toEqual(shownBefore);
    undoRecipeAdd(added);

    expect(rows()).toEqual(shownBefore);
    expect(rows()).toEqual(['2 lb ground beef', 'cilantro', 'milk']);
    const after = snapshot();
    expect(live(after)).toEqual(live(before));
    expect(after.usage).toEqual(before.usage);
    expect(after.units).toEqual(before.units);
    // The reopened limes are checked again with both of their old amounts.
    const limesAfter = after.items.find((i) => i.id === limes.itemId)!;
    expect(limesAfter.checkedAt).not.toBeNull();
    expect(limesAfter.amounts.map((c) => c.quantity)).toEqual([6, null]);
  });

  test('takes back a repeat folded into a new item in the same add', () => {
    addRecipeIngredient(tacos, '1 lb ground beef');
    const before = snapshot();
    const added = addRecipeToList(listId, allAdds(), USER);
    expect(rows()[0]).toBe('2 lb ground beef');
    undoRecipeAdd(added);
    expect(rows()).toEqual([]);
    expect(live(snapshot())).toEqual(live(before));
    expect(snapshot().usage).toEqual(before.usage);
  });

  test('an add of nothing has nothing to undo', () => {
    const before = snapshot();
    const added = addRecipeToList(listId, [], USER);
    expect(added).toEqual({ results: [], count: 0, pendingNames: [] });
    undoRecipeAdd(added);
    expect(snapshot()).toEqual(before);
  });

  test('is one step: a failure leaves the whole add in place', () => {
    addItem(listId, '2 lbs ground beef', USER);
    const added = addRecipeToList(listId, allAdds(), USER);
    const shown = rows();
    const broken = { ...added.results[0]!, itemId: 'missing' };
    expect(() => undoRecipeAdd({ results: [broken, ...added.results.slice(1)] })).toThrow(/No list item missing/);
    expect(rows()).toEqual(shown);
  });
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
    addRecipeToList(listId, buildRecipeAdds(tacos, ingredients, selected, 2), USER);
    expect(delta(before)).toEqual({ 'ground beef': 1, lime: 1, salsa: 1, tortilla: 1 });
  });

  test('a combined recipe ingredient still counts once', () => {
    addItem(listId, 'limes', USER);
    addItem(listId, 'salsa', USER);
    const ingredients = recipeIngredientsQuery(tacos).all();
    const all = new Set(ingredients.map((i) => i.id));
    const adds = buildRecipeAdds(tacos, ingredients, all, 1);
    const before = counts();
    addRecipeToList(listId, adds, USER);
    expect(delta(before)).toEqual({ cilantro: 1, 'ground beef': 1, lime: 1, salsa: 1, tortilla: 1 });
  });
});

describe('By recipe actions (spec 4.6)', () => {
  const addAll = (recipeId: string) => {
    const ingredients = recipeIngredientsQuery(recipeId).all();
    addRecipeToList(listId, buildRecipeAdds(recipeId, ingredients, new Set(ingredients.map((i) => i.id)), 1), USER);
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
