import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, households, ingredientUsage, lists } from '@/db';
import { loadCatalogSeed, searchCatalog } from '@/features/categories/categories';
import { addRecipeToList, buildRecipeAdds } from '@/features/recipes/add-to-list';
import { addRecipeIngredient, createRecipe, deleteRecipe, recipeIngredientsQuery } from '@/features/recipes/recipes';
import { parseQuantity } from '@/shared';
import { resetDb } from '@/test/db';

import { addItem, deleteItem, setItemChecked, undoAdd } from '../items';
import { createList, ensureStarterData, getDefaultListId } from '../lists';
import {
  applySuggestion,
  getRecentItems,
  getRecentRecipes,
  getRecipeSuggestions,
  getSuggestions,
  suggestionCaption,
} from '../suggestions';
import { hideFromSuggestions } from '../usage';

jest.mock('@/db/client', () => require('@/test/db'));

const USER = 'user-1';
let listId: string;
let householdId: string;

beforeEach(() => {
  resetDb();
  loadCatalogSeed();
  ensureStarterData(USER);
  listId = getDefaultListId(USER)!;
  householdId = db.select({ id: lists.householdId }).from(lists).where(eq(lists.id, listId)).get()!.id;
});

const catalog = (q: string, limit = 5) => searchCatalog(q, limit).map((r) => ({ ...r, source: 'catalog' }));

describe('getSuggestions (spec 4.2)', () => {
  test('with 2 or more history matches, shows only history', () => {
    addItem(listId, 'chicken thighs', USER);
    addItem(listId, 'chicken thighs', USER);
    addItem(listId, 'chicken breasts', USER);
    expect(getSuggestions(householdId, 'chi')).toEqual([
      { key: 'chicken thigh', displayName: 'chicken thighs', source: 'history' },
      { key: 'chicken breast', displayName: 'chicken breasts', source: 'history' },
    ]);
    // The catalog does have chicken salad; history keeps it out.
    expect(catalog('chi', 50).map((s) => s.displayName)).toContain('chicken salad');
  });

  test('history-only results are capped at the limit', () => {
    for (const name of ['chicken thighs', 'chicken breasts', 'chicken wings', 'chili flakes']) addItem(listId, name, USER);
    const out = getSuggestions(householdId, 'chi', 3);
    expect(out).toHaveLength(3);
    expect(out.every((s) => s.source === 'history')).toBe(true);
  });

  test('with one history match, the catalog fills the rest after it, deduped by key', () => {
    addItem(listId, 'chicken sausage from the butcher', USER);
    const out = getSuggestions(householdId, 'chick');
    expect(out[0]).toEqual({
      key: 'chicken sausage from the butcher',
      displayName: 'chicken sausage from the butcher',
      source: 'history',
    });
    expect(out.slice(1)).toEqual(catalog('chick').slice(0, 4));
    expect(out).toHaveLength(5);

    // A history entry the catalog also has appears once, as history.
    resetDb();
    loadCatalogSeed();
    ensureStarterData(USER);
    listId = getDefaultListId(USER)!;
    householdId = db.select({ id: lists.householdId }).from(lists).where(eq(lists.id, listId)).get()!.id;
    addItem(listId, 'Chickpeas', USER);
    const deduped = getSuggestions(householdId, 'chick');
    expect(deduped[0]).toEqual({ key: 'chickpea', displayName: 'Chickpeas', source: 'history' });
    expect(deduped.filter((s) => s.key === 'chickpea')).toHaveLength(1);
    expect(deduped.slice(1).every((s) => s.source === 'catalog')).toBe(true);
  });

  test('with no history, returns the catalog results unchanged', () => {
    const out = getSuggestions(householdId, 'chi');
    expect(out).toEqual(catalog('chi'));
    expect(getSuggestions(householdId, 'chic').map((s) => s.displayName)).toContain('chicken');
    expect(out.every((s) => s.source === 'catalog')).toBe(true);
  });

  test('history drops out as the user keeps typing, so catalog items still appear', () => {
    addItem(listId, 'chicken thighs', USER);
    addItem(listId, 'chicken breasts', USER);
    const out = getSuggestions(householdId, 'chickp');
    expect(out[0]).toEqual({ key: 'chickpea', displayName: 'chickpeas', source: 'catalog' });
    expect(out.every((s) => s.source === 'catalog')).toBe(true);
  });

  test('`2 lbs chi` behaves the same as `chi`', () => {
    addItem(listId, 'chicken thighs', USER);
    addItem(listId, 'chicken breasts', USER);
    expect(getSuggestions(householdId, '2 lbs chi')).toEqual(getSuggestions(householdId, 'chi'));
    expect(getSuggestions(householdId, '2 lbs chi')).toHaveLength(2);
    // And with no history.
    expect(getSuggestions(householdId, '2 lbs zucc')).toEqual(getSuggestions(householdId, 'zucc'));
  });

  test('a history match identical to the typed name is still shown first', () => {
    addItem(listId, 'chicken', USER);
    const out = getSuggestions(householdId, 'Chicken');
    expect(out[0]).toEqual({ key: 'chicken', displayName: 'chicken', source: 'history' });
    expect(out.filter((s) => s.key === 'chicken')).toHaveLength(1);
    expect(out.slice(1).every((s) => s.source === 'catalog')).toBe(true);
  });

  test('a catalog suggestion identical to the typed name is skipped', () => {
    expect(catalog('chicken').map((s) => s.displayName)).toContain('chicken');
    expect(getSuggestions(householdId, 'chicken').map((s) => s.displayName)).not.toContain('chicken');
  });

  test('hidden history rows and other households are not history matches', () => {
    addItem(listId, 'chicken thighs', USER);
    addItem(listId, 'chicken breasts', USER);
    db.update(ingredientUsage).set({ hiddenAt: new Date() }).where(eq(ingredientUsage.ingredientName, 'chicken breast')).run();
    const out = getSuggestions(householdId, 'chi');
    expect(out[0]).toEqual({ key: 'chicken thigh', displayName: 'chicken thighs', source: 'history' });
    expect(out.slice(1).every((s) => s.source === 'catalog')).toBe(true);
    // The hidden key can still come back from the catalog.
    expect(getSuggestions(householdId, 'chicken bre')[0]).toEqual({
      key: 'chicken breast',
      displayName: 'chicken breasts',
      source: 'catalog',
    });

    db.insert(households).values({ id: 'h-other', name: 'Other' }).run();
    expect(getSuggestions('h-other', 'chi')).toEqual(catalog('chi'));
  });

  test('returns [] for text shorter than 2 characters', () => {
    addItem(listId, 'chicken thighs', USER);
    expect(getSuggestions(householdId, 'c')).toEqual([]);
    expect(getSuggestions(householdId, '2 lbs c')).toEqual([]);
    expect(getSuggestions(householdId, '   ')).toEqual([]);
  });

  test('applySuggestion keeps the typed amount for either source', () => {
    addItem(listId, 'chicken thighs', USER);
    const [history] = getSuggestions(householdId, '2 lbs chi');
    expect(history.source).toBe('history');
    expect(applySuggestion('2 lbs chi', history)).toBe('2 lbs chicken thighs');
    const [catalogHit] = getSuggestions(householdId, '1 can chickp');
    expect(catalogHit.source).toBe('catalog');
    expect(applySuggestion('1 can chickp', catalogHit)).toBe('1 can chickpeas');
  });
});

describe('Remove from suggestions (spec 4.2)', () => {
  test('a hidden history row is excluded from getSuggestions', () => {
    addItem(listId, 'chicken thighs', USER);
    addItem(listId, 'chicken breasts', USER);
    addItem(listId, 'chili flakes', USER);
    hideFromSuggestions(householdId, 'chicken breast');
    const out = getSuggestions(householdId, 'chi');
    expect(out).toHaveLength(2);
    expect(out).toEqual(
      expect.arrayContaining([
        { key: 'chicken thigh', displayName: 'chicken thighs', source: 'history' },
        { key: 'chili flake', displayName: 'chili flakes', source: 'history' },
      ]),
    );
  });

  test('hiding drops history below 2, so the catalog fills in again', () => {
    addItem(listId, 'chicken thighs', USER);
    addItem(listId, 'chicken sausage from the butcher', USER);
    expect(getSuggestions(householdId, 'chi').every((s) => s.source === 'history')).toBe(true);
    hideFromSuggestions(householdId, 'chicken sausage from the butcher');
    const out = getSuggestions(householdId, 'chi');
    expect(out[0]).toEqual({ key: 'chicken thigh', displayName: 'chicken thighs', source: 'history' });
    expect(out.map((s) => s.key)).not.toContain('chicken sausage from the butcher');
    expect(out.slice(1)).toEqual(catalog('chi').filter((s) => s.key !== 'chicken thigh').slice(0, 4));
  });

  test('a hidden row comes back as history after a new use', () => {
    addItem(listId, 'chicken thighs', USER);
    addItem(listId, 'chicken breasts', USER);
    hideFromSuggestions(householdId, 'chicken thigh');
    expect(getSuggestions(householdId, 'chi').map((s) => s.key)).not.toContain('chicken thigh');

    addItem(listId, '2 lbs Chicken Thighs', USER);
    // Back with its 2 uses, so it ranks first again.
    expect(getSuggestions(householdId, 'chi')).toEqual([
      { key: 'chicken thigh', displayName: 'Chicken Thighs', source: 'history' },
      { key: 'chicken breast', displayName: 'chicken breasts', source: 'history' },
    ]);
  });

  test('hiding a key with no history row changes nothing', () => {
    hideFromSuggestions(householdId, 'chicken');
    expect(getSuggestions(householdId, 'chi')).toEqual(catalog('chi'));
    expect(db.select().from(ingredientUsage).all()).toEqual([]);
  });

  test('hiding in another household leaves this one alone', () => {
    db.insert(households).values({ id: 'h-other', name: 'Other' }).run();
    addItem(listId, 'chicken thighs', USER);
    addItem(listId, 'chicken breasts', USER);
    hideFromSuggestions('h-other', 'chicken thigh');
    expect(getSuggestions(householdId, 'chi').map((s) => s.key).sort()).toEqual(['chicken breast', 'chicken thigh']);
  });
});

describe('suggestionCaption (board 03)', () => {
  test('says YOU USUALLY BUY when household history leads', () => {
    addItem(listId, 'chicken thighs', USER);
    const suggestions = getSuggestions(householdId, 'chi');
    expect(suggestions[0].source).toBe('history');
    expect(suggestionCaption(suggestions)).toBe('YOU USUALLY BUY');
  });

  test('says SUGGESTIONS for catalog-only suggestions', () => {
    const suggestions = getSuggestions(householdId, 'chi');
    expect(suggestions.every((s) => s.source === 'catalog')).toBe(true);
    expect(suggestionCaption(suggestions)).toBe('SUGGESTIONS');
  });

  test('says SUGGESTIONS for none', () => {
    expect(suggestionCaption([])).toBe('SUGGESTIONS');
  });
});

describe('getRecentItems (spec 4.2, RECENTLY USED)', () => {
  const NOW = new Date('2026-10-10T12:00:00Z');
  const DAY = 24 * 60 * 60 * 1000;

  afterEach(() => {
    jest.useRealTimers();
  });

  /** A history row that isn't on any list. */
  const history = (displayName: string, useCount: number, daysAgo: number, hid = householdId) =>
    db
      .insert(ingredientUsage)
      .values({
        householdId: hid,
        ingredientName: displayName,
        displayName,
        useCount,
        lastUsedAt: new Date(NOW.getTime() - daysAgo * DAY),
      })
      .run();

  /** Adds `text` and checks it off, so it's in history but not unchecked on the list. */
  const addChecked = (text: string, list = listId) => setItemChecked(addItem(list, text, USER)!.itemId, true, USER);

  const recent = (limit?: number) => getRecentItems(householdId, listId, limit, NOW);
  const keys = (limit?: number) => recent(limit).map((r) => r.key);

  test('orders by frecency, ties by shorter name then alphabetical', () => {
    history('apples', 4, 60); // 4 * 0.25 = 1
    history('bread', 3, 0); // 3
    history('cheese', 2, 0); // 2
    history('dill', 1, 30); // 0.5
    history('kale', 1, 0); // 1, ties with apples and eggs
    history('eggs', 1, 0);
    expect(keys()).toEqual(['bread', 'cheese', 'eggs', 'kale', 'apples', 'dill']);
  });

  test('a recent use outranks a higher count that has decayed', () => {
    history('flour', 10, 150); // 10 / 32 ≈ 0.31
    history('basil', 1, 0); // 1
    expect(keys()).toEqual(['basil', 'flour']);
  });

  test('leaves out ingredients already unchecked on this list, matched by key', () => {
    addItem(listId, '2 lbs chicken thighs', USER);
    addItem(listId, 'milk', USER);
    history('bread', 1, 0);
    expect(keys()).toEqual(['bread']);
  });

  test('includes checked items, deleted items, and items unchecked only on another list', () => {
    addChecked('milk');
    deleteItem(addItem(listId, 'eggs', USER)!.itemId);
    addItem(createList('Costco', householdId), 'rice', USER);
    expect(keys().sort()).toEqual(['egg', 'milk', 'rice']);
  });

  test('a checked item shows until its text is added back, then leaves the panel', () => {
    const { itemId } = addItem(listId, 'milk', USER)!;
    expect(keys()).toEqual([]);
    setItemChecked(itemId, true, USER);
    expect(keys()).toEqual(['milk']);
    // Tapping the row adds its text, which reopens the checked item.
    const result = addItem(listId, recent()[0].text, USER)!;
    expect(result.itemId).toBe(itemId);
    expect(keys()).toEqual([]);
  });

  test('leaves out hidden rows until the ingredient is used again', () => {
    history('bread', 1, 0);
    addChecked('milk');
    hideFromSuggestions(householdId, 'milk');
    expect(keys()).toEqual(['bread']);
    addChecked('milk');
    expect(keys()).toContain('milk');
  });

  test("only shows this household's history, and an undone add takes its row back", () => {
    db.insert(households).values({ id: 'h-other', name: 'Other' }).run();
    history('caviar', 9, 0, 'h-other');
    undoAdd(addItem(listId, 'tofu', USER)!);
    expect(keys()).toEqual([]);
  });

  test('caps at 30 by default, honours a smaller limit, and gives nothing for 0', () => {
    for (let i = 0; i < 35; i++) history(`item ${String(i).padStart(2, '0')}`, 35 - i, 0);
    expect(keys()).toHaveLength(30);
    expect(keys()[0]).toBe('item 00');
    expect(keys()[29]).toBe('item 29');
    expect(keys(3)).toEqual(['item 00', 'item 01', 'item 02']);
    expect(keys(0)).toEqual([]);
  });

  test('an empty history gives nothing', () => {
    expect(getRecentItems(householdId, listId)).toEqual([]);
  });

  test('the text is the last amount and name, and parses back to the same amount', () => {
    addChecked('2 lbs chicken thighs');
    addChecked('1 1/2 cups milk');
    addChecked('3 avocados');
    addChecked('bread');
    const byKey = new Map(recent().map((r) => [r.key, r]));
    expect(byKey.get('chicken thigh')).toEqual({ key: 'chicken thigh', displayName: 'chicken thighs', text: '2 lb chicken thighs' });
    expect(byKey.get('milk')!.text).toBe('1½ cup milk');
    expect(byKey.get('avocado')!.text).toBe('3 avocados');
    expect(byKey.get('bread')!.text).toBe('bread');
    expect(parseQuantity(byKey.get('chicken thigh')!.text)).toEqual({ quantity: 2, unit: 'lb', name: 'chicken thighs' });
    expect(parseQuantity(byKey.get('milk')!.text)).toEqual({ quantity: 1.5, unit: 'cup', name: 'milk' });
  });

  test('the text follows the latest use, from a list or a recipe', () => {
    jest.useFakeTimers({ now: new Date(NOW.getTime() - 3 * DAY) });
    addChecked('2 lbs chicken thighs');
    jest.setSystemTime(new Date(NOW.getTime() - 2 * DAY));
    addChecked('chicken thighs');
    expect(recent()[0].text).toBe('chicken thighs');

    jest.setSystemTime(new Date(NOW.getTime() - DAY));
    addRecipeIngredient(createRecipe('Curry'), '500 g chicken thighs');
    expect(recent()[0].text).toBe('500 g chicken thighs');

    jest.setSystemTime(NOW);
    addChecked('3 lbs chicken thighs');
    expect(recent()[0].text).toBe('3 lb chicken thighs');
  });
});

describe('recipes in the add bar (spec 4.2)', () => {
  const NOW = new Date('2026-10-10T12:00:00Z');
  const MINUTE = 60 * 1000;

  afterEach(() => {
    jest.useRealTimers();
  });

  const recipeWith = (name: string, ingredients: string[], inHousehold = householdId) => {
    const id = createRecipe(name, inHousehold);
    for (const text of ingredients) addRecipeIngredient(id, text);
    return id;
  };

  const addToList = (recipeId: string) => {
    const ingredients = recipeIngredientsQuery(recipeId).all();
    addRecipeToList(listId, buildRecipeAdds(recipeId, ingredients, new Set(ingredients.map((i) => i.id)), 1), USER);
  };

  test('matches the household recipe by name, with its ingredient count', () => {
    const tacos = recipeWith('Tacos', ['1 lb ground beef', '8 tortillas', 'limes']);
    expect(getRecipeSuggestions(householdId, 'tac')).toEqual([{ id: tacos, name: 'Tacos', ingredientCount: 3 }]);
    expect(getRecipeSuggestions(householdId, 'TACOS')).toEqual([{ id: tacos, name: 'Tacos', ingredientCount: 3 }]);
    expect(getRecipeSuggestions(householdId, 'beef')).toEqual([]);
  });

  test('only this household, and no recipe with no ingredients', () => {
    db.insert(households).values({ id: 'lake', name: 'Lake house' }).run();
    recipeWith('Tagine', ['1 lamb shoulder'], 'lake');
    recipeWith('Tahini sauce', []);
    const tacos = recipeWith('Tacos', ['8 tortillas']);
    expect(getRecipeSuggestions(householdId, 'ta').map((r) => r.id)).toEqual([tacos]);
    expect(getRecipeSuggestions('lake', 'ta').map((r) => r.name)).toEqual(['Tagine']);
  });

  test('a typed amount, a single letter or a deleted recipe matches nothing', () => {
    const tacos = recipeWith('Tacos', ['8 tortillas']);
    expect(getRecipeSuggestions(householdId, '2 ta')).toEqual([]);
    expect(getRecipeSuggestions(householdId, 't')).toEqual([]);
    expect(getRecipeSuggestions(householdId, '')).toEqual([]);
    deleteRecipe(tacos);
    expect(getRecipeSuggestions(householdId, 'tacos')).toEqual([]);
  });

  test('up to 2 recipe rows by default, most recently used first', () => {
    jest.useFakeTimers({ now: new Date(NOW.getTime() - 3 * MINUTE) });
    recipeWith('Tacos', ['8 tortillas']);
    jest.setSystemTime(new Date(NOW.getTime() - 2 * MINUTE));
    recipeWith('Tagine', ['1 lamb shoulder']);
    jest.setSystemTime(new Date(NOW.getTime() - MINUTE));
    recipeWith('Tamales', ['masa']);
    expect(getRecipeSuggestions(householdId, 'ta').map((r) => r.name)).toEqual(['Tamales', 'Tagine']);
    expect(getRecipeSuggestions(householdId, 'ta', 5).map((r) => r.name)).toEqual(['Tamales', 'Tagine', 'Tacos']);
  });

  test("recipes don't push item suggestions out", () => {
    for (const name of ['taco shells', 'tahini', 'tamarind', 'tarragon', 'tater tots', 'tangerines']) addItem(listId, name, USER);
    const itemsBefore = getSuggestions(householdId, 'ta');
    expect(itemsBefore).toHaveLength(5);
    recipeWith('Tacos', ['taco shells', '1 lb ground beef']);
    recipeWith('Tagine', ['1 lamb shoulder']);
    expect(getRecipeSuggestions(householdId, 'ta').map((r) => r.name)).toHaveLength(2);
    // Same five item suggestions, all history, no recipe among them.
    const itemsAfter = getSuggestions(householdId, 'ta');
    expect(itemsAfter.map((s) => s.source)).toEqual(['history', 'history', 'history', 'history', 'history']);
    expect(itemsAfter.map((s) => s.displayName)).not.toContain('Tacos');
    expect(itemsAfter.map((s) => s.displayName)).not.toContain('Tagine');
  });

  test('recently added recipes: only ones added to a list, latest add first, up to 3', () => {
    const ids: Record<string, string> = {};
    for (const name of ['Tacos', 'Dal', 'Pho', 'Ramen']) ids[name] = recipeWith(name, [`${name} base`]);
    recipeWith('Never added', ['salt']);
    expect(getRecentRecipes(householdId)).toEqual([]);

    const order = ['Tacos', 'Dal', 'Pho', 'Ramen', 'Dal'];
    jest.useFakeTimers({ now: NOW });
    order.forEach((name, i) => {
      jest.setSystemTime(new Date(NOW.getTime() + i * MINUTE));
      addToList(ids[name]);
    });
    expect(getRecentRecipes(householdId)).toEqual([
      { id: ids.Dal, name: 'Dal', ingredientCount: 1 },
      { id: ids.Ramen, name: 'Ramen', ingredientCount: 1 },
      { id: ids.Pho, name: 'Pho', ingredientCount: 1 },
    ]);
    expect(getRecentRecipes(householdId, 10).map((r) => r.name)).toEqual(['Dal', 'Ramen', 'Pho', 'Tacos']);
  });

  test('recently added recipes are only this household', () => {
    db.insert(households).values({ id: 'lake', name: 'Lake house' }).run();
    const tacos = recipeWith('Tacos', ['8 tortillas']);
    addToList(tacos);
    expect(getRecentRecipes('lake')).toEqual([]);
    expect(getRecentRecipes(householdId).map((r) => r.id)).toEqual([tacos]);
  });
});
