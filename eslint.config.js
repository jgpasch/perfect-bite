// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    // Tests swap modules with `jest.mock('@/db/client', () => require('@/test/db'))`.
    files: ['**/__tests__/**', 'src/test/**'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
]);
