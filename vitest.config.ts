import { defineConfig } from 'vitest/config';
import { workspaceAliases } from './workspace-aliases';

export default defineConfig({
  resolve: { alias: workspaceAliases(import.meta.dirname) },
  test: {
    // Bài mở app (*.e2e.test.ts) cần dựng app: chạy riêng bằng `pnpm --filter @nsa/desktop test:e2e`.
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'plugins/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/*.e2e.test.ts'],
    // Test chạy NSA Mem thật (git + SQLite) và tiến trình con: máy bận thì lâu hơn 5 giây mặc định.
    testTimeout: 30_000,
  },
});
