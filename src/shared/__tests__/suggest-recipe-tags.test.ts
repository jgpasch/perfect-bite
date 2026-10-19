import { describe, expect, it } from '@jest/globals';

import * as shared from '@/shared';
import {
  MAX_SUGGEST_TAGS_NOTES_LENGTH,
  SUGGEST_RECIPE_TAGS_ERROR_CODES,
  SuggestRecipeTagsErrorSchema,
  SuggestRecipeTagsRequestSchema,
  SuggestRecipeTagsResponseSchema,
} from '@/shared/schemas/suggest-recipe-tags';

const item = (name: string, extra: object = {}) => ({ name, quantity: 1, unit: null, note: '', ...extra });

describe('SuggestRecipeTagsRequestSchema', () => {
  it('trims every text field and keeps amounts and units', () => {
    expect(
      SuggestRecipeTagsRequestSchema.parse({
        name: ' Fish tacos ',
        notes: ' Friday night ',
        ingredients: [{ name: ' cod ', quantity: 1.5, unit: 'lb', note: ' skinless ' }],
      }),
    ).toEqual({
      name: 'Fish tacos',
      notes: 'Friday night',
      ingredients: [{ name: 'cod', quantity: 1.5, unit: 'lb', note: 'skinless' }],
    });
  });

  it('cuts long text instead of refusing it', () => {
    const parsed = SuggestRecipeTagsRequestSchema.parse({
      name: 'a'.repeat(200),
      notes: 'b'.repeat(5000),
      ingredients: [{ name: 'c'.repeat(80), quantity: null, unit: null, note: 'd'.repeat(200) }],
    });
    expect(parsed.name).toBe('a'.repeat(120));
    expect(parsed.notes).toBe('b'.repeat(MAX_SUGGEST_TAGS_NOTES_LENGTH));
    expect(MAX_SUGGEST_TAGS_NOTES_LENGTH).toBe(4000);
    expect(parsed.ingredients[0]).toEqual({ name: 'c'.repeat(64), quantity: null, unit: null, note: 'd'.repeat(120) });
  });

  it('never splits an emoji when cutting', () => {
    const parsed = SuggestRecipeTagsRequestSchema.parse({ name: `${'a'.repeat(119)}🍰`, notes: null, ingredients: [] });
    expect(parsed.name).toBe('a'.repeat(119));
  });

  it('keeps the first 80 ingredients with a name', () => {
    const ingredients = [item(''), item('   '), ...Array.from({ length: 90 }, (_, i) => item(`item ${i}`))];
    const parsed = SuggestRecipeTagsRequestSchema.parse({ name: 'Big', notes: null, ingredients });
    expect(parsed.ingredients).toHaveLength(80);
    expect(parsed.ingredients[0].name).toBe('item 0');
    expect(parsed.ingredients[79].name).toBe('item 79');
  });

  it('treats a null, missing or blank note or notes as none', () => {
    const parsed = SuggestRecipeTagsRequestSchema.parse({
      name: 'Toast',
      notes: '  ',
      ingredients: [{ name: 'bread', quantity: 2, unit: null, note: null }, { name: 'butter', quantity: null, unit: null }],
    });
    expect(parsed.notes).toBeNull();
    expect(parsed.ingredients.map((i) => i.note)).toEqual(['', '']);
    expect(SuggestRecipeTagsRequestSchema.parse({ name: 'Toast', ingredients: [] }).notes).toBeNull();
  });

  it('requires a name that isn’t blank', () => {
    expect(SuggestRecipeTagsRequestSchema.safeParse({ name: '', notes: null, ingredients: [] }).success).toBe(false);
    expect(SuggestRecipeTagsRequestSchema.safeParse({ name: '   ', notes: null, ingredients: [] }).success).toBe(false);
    expect(SuggestRecipeTagsRequestSchema.safeParse({ notes: null, ingredients: [] }).success).toBe(false);
  });

  it('refuses ingredients that aren’t a list, a quantity that isn’t a number and an unsupported unit', () => {
    expect(SuggestRecipeTagsRequestSchema.safeParse({ name: 'Toast', notes: null }).success).toBe(false);
    expect(SuggestRecipeTagsRequestSchema.safeParse({ name: 'Toast', notes: null, ingredients: [item('bread', { quantity: '2' })] }).success).toBe(false);
    expect(SuggestRecipeTagsRequestSchema.safeParse({ name: 'Toast', notes: null, ingredients: [item('bread', { unit: 'slice' })] }).success).toBe(false);
    expect(SuggestRecipeTagsRequestSchema.safeParse({ name: 'Toast', notes: null, ingredients: [item('bread', { quantity: Infinity })] }).success).toBe(false);
  });
});

describe('SuggestRecipeTagsResponseSchema', () => {
  it('reads a response, filling a facet an older server left out', () => {
    expect(
      SuggestRecipeTagsResponseSchema.parse({
        tags: { meal: ['dinner'], cuisine: [], protein: ['chicken'], diet: [] },
        promptVersion: 'suggest-recipe-tags.v1',
      }),
    ).toEqual({
      tags: { meal: ['dinner'], cuisine: [], protein: ['chicken'], diet: [], method: [] },
      promptVersion: 'suggest-recipe-tags.v1',
    });
  });

  it('refuses a response without tags', () => {
    expect(SuggestRecipeTagsResponseSchema.safeParse({ promptVersion: 'v1' }).success).toBe(false);
  });
});

describe('errors', () => {
  it('lists the codes the function answers with', () => {
    expect(SUGGEST_RECIPE_TAGS_ERROR_CODES).toEqual(['invalid_request', 'not_entitled', 'rate_limited', 'limit_reached', 'unavailable']);
    expect(SuggestRecipeTagsErrorSchema.parse({ error: 'rate_limited', message: 'Slow down' })).toEqual({ error: 'rate_limited', message: 'Slow down' });
    expect(SuggestRecipeTagsErrorSchema.safeParse({ error: 'fetch_failed', message: 'x' }).success).toBe(false);
  });

  it('is exported from the shared index', () => {
    expect(shared.SuggestRecipeTagsRequestSchema).toBe(SuggestRecipeTagsRequestSchema);
  });
});
