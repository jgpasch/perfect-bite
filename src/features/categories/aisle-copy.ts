// Copy for shared aisles (spec 4.3.2): an aisle choice belongs to the household.

import { i18n } from '@/i18n';

/** The item sheet's footnote under the aisle pills when the chosen aisle isn't the catalog default. */
export function sharedAisleFootnote(householdName: string | null): string {
  const name = householdName?.trim();
  return name ? i18n.t('item.sharedAisle', { name }) : i18n.t('item.sharedAisleYours');
}
