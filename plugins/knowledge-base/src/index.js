// Plugin Knowledge Base — điểm vào. Đóng gói thành `main.js` bằng build.mjs (esbuild).
import { Engine } from './engine.js';
import { clock } from './util.js';

/** @type {Engine | null} */
let engine = null;

const need = () => {
  if (!engine) throw new Error('Knowledge Base chưa sẵn sàng.');
  return engine;
};

function sourceLine(s) {
  const loc = s.loc ? ` · ${s.loc}` : '';
  return `${s.sourceName}${loc}`;
}

/** Tra nguồn / vị trí của một mục nhớ từ thẻ của nó. */
async function describeEntries(ctx, ids) {
  const entries = await ctx.memory.entries({ limit: 2000 });
  const eng = need();
  const out = new Map();
  for (const e of entries) {
    if (!ids.includes(e.id)) continue;
    const srcId = (e.tags.find((t) => t.startsWith('kb:src:')) ?? '').slice(7);
    const src = eng.cat.sources[srcId];
    out.set(e.id, {
      entry: e,
      sourceId: srcId,
      sourceName: src ? src.title || src.name : '(nguồn đã xoá)',
      kind: src?.kind ?? '',
      loc: (e.tags.find((t) => t.startsWith('kb:loc:')) ?? '').slice(7),
    });
  }
  return out;
}

async function kbSearch(args, ctx) {
  if (!ctx.memory) throw new Error('Plugin chưa được cấp quyền nhớ.');
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('Thiếu câu hỏi.');
  const limit = Math.min(12, Math.max(1, Number(args.limit) || 6));
  const { mode, hits } = await ctx.memory.searchSemantic(query, { limit });
  if (hits.length === 0) {
    return `Không tìm thấy gì trong Knowledge Base cho "${query}" (đã tìm theo ${mode === 'semantic' ? 'nghĩa' : 'từ khoá'}). Có thể người dùng chưa dạy điều này, hoặc mục còn nằm trong hộp duyệt chưa nhận.`;
  }
  const info = await describeEntries(ctx, hits.map((h) => h.id));
  const lines = [`Knowledge Base — ${hits.length} kết quả (tìm theo ${mode === 'semantic' ? 'nghĩa' : 'từ khoá'}):`];
  hits.forEach((h, i) => {
    const d = info.get(h.id);
    const body = (d?.entry.body ?? h.snippet).replace(/\n\n— Nguồn:.*$/s, '').trim();
    lines.push(
      `\n${i + 1}. [${h.id}] ${h.title}\n${body.slice(0, 700)}${body.length > 700 ? '…' : ''}\n   NGUỒN: ${d ? sourceLine(d) : h.title}${d?.kind ? ` (${d.kind})` : ''} — mở thêm bằng kb_open {"id":"${h.id}"}`,
    );
  });
  return lines.join('\n');
}

async function kbOpen(args, ctx) {
  const id = String(args.id ?? '').trim();
  if (!id) throw new Error('Thiếu mã mục.');
  const note = await ctx.memory.read(id).catch(() => null);
  if (!note) throw new Error('Không có mục này trong Knowledge Base.');
  const info = (await describeEntries(ctx, [id])).get(id);
  if (info?.entry.sensitive) {
    return 'Mục này được đánh dấu nhạy cảm nên không mở cho agent. Hãy hỏi người dùng.';
  }
  const eng = need();
  const lines = [`# ${note.title}`, '', note.body.replace(/\n\n— Nguồn:.*$/s, '').trim()];
  if (info && info.sourceId && eng.cat.sources[info.sourceId]) {
    const src = eng.cat.sources[info.sourceId];
    const c = eng.context(info.sourceId, info.loc);
    lines.push('', `## Nguồn: ${sourceLine(info)} (${src.kind})`);
    if (src.url) lines.push(`Link: ${src.url}`);
    if (src.note) lines.push(`Lời dặn khi dạy: ${src.note}`);
    if (c.kind === 'doc' && c.text) lines.push('', 'Đoạn gốc xung quanh:', c.text);
    if (c.kind === 'media') {
      lines.push('', `Phụ đề trong khoảng ${c.range}:`, c.text);
    }
    const d = eng.derived(src.id);
    const w = (d.windows ?? []).find((x) => x.loc === info.loc);
    if (w?.frames?.length) {
      lines.push('', 'Khung hình (file ảnh, đọc được bằng công cụ xem ảnh):');
      for (const f of w.frames.slice(0, 4)) lines.push(`- ${f}`);
    }
    if (src.kind === 'image') lines.push('', `File ảnh gốc: ${eng.original(src)}`);
    if (src.kind === 'video' || src.kind === 'audio') {
      lines.push('', `File gốc: ${eng.original(src)} (mốc ${info.loc}, tổng ${clock(src.duration ?? 0)})`);
    }
  }
  return lines.join('\n');
}

function kbSources() {
  const eng = need();
  const list = eng.cat.order.map((id) => eng.cat.sources[id]).filter(Boolean);
  if (list.length === 0) return 'Knowledge Base chưa có nguồn nào.';
  return list
    .map((s) => `- ${s.title || s.name} · ${s.kind} · bộ "${s.collection}" · ${s.status}`)
    .join('\n');
}

/** @type {import('@nsa/plugin-sdk').PluginDefinition} */
export default {
  async activate(ctx) {
    engine = new Engine(ctx);
    // Mở lại app giữa chừng một lô → các nguồn đang chạy được xếp lại và chạy tiếp.
    engine.kick();
  },
  async deactivate() {
    // Việc đang dở được lưu theo từng bước (derived.json): lần sau chạy tiếp, không làm lại từ đầu.
    engine = null;
  },

  tools: {
    kb_search: (args, ctx) => kbSearch(args, ctx),
    kb_open: (args, ctx) => kbOpen(args, ctx),
    kb_sources: () => kbSources(),
  },

  jobs: {
    tick: async () => {
      engine?.kick();
    },
  },

  ui: {
    overview: () => need().overview(),
    pending: () => need().pendingList(),
    context: (p) => need().context(String(p.sourceId), String(p.loc)),
    tools: (p) => need().tools(p && p.force === true),
    settings: (p) => (p && typeof p === 'object' ? need().saveSettings(p) : need().settings()),

    uploadStart: (p) => need().uploadStart(p),
    uploadChunk: (p) => need().uploadChunk(p),
    uploadFinish: (p) => need().uploadFinish(p),
    addUrl: (p) => need().addUrl(p),
    addFolder: (p) => need().addFolder(p),

    approve: (p) => need().approve(p.ids ?? []),
    pause: (p) => need().pause(String(p.id)),
    resume: (p) => need().resume(String(p.id)),
    cancel: (p) => need().cancel(String(p.id)),
    pauseAll: () => need().pauseAll(),
    resumeAll: () => need().resumeAll(),
    remove: (p) => need().removeSource(String(p.id)),
    undoRemove: () => need().undoRemove(),
    undoStale: (p) => need().undoStale(String(p.id)),
    downloadModel: (p) => need().downloadModel(p && p.name),

    accept: async (p, ctx) => {
      const edits = {};
      if (typeof p.title === 'string') edits.title = p.title;
      if (typeof p.body === 'string') edits.body = p.body;
      return ctx.memory.accept(String(p.id), edits);
    },
    reject: (p, ctx) => ctx.memory.reject(String(p.id)),
    /** Nhận cả lô. Mục nhạy cảm chỉ nhận khi `includeSensitive` (người dùng đã xác nhận). */
    acceptMany: async (p, ctx) => {
      const list = await need().pendingList();
      const ids = new Set((p.ids ?? []).map(String));
      let accepted = 0;
      let skipped = 0;
      for (const item of list) {
        if (!ids.has(item.id)) continue;
        if (item.sensitive && p.includeSensitive !== true) {
          skipped++;
          continue;
        }
        await ctx.memory.accept(item.id, {});
        accepted++;
      }
      return { accepted, skipped };
    },
    rejectMany: async (p, ctx) => {
      let n = 0;
      for (const id of p.ids ?? []) {
        await ctx.memory.reject(String(id)).then(() => n++, () => undefined);
      }
      return { rejected: n };
    },
    mask: (p) => need().mask(String(p.text ?? '')),
    search: async (p, ctx) => kbSearch({ query: p.query, limit: 8 }, ctx),
  },
};
