// The tab bar's + (spec 4.1): a tap always adds an item to a list; long-press offers the other ways to add.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ActionSheetIOS } from 'react-native';

import { i18n } from '@/i18n';

import { pressAddButton, takePendingListAdd } from '../add-button';
import { addMenuEntries, addMenuKeys, runAddMenuItem, showAddMenuSheet } from '../add-menu';

const mockPush = jest.fn();
const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args), navigate: (...args: unknown[]) => mockNavigate(...args) },
  useFocusEffect: () => {},
}));
const mockImportFromPhoto = jest.fn();
jest.mock('@/features/recipes/photo-import-prompts', () => ({ importRecipeFromPhoto: () => mockImportFromPhoto() }));

beforeEach(() => {
  for (const fn of [mockPush, mockNavigate, mockImportFromPhoto]) fn.mockClear();
  takePendingListAdd();
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('addMenuKeys', () => {
  test('Add item and Add recipe always; the link and photo imports with their features', () => {
    expect(addMenuKeys({ recipeImport: false, recipeImportPhoto: false })).toEqual(['item', 'recipe']);
    expect(addMenuKeys({ recipeImport: true, recipeImportPhoto: false })).toEqual(['item', 'recipe', 'link']);
    expect(addMenuKeys({ recipeImport: true, recipeImportPhoto: true })).toEqual(['item', 'recipe', 'link', 'photo']);
  });

  test('photo import shows without link import, as its own feature', () => {
    expect(addMenuKeys({ recipeImport: false, recipeImportPhoto: true })).toEqual(['item', 'recipe', 'photo']);
  });
});

describe('addMenuEntries', () => {
  test('labels and icons, in order', () => {
    const entries = addMenuEntries(['item', 'recipe', 'link', 'photo']);
    expect(entries.map(({ key, label, icon }) => [key, label, icon])).toEqual([
      ['item', 'Add item', 'plus'],
      ['recipe', 'Add recipe', 'book'],
      ['link', 'Add recipe from link', 'link'],
      ['photo', 'Add recipe from photo', 'camera'],
    ]);
  });

  test('in Spanish', async () => {
    await i18n.changeLanguage('es');
    expect(addMenuEntries(['item', 'recipe', 'link', 'photo']).map((e) => e.label)).toEqual([
      'Agregar artículo',
      'Agregar receta',
      'Agregar receta desde un enlace',
      'Agregar receta desde una foto',
    ]);
    expect(i18n.t('tabs.addMore')).toBe('Más formas de agregar');
  });

  test("an entry's onPress runs its item", () => {
    addMenuEntries(['link'])[0].onPress();
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/add-recipe', params: { focus: 'link' } });
  });
});

describe('runAddMenuItem', () => {
  test('Add item is the same as a tap on +: away from a list it opens the List tab with its add field', () => {
    runAddMenuItem('item');
    expect(mockNavigate.mock.calls).toEqual([['/lists']]);
    expect(mockPush).not.toHaveBeenCalled();
    expect(takePendingListAdd()).toBe(true);
    expect(takePendingListAdd()).toBe(false);
  });

  test('Add recipe opens the Add recipe sheet', () => {
    runAddMenuItem('recipe');
    expect(mockPush.mock.calls).toEqual([['/add-recipe']]);
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(takePendingListAdd()).toBe(false);
  });

  test('Add recipe from link opens the sheet with the link field focused', () => {
    runAddMenuItem('link');
    expect(mockPush.mock.calls).toEqual([[{ pathname: '/add-recipe', params: { focus: 'link' } }]]);
  });

  test('Add recipe from photo starts From photo…, not the sheet', () => {
    runAddMenuItem('photo');
    expect(mockImportFromPhoto).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
  });
});

describe('pressAddButton', () => {
  test('unclaimed (Recipes, Plan, Settings) it opens the List tab once, with its add field', () => {
    pressAddButton();
    expect(mockNavigate.mock.calls).toEqual([['/lists']]);
    expect(takePendingListAdd()).toBe(true);
  });
});

describe('showAddMenuSheet (VoiceOver)', () => {
  test('the same items and Cancel; choosing one runs it, Cancel runs nothing', () => {
    const sheet = jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation(() => {});
    showAddMenuSheet(['item', 'recipe', 'link']);
    const [options, choose] = sheet.mock.calls[0];
    expect(options).toEqual({ options: ['Add item', 'Add recipe', 'Add recipe from link', 'Cancel'], cancelButtonIndex: 3 });
    choose(3);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    choose(1);
    expect(mockPush.mock.calls).toEqual([['/add-recipe']]);
    sheet.mockRestore();
  });
});
