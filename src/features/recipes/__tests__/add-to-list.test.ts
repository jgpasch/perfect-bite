import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, households, ingredientUnitUsage, ingredientUsage, listItems } from '@/db';
import { groupByRecipe } from '@/domain/recipe-grouping';
import { setStaple, stapleNames } from '@/features/households/staples';

import {
  addItem,
  checkItems,
  contributionsQuery,
  groupItems,
  listItemsQuery,
  removeRecipeFromList,
  restoreRecipeOnList,
  setItemChecked,
  uncheckItems,
} from '@/features/lists/items';
import { createList, ensureStarterData, getDefaultListId, getList } from '@/features/lists/lists';
import { resetDb } from '@/test/db';

import {
  addedIngredientToast,
  addIngredientToList,
  addRecipeToList,
  addWholeRecipeToList,
  buildRecipeAdds,
  defaultSelection,
  ingredientMenuLists,
  recipeServesLabel,
  replaceRecipeAdd,
  servingsMultiplier,
  startingServings,
  undoRecipeAdd,
} from '../add-to-list';
import { addRecipeIngredient, createRecipe, deleteRecipe, recipeIngredientsQuery } from '../recipes';

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
  groupItems(listItemsQuery(listId).all()).unchecked.map((i) =>
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
    groupItems(listItemsQuery(listId).all()).checked.map((i) => (i.amountText ? `${i.amountText} ${i.displayName}` : i.displayName));

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
    const { unchecked } = groupItems(listItemsQuery(listId).all());
    const sections = groupByRecipe(unchecked);
    expect(sections.map((s) => s.name)).toEqual(['Lime soup', 'Tacos']);
    const limeInSoup = sections[0].entries[0];
    expect(limeInSoup).toMatchObject({ amountText: '3', alsoIn: ['Tacos'] });
    checkItems([limeInSoup.item.id], USER);
    const after = groupByRecipe(groupItems(listItemsQuery(listId).all()).unchecked);
    expect(after.map((s) => s.name)).toEqual(['Tacos']);
    expect(after[0].entries.map((e) => e.item.displayName)).not.toContain('limes');
  });

  test('remove recipe from list drops its amounts and deletes items left empty', () => {
    addItem(listId, '2 limes', USER);
    addAll(tacos);
    removeRecipeFromList(listId, tacos);
    expect(rows()).toEqual(['2 limes']);
  });

  test('Undo of remove recipe brings back its amounts and items', () => {
    addItem(listId, '2 limes', USER);
    addAll(tacos);
    const sections = () =>
      groupByRecipe(groupItems(listItemsQuery(listId).all()).unchecked).map((s) => [s.name, s.entries.length]);
    const before = [rows(), sections()];
    restoreRecipeOnList(removeRecipeFromList(listId, tacos));
    expect([rows(), sections()]).toEqual(before);
  });

  test('Undo of check all unchecks only what it checked', () => {
    addItem(listId, 'milk', USER);
    addAll(tacos);
    const milk = listItemsQuery(listId).all().find((i) => i.displayName === 'milk')!;
    checkItems([milk.id], USER);
    const all = listItemsQuery(listId).all().map((i) => i.id);
    const checked = checkItems(all, USER);
    expect(checked.ids).toHaveLength(5);
    expect(rows()).toEqual([]);
    uncheckItems(checked);
    expect(rows()).toHaveLength(5);
    expect(groupItems(listItemsQuery(listId).all()).checked.map((i) => i.displayName)).toEqual(['milk']);
  });
});

describe('a recipe picked in the add bar (spec 4.2)', () => {
  test('adds every ingredient at 1×, Combining with what is open', () => {
    addItem(listId, 'limes', USER);
    const added = addWholeRecipeToList(listId, tacos, USER)!;
    expect(added.recipeName).toBe('Tacos');
    expect(added.count).toBe(5);
    expect(added.results.map((r) => r?.kind)).toEqual(['new', 'new', 'new', 'new', 'combine']);
    expect(rows()).toEqual(['3 limes', '1 lb ground beef', '8 tortillas', '1 cup salsa', 'cilantro']);
    // Every item groups under the recipe.
    const sections = groupByRecipe(groupItems(listItemsQuery(listId).all()).unchecked);
    expect(sections.map((s) => [s.name, s.entries.length])).toEqual([['Tacos', 5]]);
  });

  test('Undo takes the whole add back', () => {
    addItem(listId, 'limes', USER);
    const added = addWholeRecipeToList(listId, tacos, USER)!;
    undoRecipeAdd(added);
    expect(rows()).toEqual(['limes']);
  });

  test('a deleted recipe adds nothing', () => {
    deleteRecipe(tacos);
    expect(addWholeRecipeToList(listId, tacos, USER)).toBeNull();
    expect(rows()).toEqual([]);
  });

  test('with no staples, nothing is skipped', () => {
    expect(addWholeRecipeToList(listId, tacos, USER)!.skipped).toEqual([]);
  });

  test('a recipe with no ingredients adds nothing', () => {
    const empty = createRecipe('Empty');
    const added = addWholeRecipeToList(listId, empty, USER)!;
    expect(added).toMatchObject({ recipeName: 'Empty', count: 0, results: [] });
    expect(rows()).toEqual([]);
  });

  describe('Adjust replaces that add', () => {
    test('with 2× and one ingredient unticked, the list is as if only the adjusted add happened', () => {
      addItem(listId, 'limes', USER);
      const first = addWholeRecipeToList(listId, tacos, USER)!;
      const ingredients = recipeIngredientsQuery(tacos).all();
      const selected = new Set(ingredients.filter((i) => i.displayName !== 'cilantro').map((i) => i.id));
      const adjusted = replaceRecipeAdd(first, listId, buildRecipeAdds(tacos, ingredients, selected, 2), USER);
      expect(adjusted.count).toBe(4);
      // Limes: the plain `limes` (counts as one) + 4 from the doubled recipe, not + 2 + 4.
      expect(rows()).toEqual(['5 limes', '2 lb ground beef', '16 tortillas', '2 cup salsa']);
      // Undo of the adjusted add leaves the list as it was before either.
      undoRecipeAdd(adjusted);
      expect(rows()).toEqual(['limes']);
    });

    test('a checked match reopened by the first add is reopened once, with the adjusted amount', () => {
      const tortillas = addItem(listId, '10 tortillas', USER)!;
      setItemChecked(tortillas.itemId, true, USER);
      const first = addWholeRecipeToList(listId, tacos, USER)!;
      const ingredients = recipeIngredientsQuery(tacos).all();
      const onlyTortillas = new Set(ingredients.filter((i) => i.displayName === 'tortillas').map((i) => i.id));
      replaceRecipeAdd(first, listId, buildRecipeAdds(tacos, ingredients, onlyTortillas, 0.5), USER);
      expect(rows()).toEqual(['4 tortillas']);
      const item = db.select().from(listItems).where(eq(listItems.id, tortillas.itemId)).get()!;
      expect(item.checkedAt).toBeNull();
    });

    test('adjusting to another list takes the first add off its own list', () => {
      const costco = createList('Costco');
      const first = addWholeRecipeToList(listId, tacos, USER)!;
      const ingredients = recipeIngredientsQuery(tacos).all();
      replaceRecipeAdd(first, costco, buildRecipeAdds(tacos, ingredients, new Set([ingredients[0].id]), 1), USER);
      expect(rows()).toEqual([]);
      expect(groupItems(listItemsQuery(costco).all()).unchecked.map((i) => `${i.amountText} ${i.displayName}`)).toEqual([
        '1 lb ground beef',
      ]);
    });
  });
});

describe('Always have: staples are left out of recipe adds (spec 4.5)', () => {
  let home: string;
  let soup: string;

  beforeEach(() => {
    home = getList(listId)!.householdId;
    soup = createRecipe('Soup');
    for (const text of ['2 carrots', 'Salt', 'sea salt', '1 tsp black pepper', 'water']) addRecipeIngredient(soup, text);
  });

  const names = (ids: ReadonlySet<string>) =>
    recipeIngredientsQuery(soup)
      .all()
      .filter((i) => ids.has(i.id))
      .map((i) => i.displayName);

  test('defaultSelection ticks everything but staples, matching by ingredient key', () => {
    setStaple(home, 'salt', true, USER);
    setStaple(home, 'water', true, USER);
    expect(names(defaultSelection(recipeIngredientsQuery(soup).all(), stapleNames(home)))).toEqual([
      'carrots',
      'sea salt',
      'black pepper',
    ]);
  });

  test('defaultSelection with no staples ticks everything', () => {
    const ingredients = recipeIngredientsQuery(soup).all();
    expect(defaultSelection(ingredients, new Set())).toEqual(new Set(ingredients.map((i) => i.id)));
  });

  test('the 1× add leaves staples out and names them: `Salt` matches `salt`, `sea salt` is added', () => {
    setStaple(home, 'salt', true, USER);
    setStaple(home, 'black pepper', true, USER);
    const added = addWholeRecipeToList(listId, soup, USER)!;
    expect(added.count).toBe(3);
    expect(added.skipped).toEqual(['Salt', 'black pepper']);
    expect(rows()).toEqual(['2 carrots', 'sea salt', 'water']);
  });

  test('a staple twice in the recipe is named once', () => {
    addRecipeIngredient(soup, 'salt');
    setStaple(home, 'salt', true, USER);
    const added = addWholeRecipeToList(listId, soup, USER)!;
    expect(added.skipped).toEqual(['Salt']);
    expect(added.count).toBe(4);
  });

  test('an unmarked staple is added again', () => {
    setStaple(home, 'salt', true, USER);
    setStaple(home, 'salt', false, USER);
    const added = addWholeRecipeToList(listId, soup, USER)!;
    expect(added.count).toBe(5);
    expect(added.skipped).toEqual([]);
    expect(rows()).toContain('Salt');
  });

  test("another household's staples don't count", () => {
    db.insert(households).values({ id: 'cabin', name: 'Cabin' }).run();
    setStaple('cabin', 'salt', true, USER);
    setStaple('cabin', 'water', true, USER);
    const added = addWholeRecipeToList(listId, soup, USER)!;
    expect(added.count).toBe(5);
    expect(added.skipped).toEqual([]);
  });

  test('a recipe of only staples adds nothing', () => {
    const seasoning = createRecipe('Seasoning');
    addRecipeIngredient(seasoning, 'salt');
    addRecipeIngredient(seasoning, 'pepper');
    setStaple(home, 'salt', true, USER);
    setStaple(home, 'pepper', true, USER);
    const added = addWholeRecipeToList(listId, seasoning, USER)!;
    expect(added).toMatchObject({ recipeName: 'Seasoning', count: 0, results: [], skipped: ['salt', 'pepper'] });
    expect(rows()).toEqual([]);
  });

  test('Undo of an add with skipped staples takes back only what it added', () => {
    addItem(listId, 'salt', USER);
    setStaple(home, 'salt', true, USER);
    undoRecipeAdd(addWholeRecipeToList(listId, soup, USER)!);
    expect(rows()).toEqual(['salt']);
  });
});

describe('by servings (board 17)', () => {
  const quantities = (adds: ReturnType<typeof buildRecipeAdds>) => adds.map((a) => ('parsed' in a ? a.parsed.quantity : undefined));

  test('starts at the chosen servings from the recipe screen, else the base', () => {
    expect(startingServings(4, '6')).toBe(6);
    expect(startingServings(4, '1')).toBe(1);
    expect(startingServings(4, '100')).toBe(100);
    expect(startingServings(4, undefined)).toBe(4);
    expect(startingServings(4, '')).toBe(4);
  });

  test('a bad chosen servings falls back to the base', () => {
    for (const param of ['0', '101', '-2', '2.5', 'six', ' ']) expect(startingServings(4, param)).toBe(4);
  });

  test('the multiplier is chosen ÷ base', () => {
    expect(servingsMultiplier(6, 4)).toBe(1.5);
    expect(servingsMultiplier(4, 4)).toBe(1);
    expect(servingsMultiplier(2, 4)).toBe(0.5);
    expect(servingsMultiplier(1, 3)).toBeCloseTo(1 / 3);
  });

  test('"Recipe serves 4"', () => {
    expect(recipeServesLabel(4)).toBe('Recipe serves 4');
    expect(recipeServesLabel(1)).toBe('Recipe serves 1');
  });

  test('for 6 when the recipe serves 4 adds 1.5× the amounts', () => {
    const ingredients = recipeIngredientsQuery(tacos).all();
    const adds = buildRecipeAdds(tacos, ingredients, new Set(ingredients.map((i) => i.id)), servingsMultiplier(6, 4));
    expect(quantities(adds)).toEqual([1.5, 12, 1.5, null, 3]);
    addRecipeToList(listId, adds, USER);
    expect(rows()).toEqual(['1.5 lb ground beef', '12 tortillas', '1½ cup salsa', 'cilantro', '3 limes']);
  });

  test('3 of 3 gives the amounts back exactly; 1 of 3 adds a third, rounded to kitchen measures', () => {
    const ingredients = recipeIngredientsQuery(tacos).all();
    const all = new Set(ingredients.map((i) => i.id));
    expect(quantities(buildRecipeAdds(tacos, ingredients, all, servingsMultiplier(3, 3)))).toEqual([1, 8, 1, null, 2]);
    // ⅓ lb → 0.25, 8⁄3 tortillas → 2.5, ⅓ cup, ⅔ lime → ½.
    const third = quantities(buildRecipeAdds(tacos, ingredients, all, servingsMultiplier(1, 3)));
    expect(third).toEqual([0.25, 2.5, 1 / 3, null, 0.5]);
  });

  test('a scaled add can change the unit, and that is what goes on the list', () => {
    const ingredients = recipeIngredientsQuery(tacos).all();
    const adds = buildRecipeAdds(tacos, ingredients, new Set(ingredients.map((i) => i.id)), servingsMultiplier(1, 8));
    expect(adds.map((a) => ('parsed' in a ? a.parsed.unit : undefined))).toEqual(['lb', null, 'tbsp', null, null]);
    expect(quantities(adds)).toEqual([0.25, 1, 2, null, 0.5]);
    addRecipeToList(listId, adds, USER);
    expect(rows()).toEqual(['0.25 lb ground beef', '1 tortillas', '2 tbsp salsa', 'cilantro', '½ limes']);
  });

  test('at 1× the amounts are added as written, not rounded', () => {
    const recipeId = createRecipe('Dressing');
    addRecipeIngredient(recipeId, '0.42 cup olive oil');
    addRecipeIngredient(recipeId, '33 g parmesan');
    const ingredients = recipeIngredientsQuery(recipeId).all();
    const adds = buildRecipeAdds(recipeId, ingredients, new Set(ingredients.map((i) => i.id)), 1);
    expect(adds.map((a) => ('parsed' in a ? [a.parsed.quantity, a.parsed.unit] : undefined))).toEqual([
      [0.42, 'cup'],
      [33, 'g'],
    ]);
  });
});

describe('one ingredient from the recipe screen (spec 4.5)', () => {
  const limes = () => recipeIngredientsQuery(tacos).all().find((i) => i.displayName === 'limes')!;

  test('adds just that ingredient, scaled, under the recipe', () => {
    const added = addIngredientToList(listId, tacos, limes(), 1.5, USER);
    expect(added.count).toBe(1);
    expect(rows()).toEqual(['3 limes']);
    expect(contributionsQuery(added.results[0]!.itemId).all().map((c) => c.recipeId)).toEqual([tacos]);
  });

  test('Combines with an open item, and Undo takes it back', () => {
    addItem(listId, '1 limes', USER);
    const added = addIngredientToList(listId, tacos, limes(), 1, USER);
    expect(added.results[0]?.kind).toBe('combine');
    expect(rows()).toEqual(['3 limes']);
    undoRecipeAdd(added);
    expect(rows()).toEqual(['1 limes']);
  });

  test('a staple is added anyway: it was picked', () => {
    const householdId = getList(listId)!.householdId;
    setStaple(householdId, 'lime', true, USER);
    expect(addIngredientToList(listId, tacos, limes(), 1, USER).count).toBe(1);
    expect(rows()).toEqual(['2 limes']);
  });

  test("the menu's lists: open ones in the household, the current one first", () => {
    const at = (id: string, householdId = 'h1', archivedAt: Date | null = null) => ({ id, householdId, archivedAt });
    const all = [at('a'), at('b'), at('c', 'h2'), at('d', 'h1', new Date())];
    expect(ingredientMenuLists(all, 'h1', 'b').map((l) => l.id)).toEqual(['b', 'a']);
    expect(ingredientMenuLists(all, 'h1', 'c').map((l) => l.id)).toEqual(['a', 'b']);
    expect(ingredientMenuLists(all, 'h1', null).map((l) => l.id)).toEqual(['a', 'b']);
    expect(ingredientMenuLists(all, 'h3', 'a')).toEqual([]);
  });

  test('the toast names the ingredient, in sentence case, and the list', () => {
    expect(addedIngredientToast('limes', 'Groceries')).toEqual({ message: 'Added Limes to Groceries', emphasis: 'Limes' });
  });
});
