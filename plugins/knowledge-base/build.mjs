// Đóng gói src/ thành một file main.js duy nhất (plugin không có node_modules khi chạy — ADR-0010).
// Chạy: pnpm --filter @nsa/plugin-knowledge-base build
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [join(root, 'src/index.js')],
  outfile: join(root, 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  legalComments: 'none',
  // unpdf kèm bản pdf.js không cần worker; gói luôn vào để plugin tự đủ.
  banner: {
    js: '// FILE SINH RA từ src/ bởi build.mjs — đừng sửa tay. Chạy: pnpm --filter @nsa/plugin-knowledge-base build',
  },
  logLevel: 'info',
});
