// `@jest/globals` under Deno, so the tests in `src/shared/domain/__tests__/` run in both
// (`shared-domain.test.ts`). Only what those tests use.
export { afterEach, beforeEach, describe, it, it as test } from '@std/testing/bdd';
export { expect } from '@std/expect';
