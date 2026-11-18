import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'dist-check/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:child_process', 'child_process'],
              message:
                'Only src/drivers/runtime/herdr/hc.ts (every hc call) and src/util/process.ts (everything else) may start processes.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/drivers/runtime/herdr/hc.ts', 'src/util/process.ts', 'test/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      // bun:test's types say `expect(promise).rejects.toThrow()` returns nothing, though it
      // returns a promise that must be awaited, and give `expect.any()` and the other
      // asymmetric matchers the type `any`.
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
  {
    // The web app runs in a browser.
    files: ['web/**/*.ts', 'web/**/*.tsx'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
);
