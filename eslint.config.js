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
]);
