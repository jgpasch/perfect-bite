import { expect, test } from '@jest/globals';

import * as shared from '@/shared/domain/usual-unit';

import * as app from '../usual-unit';

// The rules and their tests are in src/shared/domain/; this path stays for the app's imports.
test('re-exports the shared usual unit', () => {
  expect(app.COUNT_KEY).toBe('count');
  expect(app.unitKey).toBe(shared.unitKey);
  expect(app.unitFromKey).toBe(shared.unitFromKey);
  expect(app.usualUnit).toBe(shared.usualUnit);
  expect(app.usualUnitsByKey).toBe(shared.usualUnitsByKey);
  expect(app.withDefaultUnit).toBe(shared.withDefaultUnit);
});
