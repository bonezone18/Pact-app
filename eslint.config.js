// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'landing/*'],
  },
  {
    // jest.mock factories are hoisted above imports, so they have to require().
    files: ['**/__tests__/**', 'jest.setup.ts'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
]);
