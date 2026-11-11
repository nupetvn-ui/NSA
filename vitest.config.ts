import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['@nsa/source'] },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'plugins/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**'],
  },
});
