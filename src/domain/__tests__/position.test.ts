import { expect, test } from '@jest/globals';

import * as shared from '@/shared/domain/position';

import * as app from '../position';

// The rules and their tests are in src/shared/domain/; this path stays for the app's imports.
test('re-exports the shared positions', () => {
  expect(app.positionBetween).toBe(shared.positionBetween);
  expect(app.positionForMove).toBe(shared.positionForMove);
});
