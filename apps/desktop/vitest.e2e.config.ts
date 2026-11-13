import { defineConfig } from 'vitest/config';

// Bài mở app tự động (G2) — tách khỏi `pnpm test` vì cần dựng app và mở cửa sổ thật.
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    bail: 1, // một bước hỏng thì dừng ngay, các bước sau không còn ý nghĩa
  },
});
