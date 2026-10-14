// The drag-to-reorder maths for As added (spec 4.6): rows of different heights in one card.
import { describe, expect, test } from '@jest/globals';

import { clampDrag, dropSlot, makeRoomShift, settleOffset, type RowBox } from '../row-drag';

/** Rows stacked from the top with these heights. */
function stack(...heights: number[]): RowBox[] {
  let y = 0;
  return heights.map((h) => {
    const box = { y, h };
    y += h;
    return box;
  });
}

describe('dropSlot', () => {
  const rows = stack(50, 80, 50);

  test('not moved, or not far enough, stays put', () => {
    expect(dropSlot(rows, 0, 0)).toBe(0);
    expect(dropSlot(rows, 1, 0)).toBe(1);
    // Row 0's bottom (50) has to pass row 1's middle (90).
    expect(dropSlot(rows, 0, 40)).toBe(0);
    expect(dropSlot(rows, 0, 41)).toBe(1);
  });

  test('down past one or more rows', () => {
    // Past row 2's middle (155).
    expect(dropSlot(rows, 0, 106)).toBe(2);
    expect(dropSlot(rows, 1, 26)).toBe(2);
  });

  test('up: the top edge has to pass the row above\'s middle', () => {
    // Row 2's top (130) above row 1's middle (90).
    expect(dropSlot(rows, 2, -40)).toBe(2);
    expect(dropSlot(rows, 2, -41)).toBe(1);
    expect(dropSlot(rows, 2, -106)).toBe(0);
  });

  test('a tall row still reaches either end once clamped there', () => {
    const tall = stack(100, 30, 30);
    expect(dropSlot(tall, 0, clampDrag(tall, 0, 1000))).toBe(2);
    const tallLast = stack(30, 30, 100);
    expect(dropSlot(tallLast, 2, clampDrag(tallLast, 2, -1000))).toBe(0);
  });

  test('one row, or a missing one, goes nowhere', () => {
    expect(dropSlot(stack(50), 0, 100)).toBe(0);
    expect(dropSlot(rows, 5, 100)).toBe(5);
  });
});

describe('makeRoomShift', () => {
  test('moving down, the rows it passed move up by its height', () => {
    expect([0, 1, 2, 3].map((i) => makeRoomShift(i, 0, 2, 50))).toEqual([0, -50, -50, 0]);
  });

  test('moving up, the rows it passed move down by its height', () => {
    expect([0, 1, 2, 3].map((i) => makeRoomShift(i, 3, 1, 40))).toEqual([0, 40, 40, 0]);
  });

  test('over its own place, nothing moves', () => {
    expect([0, 1, 2].map((i) => makeRoomShift(i, 1, 1, 40))).toEqual([0, 0, 0]);
  });
});

describe('settleOffset', () => {
  const rows = stack(50, 80, 50);

  test('down: its bottom lands on the last passed row\'s bottom', () => {
    expect(settleOffset(rows, 0, 1)).toBe(80);
    expect(settleOffset(rows, 0, 2)).toBe(130);
  });

  test('up: its top lands on the last passed row\'s top', () => {
    expect(settleOffset(rows, 2, 1)).toBe(-80);
    expect(settleOffset(rows, 2, 0)).toBe(-130);
  });

  test('its own place, or a missing row, is no move', () => {
    expect(settleOffset(rows, 1, 1)).toBe(0);
    expect(settleOffset(rows, 0, 7)).toBe(0);
  });
});

describe('clampDrag', () => {
  const rows = stack(50, 80, 50);

  test('keeps the row inside its card', () => {
    expect(clampDrag(rows, 0, -20)).toBe(0);
    expect(clampDrag(rows, 0, 500)).toBe(130);
    expect(clampDrag(rows, 1, -500)).toBe(-50);
    expect(clampDrag(rows, 1, 500)).toBe(50);
    expect(clampDrag(rows, 1, 12)).toBe(12);
  });

  test('no rows, no offset', () => {
    expect(clampDrag([], 0, 30)).toBe(0);
  });
});
