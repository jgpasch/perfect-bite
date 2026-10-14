import { i18n } from '@/i18n';
import { displayItemName } from '@/shared';

import type { ItemView } from './items';

/** "Share as text" (spec 4.1): the list name, then one unchecked item per line. */
export function listShareText(listName: string, unchecked: readonly Pick<ItemView, 'displayName' | 'amountText' | 'note'>[]): string {
  const lines = unchecked.map((item) => {
    const amount = item.amountText ? `${item.amountText} ` : '';
    const name = `${amount}${displayItemName(item.displayName)}`;
    return i18n.t('lists.share.line', { item: item.note ? i18n.t('lists.share.withNote', { item: name, note: item.note }) : name });
  });
  return [listName, ...lines].join('\n');
}
