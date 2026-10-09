import { describe, expect, it } from '@jest/globals';

import { groupByRecipe } from '../recipe-grouping';

const c = (recipe: string | null, quantity: number | null, at: number, source = recipe ? 'recipe' : 'manual') => ({
  source,
  recipeId: recipe,
  recipeName: recipe ? recipe[0].toUpperCase() + recipe.slice(1) : null,
  quantity,
  unit: null,
  createdAt: new Date(at),
});
const item = (name: string, ...contributions: ReturnType<typeof c>[]) => ({ name, contributions });

describe('groupByRecipe', () => {
  it('makes one section per recipe, most recent first, then Other items', () => {
    const sections = groupByRecipe([
      item('beef', c('tacos', 1, 10)),
      item('milk', c(null, 1, 5)),
      item('noodles', c('soup', 1, 20)),
      item('salt'),
    ]);
    expect(sections.map((s) => [s.recipeId, s.name, s.entries.map((e) => e.item.name)])).toEqual([
      ['soup', 'Soup', ['noodles']],
      ['tacos', 'Tacos', ['beef']],
      [null, 'Other items', ['milk', 'salt']],
    ]);
  });

  it('shows an item under each of its recipes with that recipe’s amount and an "also in" hint', () => {
    const [soup, tacos] = groupByRecipe([item('onion', c('tacos', 1, 1), c('soup', 2, 2), c(null, 5, 3))]);
    expect(soup.entries[0]).toMatchObject({ amountText: '2', alsoIn: ['Tacos'] });
    expect(tacos.entries[0]).toMatchObject({ amountText: '1', alsoIn: ['Soup'] });
  });

  it('puts an item with a manual amount and a recipe amount only under the recipe', () => {
    const sections = groupByRecipe([item('lime', c(null, 2, 1), c('tacos', 1, 2))]);
    expect(sections.map((s) => s.name)).toEqual(['Tacos']);
  });

  it('counts manual adds with no amount as one each under Other items', () => {
    const [other] = groupByRecipe([item('milk', c(null, null, 1), c(null, null, 2)), item('eggs', c(null, null, 3))]);
    expect(other.entries.map((e) => [e.item.name, e.amountText])).toEqual([
      ['milk', '2'],
      ['eggs', ''],
    ]);
  });

  it('does not count a recipe link with no quantity', () => {
    const [tacos] = groupByRecipe([item('beef', c('tacos', 2, 1), c('tacos', null, 2))]);
    expect(tacos.entries[0].amountText).toBe('2');
    // The same recipe added twice for an ingredient with no amount.
    const [soup] = groupByRecipe([item('salt', c('soup', null, 1), c('soup', null, 2))]);
    expect(soup.entries[0].amountText).toBe('');
    // A deleted recipe's link reads as no recipe, and still adds no amount.
    const [other] = groupByRecipe([item('milk', c(null, null, 1), c(null, null, 2, 'recipe'))]);
    expect(other.entries[0].amountText).toBe('');
  });

  it('counts an add with no amount as one of the item’s usual unit', () => {
    const gal = (recipe: string | null, quantity: number | null, at: number) => ({ ...c(recipe, quantity, at), unit: 'gal' as const });
    const milk = { name: 'milk', usualUnit: 'gal' as const, contributions: [gal(null, 1, 1), c(null, null, 2)] };
    expect(groupByRecipe([milk])[0].entries[0].amountText).toBe('2 gal');
    // A recipe link with no quantity still isn't an amount, usual unit or not.
    const soup = { name: 'milk', usualUnit: 'gal' as const, contributions: [gal('soup', 1, 1), c('soup', null, 2)] };
    expect(groupByRecipe([soup])[0].entries[0].amountText).toBe('1 gal');
    // A lone add with no amount still reads empty, and a null usual unit is a plain count.
    expect(groupByRecipe([{ name: 'milk', usualUnit: 'gal' as const, contributions: [c(null, null, 1)] }])[0].entries[0].amountText).toBe('');
    expect(groupByRecipe([{ name: 'milk', usualUnit: null, contributions: [gal(null, 1, 1), c(null, null, 2)] }])[0].entries[0].amountText).toBe('1 gal + 1');
  });

  it('is empty for no items', () => {
    expect(groupByRecipe([])).toEqual([]);
  });
});
