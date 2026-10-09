import { expect, test } from '@jest/globals';

import { newId } from '../id';

test('ids are UUIDv7 and sort in creation order within a millisecond', () => {
  const ids = Array.from({ length: 1000 }, newId);
  expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect([...ids].sort()).toEqual(ids);
  expect(new Set(ids).size).toBe(ids.length);
});
