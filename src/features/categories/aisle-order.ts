// The drag-to-reorder maths for the Aisle order screen (spec 4.3.3, board 12). Worklets, so the
// gesture can run them on the UI thread; plain functions everywhere else (and in Jest).

import { i18n } from '@/i18n';

/** Where a row dragged from `from` by `offset` points would land, given each row's slot height. */
export function dropIndex(from: number, offset: number, slot: number, count: number): number {
  'worklet';
  if (count <= 0) return 0;
  const raw = slot > 0 ? Math.round(from + offset / slot) : from;
  return Math.min(count - 1, Math.max(0, raw));
}

/** `ids` with the one at `from` moved to `to` (its index afterwards). Out-of-range `from` changes nothing. */
export function moveId(ids: readonly string[], from: number, to: number): string[] {
  'worklet';
  const next = ids.slice();
  if (from < 0 || from >= ids.length) return next;
  const [moved] = next.splice(from, 1);
  next.splice(Math.min(next.length, Math.max(0, to)), 0, moved);
  return next;
}

/**
 * How far a drag near the top or bottom of the visible list scrolls per frame: up to `max` points,
 * ramping up as the finger goes deeper into the `edge`-point band; 0 elsewhere. Negative scrolls up.
 */
export function autoScrollStep(y: number, viewport: number, edge: number, max: number): number {
  'worklet';
  if (viewport <= 0 || edge <= 0) return 0;
  if (y < edge) return -max * Math.min(1, (edge - y) / edge);
  if (y > viewport - edge) return max * Math.min(1, (y - (viewport - edge)) / edge);
  return 0;
}

/** The VoiceOver actions on an aisle row: Move up / Move down, left out at the ends. */
export function aisleRowActions(index: number, count: number): { name: 'moveUp' | 'moveDown'; label: string }[] {
  const actions: { name: 'moveUp' | 'moveDown'; label: string }[] = [];
  if (index > 0) actions.push({ name: 'moveUp', label: i18n.t('aisleOrder.moveUp') });
  if (index < count - 1) actions.push({ name: 'moveDown', label: i18n.t('aisleOrder.moveDown') });
  return actions;
}

/** What VoiceOver reads for an aisle row: "Produce, 1 of 20". */
export function aisleRowLabel(name: string, index: number, count: number): string {
  return i18n.t('aisleOrder.row', { name, position: index + 1, count });
}

/** What VoiceOver announces after a Move up / Move down: "Moved to 3 of 20". */
export function aisleMovedAnnouncement(to: number, count: number): string {
  return i18n.t('aisleOrder.moved', { position: to + 1, count });
}
