import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Các gói @nsa/* trong workspace được gộp thẳng từ mã nguồn vào bundle,
// nên không cần build chúng trước khi chạy dev hay đóng gói.
const workspaceAlias = {
  '@nsa/core': resolve(__dirname, '../../packages/core/src/index.ts'),
};
const workspacePackages = Object.keys(workspaceAlias);

export default defineConfig({
  main: {
    resolve: { alias: workspaceAlias },
    build: { externalizeDeps: { exclude: workspacePackages } },
  },
  preload: {
    resolve: { alias: workspaceAlias },
    build: { externalizeDeps: { exclude: workspacePackages } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: workspaceAlias },
    plugins: [react()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
