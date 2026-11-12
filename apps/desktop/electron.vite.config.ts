import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { workspaceAliases } from '../../workspace-aliases';

// Các gói @nsa/* trong workspace được gộp thẳng từ mã nguồn vào bundle,
// nên không cần build chúng trước khi chạy dev hay đóng gói.
const alias = workspaceAliases(resolve(__dirname, '../..'));
const exclude = Object.keys(alias);

export default defineConfig({
  main: {
    resolve: { alias },
    // cross-spawn (dùng trong adapter) cũng được gộp vào bundle.
    build: { externalizeDeps: { exclude: [...exclude, 'cross-spawn'] } },
  },
  preload: {
    resolve: { alias },
    build: { externalizeDeps: { exclude } },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias },
    plugins: [react()],
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
