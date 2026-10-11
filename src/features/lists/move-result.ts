// "Move to another list…" on the item sheet hands its result to the list the item went to: the
// sheet stores it as it closes and opens that list, which takes it when it gains focus to show the
// toast with Undo (spec 4.4).

import type { MoveItemResult } from '@/features/lists/items';

let pending: MoveItemResult | null = null;

export function setMoveResult(result: MoveItemResult): void {
  pending = result;
}

/** The move to this list, once: taking it clears it. A move to another list stays. */
export function takeMoveResult(listId: string): MoveItemResult | null {
  if (pending?.toListId !== listId) return null;
  const result = pending;
  pending = null;
  return result;
}
