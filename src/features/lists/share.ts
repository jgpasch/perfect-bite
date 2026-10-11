import { displayItemName } from '@/shared';

import type { ItemView } from './items';

/** "Share as text" (spec 4.1): the list name, then one unchecked item per line. */
export function listShareText(listName: string, unchecked: readonly Pick<ItemView, 'displayName' | 'amountText' | 'note'>[]): string {
  const lines = unchecked.map((item) => {
    const amount = item.amountText ? `${item.amountText} ` : '';
    const note = item.note ? ` (${item.note})` : '';
    return `- ${amount}${displayItemName(item.displayName)}${note}`;
  });
  return [listName, ...lines].join('\n');
}
