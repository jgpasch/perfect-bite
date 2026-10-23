// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    // admin/ is its own Next.js project with its own ESLint config (`yarn --cwd admin lint`).
    ignores: ['dist/*', 'admin/**'],
  },
  {
    // Tests swap modules with `jest.mock('@/db/client', () => require('@/test/db'))`.
    files: ['**/__tests__/**', 'src/test/**'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  // The shared domain rules run in the app and in Deno (share-server-import plan §1): pure, and
  // only other `src/shared` modules, by relative path (no Drizzle, Expo, React Native, i18n or `@/`).
  {
    files: ['src/shared/domain/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^[^.]', message: 'src/shared/domain/ imports only other src/shared modules, by relative path.' },
            { regex: '^\\.\\./\\.\\./', message: 'src/shared/domain/ imports nothing outside src/shared/.' },
          ],
        },
      ],
    },
  },
  {
    // Its tests also run under Deno, where `@jest/globals` is `supabase/functions/_shared/jest-globals.ts`.
    files: ['src/shared/domain/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!\\.|@jest/globals$)',
              message: 'src/shared/domain/ tests import only @jest/globals and src/shared modules, by relative path.',
            },
            { regex: '^\\.\\./\\.\\./\\.\\./', message: 'src/shared/domain/ tests import nothing outside src/shared/.' },
          ],
        },
      ],
    },
  },
]);
