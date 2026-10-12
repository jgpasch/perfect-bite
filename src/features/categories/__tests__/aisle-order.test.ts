import { describe, expect, it } from '@jest/globals';

import { aisleRowActions, aisleRowLabel, autoScrollStep, dropIndex, moveId } from '../aisle-order';

describe('dropIndex', () => {
  const slot = 60;

  it('stays put with no movement', () => {
    expect(dropIndex(3, 0, slot, 10)).toBe(3);
  });

  it('moves one slot once past half a slot, either way', () => {
    expect(dropIndex(3, 29, slot, 10)).toBe(3);
    expect(dropIndex(3, 31, slot, 10)).toBe(4);
    expect(dropIndex(3, -29, slot, 10)).toBe(3);
    expect(dropIndex(3, -31, slot, 10)).toBe(2);
  });

  it('moves several slots for a long drag', () => {
    expect(dropIndex(1, 245, slot, 10)).toBe(5);
    expect(dropIndex(8, -400, slot, 10)).toBe(1);
  });

  it('clamps to the first and last row', () => {
    expect(dropIndex(2, -1000, slot, 10)).toBe(0);
    expect(dropIndex(2, 10_000, slot, 10)).toBe(9);
  });

  it('works from an absolute offset (from = 0), as the list uses it', () => {
    expect(dropIndex(0, 4 * slot + 10, slot, 10)).toBe(4);
  });

  it('returns 0 for an empty list and ignores a zero slot', () => {
    expect(dropIndex(0, 100, slot, 0)).toBe(0);
    expect(dropIndex(2, 100, 0, 5)).toBe(2);
  });
});

describe('moveId', () => {
  const ids = ['produce', 'bakery', 'meat', 'dairy', 'pantry'];

  it('moves an id down, to its index afterwards', () => {
    expect(moveId(ids, 0, 2)).toEqual(['bakery', 'meat', 'produce', 'dairy', 'pantry']);
  });

  it('moves an id up', () => {
    expect(moveId(ids, 4, 1)).toEqual(['produce', 'pantry', 'bakery', 'meat', 'dairy']);
  });

  it('moves to the ends', () => {
    expect(moveId(ids, 2, 0)).toEqual(['meat', 'produce', 'bakery', 'dairy', 'pantry']);
    expect(moveId(ids, 2, 4)).toEqual(['produce', 'bakery', 'dairy', 'pantry', 'meat']);
  });

  it('clamps a destination past the end', () => {
    expect(moveId(ids, 0, 99)).toEqual(['bakery', 'meat', 'dairy', 'pantry', 'produce']);
    expect(moveId(ids, 3, -5)).toEqual(['dairy', 'produce', 'bakery', 'meat', 'pantry']);
  });

  it('returns an equal copy for a no-op move or an out-of-range source, without touching the input', () => {
    const same = moveId(ids, 1, 1);
    expect(same).toEqual(ids);
    expect(same).not.toBe(ids);
    expect(moveId(ids, -1, 2)).toEqual(ids);
    expect(moveId(ids, 5, 0)).toEqual(ids);
    expect(ids).toEqual(['produce', 'bakery', 'meat', 'dairy', 'pantry']);
  });
});

describe('autoScrollStep', () => {
  const viewport = 600;
  const edge = 60;
  const max = 10;

  it("doesn't scroll in the middle of the list", () => {
    expect(autoScrollStep(300, viewport, edge, max)).toBe(0);
    expect(autoScrollStep(edge, viewport, edge, max)).toBe(0);
    expect(autoScrollStep(viewport - edge, viewport, edge, max)).toBe(0);
  });

  it('scrolls up near the top, faster the closer to the edge', () => {
    expect(autoScrollStep(30, viewport, edge, max)).toBe(-5);
    expect(autoScrollStep(0, viewport, edge, max)).toBe(-10);
  });

  it('scrolls down near the bottom, faster the closer to the edge', () => {
    expect(autoScrollStep(570, viewport, edge, max)).toBe(5);
    expect(autoScrollStep(600, viewport, edge, max)).toBe(10);
  });

  it('caps the speed when the finger is past the list', () => {
    expect(autoScrollStep(-200, viewport, edge, max)).toBe(-10);
    expect(autoScrollStep(900, viewport, edge, max)).toBe(10);
  });

  it("doesn't scroll before the list has a size", () => {
    expect(autoScrollStep(0, 0, edge, max)).toBe(0);
    expect(autoScrollStep(0, viewport, 0, max)).toBe(0);
  });
});

describe('aisle row accessibility', () => {
  it('offers Move up and Move down in the middle', () => {
    expect(aisleRowActions(3, 10)).toEqual([
      { name: 'moveUp', label: 'Move up' },
      { name: 'moveDown', label: 'Move down' },
    ]);
  });

  it('leaves out Move up on the first row and Move down on the last', () => {
    expect(aisleRowActions(0, 10)).toEqual([{ name: 'moveDown', label: 'Move down' }]);
    expect(aisleRowActions(9, 10)).toEqual([{ name: 'moveUp', label: 'Move up' }]);
  });

  it('offers nothing for a single row', () => {
    expect(aisleRowActions(0, 1)).toEqual([]);
  });

  it('reads the name and the place in the order', () => {
    expect(aisleRowLabel('Produce', 0, 20)).toBe('Produce, 1 of 20');
    expect(aisleRowLabel('Meat & seafood', 19, 20)).toBe('Meat & seafood, 20 of 20');
  });

  it("reads a custom aisle's household between its name and position", () => {
    expect(aisleRowLabel('Costco', 2, 20, 'Test home')).toBe('Costco, Test home, 3 of 20');
  });

  it('leaves out a missing or empty household', () => {
    expect(aisleRowLabel('Costco', 2, 20, null)).toBe('Costco, 3 of 20');
    expect(aisleRowLabel('Costco', 2, 20, '')).toBe('Costco, 3 of 20');
  });
});
