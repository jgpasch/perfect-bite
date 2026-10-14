// The drag-to-reorder maths for As added (spec 4.6), where rows can differ in height (a note, a hint).
// Worklets, so the gesture can run them on the UI thread; plain functions everywhere else (and in Jest).

/** A row's place in its card before the drag: top and height, in points. */
export type RowBox = { y: number; h: number };

/**
 * Where the row dragged from `from` by `offset` lands: it has passed a row below once its bottom edge is
 * past that row's middle, and a row above once its top edge is. `rows` are laid out as before the
 * drag, top first. At either end of the card it always takes the end place, whatever the heights.
 */
export function dropSlot(rows: readonly RowBox[], from: number, offset: number): number {
  'worklet';
  const a = rows[from];
  if (!a) return from;
  const top = a.y + offset;
  const bottom = top + a.h;
  let to = 0;
  for (let i = 0; i < rows.length; i++) {
    const middle = rows[i].y + rows[i].h / 2;
    if (i < from && top >= middle) to++;
    if (i > from && bottom > middle) to++;
  }
  return to;
}

/** How far the row at `index` moves to make room while the row from `from` (`height` tall) is over `to`. */
export function makeRoomShift(index: number, from: number, to: number, height: number): number {
  'worklet';
  if (from < to && index > from && index <= to) return -height;
  if (to < from && index >= to && index < from) return height;
  return 0;
}

/** How far the row dragged from `from` travels to sit at `to`, where the others made room for it. */
export function settleOffset(rows: readonly RowBox[], from: number, to: number): number {
  'worklet';
  const a = rows[from];
  const b = rows[to];
  if (!a || !b) return 0;
  if (to > from) return b.y + b.h - (a.y + a.h);
  if (to < from) return b.y - a.y;
  return 0;
}

/** The dragged row's offset, kept so it never leaves its card. */
export function clampDrag(rows: readonly RowBox[], from: number, offset: number): number {
  'worklet';
  const a = rows[from];
  const last = rows[rows.length - 1];
  if (!a || !last) return 0;
  // `|| 0`: the top row's limit is -0, which shouldn't leak out.
  return Math.min(last.y + last.h - a.y - a.h, Math.max(-a.y, offset)) || 0;
}
