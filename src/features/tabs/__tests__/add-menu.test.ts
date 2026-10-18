// The tab bar's + (spec 4.1): a tap always adds an item to a list; long-press offers the other ways to add.
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { ActionSheetIOS } from 'react-native';

import { i18n } from '@/i18n';

import { pressAddButton, takePendingListAdd } from '../add-button';
import { ADD_MENU_KEYS, addMenuEntries, runAddMenuItem, showAddMenuSheet } from '../add-menu';

const mockPush = jest.fn();
const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({
  router: { push: (...args: unknown[]) => mockPush(...args), navigate: (...args: unknown[]) => mockNavigate(...args) },
  useFocusEffect: () => {},
}));

beforeEach(() => {
  for (const fn of [mockPush, mockNavigate]) fn.mockClear();
  takePendingListAdd();
});

afterEach(async () => {
  await i18n.changeLanguage('en');
});

describe('ADD_MENU_KEYS', () => {
  test('only Add item and Add recipe: the link and photo imports live in the Add recipe sheet', () => {
    expect(ADD_MENU_KEYS).toEqual(['item', 'recipe']);
  });
});

describe('addMenuEntries', () => {
  test('labels and icons, in order', () => {
    const entries = addMenuEntries(ADD_MENU_KEYS);
    expect(entries.map(({ key, label, icon }) => [key, label, icon])).toEqual([
      ['item', 'Add item', 'plus'],
      ['recipe', 'Add recipe', 'book'],
    ]);
  });

  test('in Spanish', async () => {
    await i18n.changeLanguage('es');
    expect(addMenuEntries(ADD_MENU_KEYS).map((e) => e.label)).toEqual(['Agregar artículo', 'Agregar receta']);
    expect(i18n.t('tabs.addMore')).toBe('Más formas de agregar');
  });

  test("an entry's onPress runs its item", () => {
    addMenuEntries(['recipe'])[0].onPress();
    expect(mockPush).toHaveBeenCalledWith('/add-recipe');
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
    showAddMenuSheet(ADD_MENU_KEYS);
    const [options, choose] = sheet.mock.calls[0];
    expect(options).toEqual({ options: ['Add item', 'Add recipe', 'Cancel'], cancelButtonIndex: 2 });
    choose(2);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    choose(1);
    expect(mockPush.mock.calls).toEqual([['/add-recipe']]);
    sheet.mockRestore();
  });
});
