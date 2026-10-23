/**
 * Sizing for the sign-in screen (board 09), which is exactly the device's height: the title at the
 * top, the field and buttons at the bottom, and the decorative bruschetta filling the space between.
 */

/**
 * The size of the sign-in bruschetta that fits `space` points: the full `max` when there's room,
 * smaller when there isn't, and 0 (no bruschetta) once it'd be smaller than `min`, so a short screen,
 * the keyboard or a large text size squeezes the bruschetta away before the screen has to scroll.
 */
export function signInHeroSize(space: number, { max, min }: { max: number; min: number }): number {
  if (!Number.isFinite(space) || space <= 0) return 0;
  const fits = Math.floor(space);
  if (fits < min) return 0;
  return Math.min(fits, max);
}

/**
 * Whether the sign-in content is taller than the screen, so it should scroll. Layout heights are
 * fractional; anything within a point of the frame counts as fitting.
 */
export function signInOverflows(contentHeight: number, frameHeight: number): boolean {
  if (frameHeight <= 0) return false;
  return contentHeight - frameHeight > 1;
}
