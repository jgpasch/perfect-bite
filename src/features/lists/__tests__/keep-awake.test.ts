import { describe, expect, jest, test } from '@jest/globals';

import { shoppingOnList } from '../keep-awake';

jest.mock('expo-keep-awake', () => ({ activateKeepAwakeAsync: jest.fn(), deactivateKeepAwake: jest.fn() }));
jest.mock('@/db/client', () => require('@/test/db'));

describe('shoppingOnList', () => {
  test('the List tab, this list\'s sheets and Your lists count', () => {
    expect(shoppingOnList('/lists', 'a')).toBe(true);
    expect(shoppingOnList('/list/a/item/x', 'a')).toBe(true);
    expect(shoppingOnList('/list/a/edit', 'a')).toBe(true);
    expect(shoppingOnList('/list/a/add-to-recipe', 'a')).toBe(true);
    expect(shoppingOnList('/lists-sheet', 'a')).toBe(true);
  });

  test('other tabs, other lists and other screens do not', () => {
    expect(shoppingOnList('/recipes', 'a')).toBe(false);
    expect(shoppingOnList('/settings', 'a')).toBe(false);
    expect(shoppingOnList('/list/b/item/x', 'a')).toBe(false);
    // An id that only starts with this one's.
    expect(shoppingOnList('/list/ab/edit', 'a')).toBe(false);
    expect(shoppingOnList('/recipe/r1', 'a')).toBe(false);
    expect(shoppingOnList('/import-recipe', 'a')).toBe(false);
    expect(shoppingOnList('/category-order', 'a')).toBe(false);
    expect(shoppingOnList('', 'a')).toBe(false);
  });
});
