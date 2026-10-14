// Scratch file from the "Shared aisle across a family" session, which couldn't delete it. Safe to
// delete; categories.test.ts covers searchCatalog's language order.
import { expect, jest, test } from '@jest/globals';

import { resetDb } from '@/test/db';
import { seedCatalog } from '@/test/seed';

import { searchCatalog } from '../categories';

jest.mock('@/db/client', () => require('@/test/db'));

test('searchCatalog returns nothing for a blank query or a zero limit, in either language', () => {
  resetDb();
  seedCatalog();
  expect(searchCatalog('   ', 5, 'es')).toEqual([]);
  expect(searchCatalog('lech', 0, 'es')).toEqual([]);
  expect(searchCatalog('aguac', 5, 'en')).toEqual([{ key: 'aguacate', displayName: 'aguacates' }]);
});
