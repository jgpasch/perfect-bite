import { describe, expect, test } from '@jest/globals';

import { recipeHue } from '@/domain/aisle-color';
import { i18n } from '@/i18n';

import type { ImportRecipeSuccess } from '../import';
import {
  importedNotification,
  importFailedNotification,
  importingNotification,
  importNotificationId,
  photoImportFailedNotification,
  savedNotification,
} from '../import-notifications';

const success: ImportRecipeSuccess = {
  ok: true,
  recipeId: 'r1',
  recipeName: 'Chicken tikka masala',
  listId: 'groceries',
  created: true,
  added: 12,
  combined: 0,
  undo: () => {},
};

describe('importingNotification', () => {
  test('the recipe tile, "Importing your recipe", and no tap action', () => {
    expect(importingNotification('recipe-import-x')).toEqual({
      id: 'recipe-import-x',
      kind: 'recipeImport',
      icon: 'fork.knife',
      hue: recipeHue('recipe-import-x'),
      tone: 'success',
      title: 'Importing your recipe',
      body: "We'll let you know when it's ready.",
    });
  });

  test('in Spanish', () => {
    i18n.changeLanguage('es');
    try {
      expect(importingNotification('a')).toMatchObject({
        title: 'Importando tu receta',
        body: 'Te avisaremos cuando esté lista.',
      });
    } finally {
      i18n.changeLanguage('en');
    }
  });
});

describe('importNotificationId', () => {
  test('a new recipe-import id each time', () => {
    const a = importNotificationId();
    const b = importNotificationId();
    expect(a).toMatch(/^recipe-import-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(b).not.toBe(a);
  });
});

describe('importedNotification', () => {
  test('names the recipe, the count and the list, the name in bold', () => {
    const n = importedNotification(success, 'Groceries');
    expect(n).toMatchObject({
      kind: 'recipeImport',
      tone: 'success',
      title: 'Recipe added',
      body: 'Added Chicken tikka masala · 12 items to Groceries',
      emphasis: 'Chicken tikka masala',
      hint: 'Opens Groceries',
      hue: recipeHue('r1'),
    });
  });

  test('one item is singular', () => {
    expect(importedNotification({ ...success, added: 1 }, 'Groceries').body).toBe(
      'Added Chicken tikka masala · 1 item to Groceries',
    );
  });
});

describe('savedNotification', () => {
  test('a recipe-only import names the recipe and the household, the name in bold, and opens the recipe', () => {
    const n = savedNotification({ ...success, listId: null, added: 0 }, 'Smith home');
    expect(n).toEqual({
      id: 'recipe-import-r1',
      kind: 'recipeImport',
      icon: 'fork.knife',
      hue: recipeHue('r1'),
      tone: 'success',
      title: 'Recipe saved',
      body: 'Saved Chicken tikka masala to Smith home',
      emphasis: 'Chicken tikka masala',
      hint: 'Opens the recipe',
    });
  });

  test('a reused recipe says the same, with no item count', () => {
    const n = savedNotification({ ...success, listId: null, added: 0, created: false }, 'Personal');
    expect(n.body).toBe('Saved Chicken tikka masala to Personal');
    expect(n.body).not.toContain('item');
  });
});

describe('importFailedNotification', () => {
  test("gives the sheet's reason", () => {
    const n = importFailedNotification({ ok: false, error: 'not_a_recipe' }, 'https://example.com/news');
    expect(n).toMatchObject({ tone: 'warning', title: "Couldn't import recipe", body: "That page doesn't look like a recipe" });
  });

  test('a second failure for the same link replaces the first', () => {
    const a = importFailedNotification({ ok: false, error: 'rate_limited' }, 'https://example.com/dal');
    const b = importFailedNotification({ ok: false, error: 'offline' }, 'https://example.com/dal');
    expect(a.id).toBe(b.id);
  });
});

describe('photoImportFailedNotification', () => {
  test.each([
    [{ ok: false, error: 'not_a_recipe' } as const, "That photo doesn't look like a recipe"],
    [{ ok: false, error: 'not_entitled' } as const, "Photo import isn't in your plan"],
    [{ ok: false, error: 'rate_limited' } as const, 'Try again in a minute'],
    [{ ok: false, error: 'offline' } as const, "You're offline"],
  ])("gives the photo sheet's reason for %o, and says it opens Add recipe", (error, body) => {
    expect(photoImportFailedNotification(error)).toMatchObject({
      id: 'recipe-import-failed-photo',
      kind: 'recipeImport',
      tone: 'warning',
      hue: 'rose',
      title: "Couldn't import recipe",
      body,
      hint: 'Opens Add recipe to try again',
    });
  });

  test('with its pages kept (a failed_imports row), it says it opens the photos instead', () => {
    expect(photoImportFailedNotification({ ok: false, error: 'rate_limited', failedImportId: 'f1' })).toMatchObject({
      body: 'Try again in a minute',
      hint: 'Opens the photos to try again',
    });
  });

  test('one id for every photo failure, so a retry replaces it; never a link failure\'s', () => {
    expect(photoImportFailedNotification({ ok: false, error: 'offline' }).id).toBe(
      photoImportFailedNotification({ ok: false, error: 'not_a_recipe' }).id,
    );
    expect(photoImportFailedNotification({ ok: false, error: 'offline' }).id).not.toBe(
      importFailedNotification({ ok: false, error: 'offline' }, 'https://example.com/dal').id,
    );
  });
});
