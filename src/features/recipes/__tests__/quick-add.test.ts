import { describe, expect, test } from '@jest/globals';

import { quickAddList, quickAddTitle, type QuickAddCandidate } from '../quick-add';
import { addedRecipeWithStaplesToast } from '../recipe-view';

const groceries: QuickAddCandidate = { id: 'groceries', name: 'Groceries', householdId: 'home', archivedAt: null };
const tacos = { householdId: 'home', ingredientCount: 6 };

describe('quickAddList', () => {
  test('is the current list when it is open, in the recipe household, and the recipe has ingredients', () => {
    expect(quickAddList(groceries, tacos)).toEqual({ id: 'groceries', name: 'Groceries' });
  });

  test('is null with no current list', () => {
    expect(quickAddList(null, tacos)).toBeNull();
    expect(quickAddList(undefined, tacos)).toBeNull();
  });

  test("is null for another household's list", () => {
    expect(quickAddList({ ...groceries, householdId: 'lake' }, tacos)).toBeNull();
  });

  test('is null for an archived list', () => {
    expect(quickAddList({ ...groceries, archivedAt: new Date('2026-10-01') }, tacos)).toBeNull();
  });

  test('is null when the recipe has no ingredients', () => {
    expect(quickAddList(groceries, { ...tacos, ingredientCount: 0 })).toBeNull();
  });

  test('a single ingredient is enough', () => {
    expect(quickAddList(groceries, { ...tacos, ingredientCount: 1 })).toEqual({ id: 'groceries', name: 'Groceries' });
  });
});

describe('quickAddTitle', () => {
  test('names the list', () => {
    expect(quickAddTitle('Groceries')).toBe('Add to Groceries');
    expect(quickAddTitle('Costco run')).toBe('Add to Costco run');
  });
});

describe('addedRecipeWithStaplesToast with a list name', () => {
  test('names the list on the first line', () => {
    expect(addedRecipeWithStaplesToast('Tacos', 6, [], 'Groceries')).toEqual({
      message: 'Added Tacos to Groceries · 6 items',
      emphasis: 'Tacos',
    });
    expect(addedRecipeWithStaplesToast('Tacos', 1, [], 'Groceries').message).toBe('Added Tacos to Groceries · 1 item');
  });

  test('keeps the skipped line', () => {
    expect(addedRecipeWithStaplesToast('Tacos', 6, ['salt', 'pepper'], 'Groceries').message).toBe(
      'Added Tacos to Groceries · 6 items\nSkipped salt, pepper',
    );
    expect(addedRecipeWithStaplesToast('Tacos', 2, ['salt', 'pepper', 'oil', 'water'], 'Groceries').message).toBe(
      'Added Tacos to Groceries · 2 items\nSkipped salt, pepper and 2 more',
    );
  });

  test('all staples: nothing added, the list is not named', () => {
    expect(addedRecipeWithStaplesToast('Tacos', 0, ['salt'], 'Groceries')).toEqual({
      message: 'You always have everything in Tacos',
      emphasis: 'Tacos',
    });
  });

  test('without a list name it reads as the add bar does', () => {
    expect(addedRecipeWithStaplesToast('Tacos', 6, ['salt']).message).toBe('Added Tacos · 6 items\nSkipped salt');
  });
});
