import { expect, test } from '@jest/globals';

import * as shared from '@/shared/domain/duplicate-detector';

import * as app from '../duplicate-detector';

// The rules and their tests are in src/shared/domain/; this path stays for the app's imports.
test('re-exports the shared duplicate detector', () => {
  expect(app.detectDuplicate).toBe(shared.detectDuplicate);
  expect(app.planBulkAdd).toBe(shared.planBulkAdd);
});
