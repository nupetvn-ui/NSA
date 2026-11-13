// Plugin mẫu "Ghi chú nhanh". Chạy trong tiến trình riêng của NSA; không cần import gì của NSA.
// Kiểu: xem @nsa/plugin-sdk (PluginDefinition).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let file = '';

function load() {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}
function save(notes) {
  writeFileSync(file, JSON.stringify(notes, null, 2));
}

function add(text) {
  const clean = String(text ?? '').trim();
  if (!clean) throw new Error('Ghi chú trống.');
  const notes = load();
  const note = {
    id: (notes.at(-1)?.id ?? 0) + 1,
    text: clean.slice(0, 500),
    at: new Date().toISOString(),
  };
  notes.push(note);
  save(notes);
  return note;
}

async function pin(id, ctx) {
  if (!ctx.memory) {
    throw new Error('Plugin chưa được cấp quyền nhớ (NSA Mem). Bật ở Quản lý → Quyền.');
  }
  const note = load().find((n) => n.id === Number(id));
  if (!note) throw new Error(`Không có ghi chú ${id}.`);
  return ctx.memory.propose({
    title: `Ghi chú #${note.id}`,
    body: note.text,
    kind: 'fact',
    confidence: 0.9,
  });
}

/** @type {import('@nsa/plugin-sdk').PluginDefinition} */
export default {
  activate(ctx) {
    file = join(ctx.dataDir, 'notes.json');
  },

  // Tool MCP — agent gọi qua cổng của NSA (qua chính sách + nhật ký).
  tools: {
    add_note: (args) => {
      const note = add(args.text);
      return `Đã thêm ghi chú #${note.id}.`;
    },
    list_notes: () => {
      const notes = load().slice().reverse();
      return notes.length
        ? notes.map((n) => `#${n.id}: ${n.text}`).join('\n')
        : 'Chưa có ghi chú nào.';
    },
    pin_note: async (args, ctx) => {
      const result = await pin(args.id, ctx);
      return result.status === 'accepted'
        ? `Đã ghim vào bộ nhớ (mã ${result.entryId}).`
        : `Đã đưa vào hộp duyệt: ${result.reasons.join('; ') || 'chờ người dùng duyệt'}.`;
    },
    clear_notes: () => {
      const count = load().length;
      save([]);
      return `Đã xoá ${count} ghi chú.`;
    },
  },

  // Việc chạy nền — chạy mỗi 30 giây, báo thống kê tới màn hình đang mở.
  jobs: {
    stats: async (ctx) => {
      const notes = load();
      const stats = { count: notes.length, checkedAt: new Date().toISOString() };
      await ctx.config.set('stats', stats);
      ctx.emit('stats', stats);
    },
  },

  // Hàm cho màn hình (ui/index.html) gọi bằng nsa.call(...).
  ui: {
    list: () => load().slice().reverse(),
    add: (params) => add(params && params.text),
    remove: (params) => {
      save(load().filter((n) => n.id !== Number(params && params.id)));
      return true;
    },
    pin: (params, ctx) => pin(params && params.id, ctx),
    stats: (_params, ctx) => ctx.config.get('stats', null),
  },
};
