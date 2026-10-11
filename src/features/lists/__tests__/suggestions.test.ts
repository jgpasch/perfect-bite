import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { db, households, ingredientUsage, lists } from '@/db';
import { loadCatalogSeed, searchCatalog } from '@/features/categories/categories';
import { addRecipeToList, buildRecipeAdds } from '@/features/recipes/add-to-list';
import { addRecipeIngredient, createRecipe, deleteRecipe, recipeIngredientsQuery } from '@/features/recipes/recipes';
import { resetDb } from '@/test/db';

import { addItem } from '../items';
import { ensureStarterData, getDefaultListId } from '../lists';
import {
  applySuggestion,
  getRecipeSuggestions,
  getSuggestions,
  suggestionCaption,
  suggestionChips,
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

  test('adding a recipe to a list makes it the most recently used match', () => {
    jest.useFakeTimers({ now: new Date(NOW.getTime() - 2 * MINUTE) });
    const tacos = recipeWith('Tacos', ['8 tortillas']);
    jest.setSystemTime(new Date(NOW.getTime() - MINUTE));
    recipeWith('Tagine', ['1 lamb shoulder']);
    expect(getRecipeSuggestions(householdId, 'ta').map((r) => r.name)).toEqual(['Tagine', 'Tacos']);
    jest.setSystemTime(NOW);
    addToList(tacos);
    expect(getRecipeSuggestions(householdId, 'ta').map((r) => r.name)).toEqual(['Tacos', 'Tagine']);
  });
});

describe('suggestionChips (spec 4.2, add mode chip row)', () => {
  const sources = {
    recipes: [{ id: 'r1', name: 'Chili night', ingredientCount: 8 }],
    suggestions: [
      { key: 'chicken thigh', displayName: 'Chicken thighs', source: 'history' as const },
      { key: 'chickpea', displayName: 'Chickpeas', source: 'catalog' as const },
    ],
  };

  test('while typing: matching recipes, then history, then catalog, keeping the typed amount', () => {
    expect(suggestionChips('2 lbs chi', sources)).toEqual([
      { kind: 'recipe', key: 'recipe-r1', recipe: sources.recipes[0] },
      { kind: 'item', key: 'chicken thigh', label: 'Chicken thighs', text: '2 lbs Chicken thighs', removable: true },
      { kind: 'item', key: 'chickpea', label: 'Chickpeas', text: '2 lbs Chickpeas', removable: false },
    ]);
  });

  test('with the field empty or blank: no chips, even with sources to offer', () => {
    expect(suggestionChips('', sources)).toEqual([]);
    expect(suggestionChips('  ', sources)).toEqual([]);
    expect(suggestionChips('\n\t', sources)).toEqual([]);
  });

  test('clearing the text hides the row again', () => {
    expect(suggestionChips('chi', sources)).toHaveLength(3);
    expect(suggestionChips('', sources)).toEqual([]);
  });

  test('one typed character is enough for the row, if there are chips', () => {
    expect(suggestionChips('c', { recipes: [], suggestions: [sources.suggestions[0]] })).toEqual([
      { kind: 'item', key: 'chicken thigh', label: 'Chicken thighs', text: 'Chicken thighs', removable: true },
    ]);
  });

  test('on a real household: typing shows matching recipes and history, the empty field shows nothing', () => {
    addItem(listId, 'chicken thighs', USER);
    addItem(listId, 'chicken thighs', USER);
    addItem(listId, 'chicken breasts', USER);
    const chili = createRecipe('Chili night', householdId);
    addRecipeIngredient(chili, 'kidney beans');
    const chips = (text: string) =>
      suggestionChips(text, { recipes: getRecipeSuggestions(householdId, text), suggestions: getSuggestions(householdId, text) });
    expect(chips('chi').map((c) => (c.kind === 'recipe' ? c.recipe.name : c.label))).toEqual([
      'Chili night',
      'Chicken thighs',
      'Chicken breasts',
    ]);
    expect(chips('')).toEqual([]);
  });

  test('labels show names in sentence case; the text a chip adds keeps the stored name', () => {
    const lower = {
      recipes: [],
      suggestions: [
        { key: 'chicken thigh', displayName: 'chicken thighs', source: 'history' as const },
        { key: 'iphone charger', displayName: 'iPhone charger', source: 'history' as const },
      ],
    };
    expect(suggestionChips('2 lbs chi', lower)).toEqual([
      { kind: 'item', key: 'chicken thigh', label: 'Chicken thighs', text: '2 lbs chicken thighs', removable: true },
      { kind: 'item', key: 'iphone charger', label: 'iPhone charger', text: '2 lbs iPhone charger', removable: true },
    ]);
  });

  test('nothing to offer: no chips, so the row collapses', () => {
    expect(suggestionChips('zz', { recipes: [], suggestions: [] })).toEqual([]);
    expect(suggestionChips('', { recipes: [], suggestions: [] })).toEqual([]);
  });
});
