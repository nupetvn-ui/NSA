import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import { boundaryLintConfigs } from './package-boundaries.js';

export default tseslint.config(
  {
    ignores: [
      '.claude/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/release/**',
      '**/coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // Màn hình plugin chạy trong khung cô lập của trình duyệt, có thêm window.nsa.
    files: ['plugins/**/ui/**/*.js'],
    languageOptions: { globals: { ...globals.browser, nsa: 'readonly' } },
  },
  // Ranh giới gói (G3, ADR-0015): import vượt sơ đồ phụ thuộc thì lint đỏ.
  ...boundaryLintConfigs(),
  prettier,
);
