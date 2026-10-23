// The shared domain rules' Jest tests (`src/shared/domain/__tests__/`), run under Deno too, so the
// rules the Edge Functions use are checked in their runtime. `@jest/globals` is `jest-globals.ts`.
import '@shared/domain/__tests__/duplicate-detector.test.ts';
import '@shared/domain/__tests__/position.test.ts';
import '@shared/domain/__tests__/quantity-math.test.ts';
import '@shared/domain/__tests__/recipe-import.test.ts';
import '@shared/domain/__tests__/usual-unit.test.ts';
