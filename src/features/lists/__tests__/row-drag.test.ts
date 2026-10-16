// The drag-to-reorder maths for As added (spec 4.6): rows of different heights in one card.
import { describe, expect, test } from '@jest/globals';

import { clampDrag, dragTo, dropSlot, makeRoomShift, settleOffset, withBox, type RowBox } from '../row-drag';

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

describe('dragTo', () => {
  // Ten rows, a note making the fourth taller. Middles: 25, 75, 125, 190, 255, 305, 355, 405, 455, 505.
  const rows = stack(50, 50, 50, 80, 50, 50, 50, 50, 50, 50);

  test('down past several rows, one at a time as its bottom passes each middle', () => {
    expect(dragTo(rows, 1, 24, 0)).toEqual({ offset: 24, to: 1 });
    expect(dragTo(rows, 1, 26, 0)).toEqual({ offset: 26, to: 2 });
    // Past the tall row's middle (190): bottom 100 + 91.
    expect(dragTo(rows, 1, 91, 0)).toEqual({ offset: 91, to: 3 });
    expect(dragTo(rows, 1, 206, 0)).toEqual({ offset: 206, to: 5 });
  });

  test('up past several rows, as its top passes each middle', () => {
    // Row 7 (top 380) over row 4's middle (255) but not the tall row's (190).
    expect(dragTo(rows, 7, -130, 0)).toEqual({ offset: -130, to: 4 });
    expect(dragTo(rows, 7, -200, 0)).toEqual({ offset: -200, to: 3 });
    expect(dragTo(rows, 7, -310, 0)).toEqual({ offset: -310, to: 1 });
  });

  test('the list scrolling under a still finger carries the row on', () => {
    // Auto-scrolled 120 down with the finger 30 down: the row is 150 down, past three rows.
    expect(dragTo(rows, 0, 30, 120)).toEqual({ offset: 150, to: 3 });
    // Scrolled back up past where the drag began.
    expect(dragTo(rows, 6, -10, -200)).toEqual({ offset: -210, to: 2 });
    // Finger up as far as the list scrolled down: back over its own place.
    expect(dragTo(rows, 4, -90, 90)).toEqual({ offset: 0, to: 4 });
  });

  test('never out of its card, so it takes an end place', () => {
    expect(dragTo(rows, 2, 0, 5000)).toEqual({ offset: 380, to: 9 });
    expect(dragTo(rows, 2, -40, -5000)).toEqual({ offset: -100, to: 0 });
  });

  test('no boxes measured: nowhere to go', () => {
    expect(dragTo([], 0, 100, 50)).toEqual({ offset: 0, to: 0 });
  });
});

describe('withBox', () => {
  test('adds or replaces one row\'s box and keeps the rest', () => {
    const before = { a: { y: 0, h: 50 }, b: { y: 50, h: 80 } };
    expect(withBox(before, 'c', { y: 130, h: 50 })).toEqual({ a: { y: 0, h: 50 }, b: { y: 50, h: 80 }, c: { y: 130, h: 50 } });
    expect(withBox(before, 'a', { y: 80, h: 50 })).toEqual({ a: { y: 80, h: 50 }, b: { y: 50, h: 80 } });
  });

  test('a new object, the old one untouched', () => {
    const before = { a: { y: 0, h: 50 } };
    const after = withBox(before, 'b', { y: 50, h: 50 });
    expect(after).not.toBe(before);
    expect(before).toEqual({ a: { y: 0, h: 50 } });
  });
});
