import { describe, expect, it } from '@jest/globals';

import { displayItemName } from '../display-name';

describe('displayItemName (spec 4.2)', () => {
  it('uppercases a lowercase first letter and leaves the rest as stored', () => {
    expect(displayItemName('chicken thighs')).toBe('Chicken thighs');
    expect(displayItemName('milk')).toBe('Milk');
    expect(displayItemName('m')).toBe('M');
    expect(displayItemName('extra virgin olive OIL')).toBe('Extra virgin olive OIL');
    expect(displayItemName('salt & pepper')).toBe('Salt & pepper');
  });

  it('leaves a name that already starts with a capital alone', () => {
    expect(displayItemName('Chicken thighs')).toBe('Chicken thighs');
    expect(displayItemName('BBQ sauce')).toBe('BBQ sauce');
  });

  it('leaves a first word with a capital in it alone', () => {
    expect(displayItemName('iPhone charger')).toBe('iPhone charger');
    expect(displayItemName('eBay gift card')).toBe('eBay gift card');
    // Only the first word counts: later capitals don't stop it.
    expect(displayItemName('coffee from Trader Joe’s')).toBe('Coffee from Trader Joe’s');
  });

  it('leaves a leading digit or symbol alone', () => {
    expect(displayItemName('2% milk')).toBe('2% milk');
    expect(displayItemName('7up')).toBe('7up');
    expect(displayItemName('"fancy" cheese')).toBe('"fancy" cheese');
    expect(displayItemName(' milk')).toBe(' milk');
  });

  it('leaves a leading emoji alone, including astral ones', () => {
    expect(displayItemName('🥑 avocados')).toBe('🥑 avocados');
    expect(displayItemName('🍋')).toBe('🍋');
  });

  it('uppercases accented and non-Latin letters', () => {
    expect(displayItemName('édamame')).toBe('Édamame');
    expect(displayItemName('jalapeños')).toBe('Jalapeños');
    expect(displayItemName('ñoquis')).toBe('Ñoquis');
    expect(displayItemName('ørret')).toBe('Ørret');
    expect(displayItemName('шпинат')).toBe('Шпинат');
  });

  it('skips a letter whose capital is more than one letter', () => {
    expect(displayItemName('ßalz')).toBe('ßalz');
  });

  it('leaves letters with no case alone', () => {
    expect(displayItemName('豆腐')).toBe('豆腐');
  });

  it('is safe on an empty or blank string', () => {
    expect(displayItemName('')).toBe('');
    expect(displayItemName('   ')).toBe('   ');
  });

  it('never changes the length of the name', () => {
    for (const name of ['chicken thighs', 'édamame', 'iPhone charger', '🥑 avocados', '']) {
      expect(displayItemName(name)).toHaveLength(name.length);
    }
  });
});
