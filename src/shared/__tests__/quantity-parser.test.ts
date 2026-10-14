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

  describe('Spanish (spec 4.15)', () => {
    it.each([
      // [input, quantity, unit, name]
      ['2 tazas de harina', 2, 'cup', 'harina'],
      ['1 kilo de jitomate', 1, 'kg', 'jitomate'],
      ['medio kilo de queso oaxaca', 0.5, 'kg', 'queso oaxaca'],
      ['media docena de huevos', 0.5, 'dozen', 'huevos'],
      ['3 piezas de aguacate', 3, null, 'aguacate'],
      ['1 manojo de cilantro', 1, 'bunch', 'cilantro'],
      ['2 dientes de ajo', 2, 'clove', 'ajo'],
      ['una lata de chiles chipotles', 1, 'can', 'chiles chipotles'],
      ['un frasco de mayonesa', 1, 'jar', 'mayonesa'],
      ['uno bolsa de tortillas', 1, 'bag', 'tortillas'],
      ['dos aguacates', 2, null, 'aguacates'],
      ['Tres limones', 3, null, 'limones'],
      ['dieciséis tortillas', 16, null, 'tortillas'],
      ['dieciseis tortillas', 16, null, 'tortillas'],
      ['veinte bolillos', 20, null, 'bolillos'],
      ['once huevos', 11, null, 'huevos'],
      ['media taza de azúcar', 0.5, 'cup', 'azúcar'],
      ['1 1/2 tazas de arroz', 1.5, 'cup', 'arroz'],
      ['½ kilo de carne molida', 0.5, 'kg', 'carne molida'],
      ['2 cucharadas de aceite', 2, 'tbsp', 'aceite'],
      ['2 cda. de aceite', 2, 'tbsp', 'aceite'],
      ['1 cucharadita de sal', 1, 'tsp', 'sal'],
      ['3 cdtas vainilla', 3, 'tsp', 'vainilla'],
      ['500 gramos de queso', 500, 'g', 'queso'],
      ['250 gr de jamón', 250, 'g', 'jamón'],
      ['500gr queso', 500, 'g', 'queso'],
      ['2 kilogramos de papa', 2, 'kg', 'papa'],
      ['1 litro de leche', 1, 'l', 'leche'],
      ['200 mililitros de crema', 200, 'ml', 'crema'],
      ['2 libras de pollo', 2, 'lb', 'pollo'],
      ['8 onzas de queso crema', 8, 'oz', 'queso crema'],
      ['1 galón de leche', 1, 'gal', 'leche'],
      ['2 galones de agua', 2, 'gal', 'agua'],
      ['1 GALON de leche', 1, 'gal', 'leche'],
      ['2 cajas de cereal', 2, 'box', 'cereal'],
      ['una pizca de sal', 1, 'pinch', 'sal'],
      ['2 docenas de huevos', 2, 'dozen', 'huevos'],
      ['4 pzas de pan dulce', 4, null, 'pan dulce'],
      ['1 pza bolillo', 1, null, 'bolillo'],
      ['2 Piezas de mango', 2, null, 'mango'],
      // `de` only goes after a unit or count word, and only the first one.
      ['2 de leche', 2, null, 'de leche'],
      ['1 lata de de todo', 1, 'can', 'de todo'],
      // English amounts and Spanish names mix either way.
      ['2 cups de harina', 2, 'cup', 'harina'],
      ['dos cans of beans', 2, 'can', 'beans'],
    ])('%s', (input, quantity, unit, name) => {
      expect(parseQuantity(input)).toEqual({ quantity, unit, name });
    });

    it('keeps names that merely start with a number word', () => {
      for (const name of ['media crema', 'medio pollo', 'Media Crema Nestlé', 'medio', 'una']) {
        expect(parseQuantity(name)).toEqual({ quantity: null, unit: null, name });
      }
    });

    it('treats a unit or count word as the name when nothing follows it', () => {
      expect(parseQuantity('2 tazas')).toEqual({ quantity: 2, unit: null, name: 'tazas' });
      expect(parseQuantity('3 piezas')).toEqual({ quantity: 3, unit: null, name: 'piezas' });
      expect(parseQuantity('2 tazas de')).toEqual({ quantity: 2, unit: 'cup', name: 'de' });
      expect(parseQuantity('3 piezas de')).toEqual({ quantity: 3, unit: null, name: 'de' });
    });

    it('leaves unknown Spanish words in the name', () => {
      expect(parseQuantity('2 paquetes de galletas')).toEqual({
        quantity: 2,
        unit: null,
        name: 'paquetes de galletas',
      });
      expect(parseQuantity('pan de muerto')).toEqual({ quantity: null, unit: null, name: 'pan de muerto' });
    });
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

  it('parses a Spanish amount on its own', () => {
    expect(parseAmount('2 tazas')).toEqual({ quantity: 2, unit: 'cup' });
    expect(parseAmount('medio kilo')).toEqual({ quantity: 0.5, unit: 'kg' });
    expect(parseAmount('3 piezas')).toEqual({ quantity: 3, unit: null });
    expect(parseAmount('una docena')).toEqual({ quantity: 1, unit: 'dozen' });
    expect(parseAmount('media')).toBeNull();
    expect(parseAmount('2 tazas de harina')).toBeNull();
  });

  it('rejects text that is not an amount', () => {
    expect(parseAmount('lb')).toBeNull();
    expect(parseAmount('some')).toBeNull();
    expect(parseAmount('2 lb chicken')).toBeNull();
  });
});
