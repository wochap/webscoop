import { builtinModules } from 'node:module';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'webscoop-recorder-ui/**', 'test-results/**', 'playwright-report/**', 'result/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
    },
  },
  {
    // core stays pure: no browser driver, no Node APIs, no other workspace package.
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: builtinModules.map((name) => ({
            name,
            message: 'core must not use Node APIs; add a port instead.',
          })),
          patterns: [
            { group: ['node:*'], message: 'core must not use Node APIs; add a port instead.' },
            { group: ['playwright', 'playwright/*', 'playwright-core', 'playwright-core/*', '@playwright/*'], message: 'core must not depend on Playwright; use BrowserPort.' },
            { group: ['@webscoop/*'], message: 'core must not import other workspace packages.' },
          ],
        },
      ],
    },
  },
);
