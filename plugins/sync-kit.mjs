// Chép bộ khung kênh dùng chung (plugins/_kit) vào từng plugin kênh. Chạy: node plugins/sync-kit.mjs
// Plugin phải tự đủ trong thư mục của nó (không import ra ngoài), nên mỗi plugin giữ một bản sao;
// plugins/channels.test.ts kiểm các bản sao không lệch nguồn.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHANNEL_PLUGINS = ['telegram', 'discord', 'zalo-oa', 'zalo-ca-nhan'];
export const COPIES = [
  ['channel-kit.js', 'kit.js'],
  ['ui/index.html', 'ui/index.html'],
  ['ui/app.js', 'ui/app.js'],
];

const root = dirname(fileURLToPath(import.meta.url));
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const plugin of CHANNEL_PLUGINS) {
    for (const [from, to] of COPIES) {
      mkdirSync(dirname(join(root, plugin, to)), { recursive: true });
      copyFileSync(join(root, '_kit', from), join(root, plugin, to));
    }
  }
  console.log('Đã đồng bộ bộ khung kênh vào', CHANNEL_PLUGINS.join(', '));
}
