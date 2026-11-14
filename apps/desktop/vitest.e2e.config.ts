import { defineConfig } from 'vitest/config';
import { workspaceAliases } from '../../workspace-aliases';

// Bài mở app tự động (G2) — tách khỏi `pnpm test` vì cần dựng app và mở cửa sổ thật.
export default defineConfig({
  resolve: { alias: workspaceAliases(`${__dirname}/../..`) },
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    testTimeout: 90_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    bail: 1, // một bước hỏng thì dừng ngay, các bước sau không còn ý nghĩa
  },
});
