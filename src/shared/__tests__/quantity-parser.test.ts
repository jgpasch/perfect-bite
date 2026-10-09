import { describe, expect, it } from '@jest/globals';

import { parseAmount, parseQuantity } from '../quantity-parser';

describe('parseQuantity', () => {
  it.each([
    // [input, quantity, unit, name]
    ['2 lbs chicken thighs', 2, 'lb', 'chicken thighs'],
    ['milk', null, null, 'milk'],
    ['two avocados', 2, null, 'avocados'],
    ['Twelve eggs', 12, null, 'eggs'],
    ['a dozen eggs', 1, 'dozen', 'eggs'],
    ['an onion', 1, null, 'onion'],
    ['1 1/2 cups flour', 1.5, 'cup', 'flour'],
    ['1/2 cup sugar', 0.5, 'cup', 'sugar'],
    ['½ cup sugar', 0.5, 'cup', 'sugar'],
    ['1½ cups milk', 1.5, 'cup', 'milk'],
    ['1.5 L olive oil', 1.5, 'l', 'olive oil'],
    ['500g ground beef', 500, 'g', 'ground beef'],
    ['2lb. carrots', 2, 'lb', 'carrots'],
    ['2 cans of black beans', 2, 'can', 'black beans'],
    ['3 tbsp. butter', 3, 'tbsp', 'butter'],
    ['8 fl oz cream', 8, 'fl oz', 'cream'],
    ['16 fluid ounces cream', 16, 'fl oz', 'cream'],
    ['half a cup rice', 0.5, 'cup', 'rice'],
    ['half gallon milk', 0.5, 'gal', 'milk'],
    ['3 large eggs', 3, null, 'large eggs'],
    ['4 bunches cilantro', 4, 'bunch', 'cilantro'],
  ])('%s', (input, quantity, unit, name) => {
    expect(parseQuantity(input)).toEqual({ quantity, unit, name });
  });

  it('keeps names that only look like amounts', () => {
    expect(parseQuantity('half and half')).toEqual({ quantity: null, unit: null, name: 'half and half' });
    expect(parseQuantity('2% milk')).toEqual({ quantity: null, unit: null, name: '2% milk' });
    expect(parseQuantity('7up')).toEqual({ quantity: null, unit: null, name: '7up' });
  });

  it('keeps the whole text when nothing would be left to name', () => {
    expect(parseQuantity('2')).toEqual({ quantity: null, unit: null, name: '2' });
    expect(parseQuantity('2 lbs')).toEqual({ quantity: 2, unit: null, name: 'lbs' });
    expect(parseQuantity('a')).toEqual({ quantity: null, unit: null, name: 'a' });
  });

  it('treats a unit word as the name when it is the only word after the amount', () => {
    expect(parseQuantity('2 cans')).toEqual({ quantity: 2, unit: null, name: 'cans' });
  });

  it('collapses whitespace', () => {
    expect(parseQuantity('  2   cups   milk ')).toEqual({ quantity: 2, unit: 'cup', name: 'milk' });
    expect(parseQuantity('   ')).toEqual({ quantity: null, unit: null, name: '' });
  });
});

describe('parseAmount', () => {
  it('parses an amount on its own', () => {
    expect(parseAmount('2 lb')).toEqual({ quantity: 2, unit: 'lb' });
    expect(parseAmount('1½ cups')).toEqual({ quantity: 1.5, unit: 'cup' });
    expect(parseAmount(' 3 ')).toEqual({ quantity: 3, unit: null });
    expect(parseAmount('')).toEqual({ quantity: null, unit: null });
  });

  it('rejects text that is not an amount', () => {
    expect(parseAmount('lb')).toBeNull();
    expect(parseAmount('some')).toBeNull();
    expect(parseAmount('2 lb chicken')).toBeNull();
  });
});
