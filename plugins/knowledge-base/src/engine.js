// Lõi của plugin Knowledge Base: danh mục nguồn, hàng đợi chạy nền (tạm dừng / huỷ / chạy tiếp sau
// khi mở lại app), các bước nạp tài liệu · ảnh · video, và đưa mọi điều học được vào HỘP DUYỆT của
// NSA Mem (không ghi thẳng). Chạy trong tiến trình plugin; chỉ dùng `ctx` do NSA cấp.
import {
  appendFileSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, extname, join, relative } from 'node:path';
import { makeChunks } from './chunk.js';
import {
  IMAGE_MIME,
  extractDocument,
  kindOf,
} from './extract.js';
import { htmlToBlocks } from './html.js';
import {
  buildWindows,
  extractAudio,
  extractFrames,
  probe,
  transcribe,
  windowLoc,
  windowText,
} from './media.js';
import { detectSensitive, maskSensitive } from './sensitive.js';
import { clock, estimateTokens, extOf, newId, safeName, sha1, slug } from './util.js';

export const DEFAULT_SETTINGS = {
  /** Hỏi trước khi chạy nếu ước tính chi phí từ mức này (USD) hoặc chưa biết giá. */
  askAboveUsd: 0.02,
  maxFrames: 40,
  language: 'auto',
  whisperModel: '',
  /** Tự nhận mục khi đủ tin cậy (quy tắc tự duyệt của NSA Mem). Mặc định TẮT: mọi thứ chờ người duyệt. */
  autoApprove: false,
  minConfidence: 0.85,
};

const MAX_DOC_BYTES = 120 * 1024 * 1024;
const MAX_CHUNKS = 2000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const TRASH_KEEP = 5;

/** Ném khi nguồn bị tạm dừng / huỷ giữa chừng (không phải lỗi). */
class Stop extends Error {}

const NO_VISION =
  'Chưa có model nhìn ảnh. Mở Nhà cung cấp → dán key của hãng có model nhìn ảnh (ví dụ Google AI Studio) rồi thử lại.';

const VISION_SYSTEM =
  'Bạn là bộ phận "đọc ảnh" của NSA. Chỉ nói điều nhìn thấy; không bịa. Trả lời bằng tiếng Việt.';

export function imagePrompt(note) {
  return [
    note ? `Lời dặn của người dùng cho ảnh này: "${note}".` : '',
    'Trả lời đúng hai phần:',
    'MÔ TẢ: 2–5 câu — ảnh là gì, chi tiết quan trọng, số liệu, tên, ngày.',
    'CHỮ TRONG ẢNH: chép NGUYÊN VĂN mọi chữ và số đọc được, giữ từng dòng; ghi "không có" nếu không có chữ.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function framePrompt(name, time, note) {
  return [
    `Đây là khung hình tại ${clock(time)} của video "${name}".`,
    note ? `Lời dặn của người dùng: "${note}".` : '',
    'Mô tả ngắn (1–3 câu) điều đang diễn ra, rồi chép nguyên văn chữ hiện trên màn hình nếu có (ghi sau "Chữ:").',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Tách trả lời của model nhìn ảnh thành mô tả + chữ. */
export function parseImageReply(text) {
  const t = String(text ?? '').trim();
  const m = /CH[ỮỪ]\s+TRONG\s+ẢNH\s*:/i.exec(t);
  const describe = (m ? t.slice(0, m.index) : t).replace(/^M[ÔO]\s*T[ẢA]\s*:\s*/i, '').trim();
  const ocr = m ? t.slice(m.index + m[0].length).trim() : '';
  return { describe, ocr: /^(không có|none|n\/a|-)\.?$/i.test(ocr) ? '' : ocr };
}

const tagVal = (entry, prefix) => {
  const t = entry.tags.find((x) => x.startsWith(prefix));
  return t ? t.slice(prefix.length) : undefined;
};

function fileHash(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

function atomicWrite(file, data) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export class Engine {
  /** @param ctx PluginContext của NSA (hoặc bản giả trong test). */
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.dir = ctx.dataDir;
    this.now = options.now ?? (() => new Date());
    this.cat = this.#loadCatalog();
    this.loop = null;
    this.timer = null;
    this.toolCache = { at: 0, value: null };
    mkdirSync(join(this.dir, 'files'), { recursive: true });
  }

  // ------------------------------------------------------------ lưu trữ

  get #catalogFile() {
    return join(this.dir, 'catalog.json');
  }

  #loadCatalog() {
    try {
      const raw = JSON.parse(readFileSync(this.#catalogFile, 'utf8'));
      return {
        v: 1,
        sources: raw.sources ?? {},
        order: raw.order ?? Object.keys(raw.sources ?? {}),
        settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
        collections: raw.collections ?? {},
        trash: raw.trash ?? [],
        queuePaused: raw.queuePaused === true,
      };
    } catch {
      return {
        v: 1,
        sources: {},
        order: [],
        settings: { ...DEFAULT_SETTINGS },
        collections: {},
        trash: [],
        queuePaused: false,
      };
    }
  }

  save() {
    atomicWrite(this.#catalogFile, JSON.stringify(this.cat));
    this.#changed();
  }

  #changedAt = 0;
  #changed() {
    const t = Date.now();
    if (t - this.#changedAt < 250) return;
    this.#changedAt = t;
    this.ctx.emit('changed', {});
  }

  sourceDir(id) {
    return join(this.dir, 'files', id);
  }
  derivedFile(id) {
    return join(this.sourceDir(id), 'derived.json');
  }
  derived(id) {
    try {
      return JSON.parse(readFileSync(this.derivedFile(id), 'utf8'));
    } catch {
      return {};
    }
  }
  saveDerived(id, data) {
    atomicWrite(this.derivedFile(id), JSON.stringify(data));
  }
  original(src) {
    return src.localPath ?? join(this.sourceDir(src.id), `original.${src.ext || 'bin'}`);
  }

  src(id) {
    const s = this.cat.sources[id];
    if (!s) throw new Error('Không có nguồn này.');
    return s;
  }

  settings() {
    return this.cat.settings;
  }
  saveSettings(patch) {
    const s = this.cat.settings;
    if (typeof patch.askAboveUsd === 'number') s.askAboveUsd = Math.max(0, patch.askAboveUsd);
    if (typeof patch.maxFrames === 'number') s.maxFrames = Math.min(80, Math.max(4, patch.maxFrames));
    if (typeof patch.language === 'string') s.language = /^[a-z]{2,3}$|^auto$/.test(patch.language) ? patch.language : 'auto';
    if (typeof patch.whisperModel === 'string') s.whisperModel = safeName(patch.whisperModel);
    if (typeof patch.autoApprove === 'boolean') {
      s.autoApprove = patch.autoApprove;
      this.cat.collections = {}; // áp lại cho từng bộ ở lần nạp kế tiếp
    }
    if (typeof patch.minConfidence === 'number') s.minConfidence = Math.min(1, Math.max(0.5, patch.minConfidence));
    this.save();
    return s;
  }

  // ------------------------------------------------------------ thêm nguồn

  /**
   * Thêm một file đã nằm trên đĩa (`file`) làm nguồn. `move`: chuyển file vào kho (file tạm tải lên);
   * `inPlace`: dùng ngay tại chỗ (thư mục đã cấp quyền) thay vì chép — dành cho video lớn.
   */
  async addFile({ file, name, relPath, note, collection, move = false, inPlace = false }) {
    const kind = kindOf(name);
    if (!kind) {
      throw new Error(`Chưa hỗ trợ file "${name}". Hỗ trợ: văn bản, Markdown, PDF, DOCX, XLSX/CSV, HTML, ảnh, video, âm thanh.`);
    }
    const stat = statSync(file);
    if (stat.size === 0) throw new Error(`File "${name}" rỗng.`);
    if (kind === 'doc' && stat.size > MAX_DOC_BYTES) throw new Error(`Tài liệu "${name}" lớn quá 120 MB.`);
    const hash = await fileHash(file);
    const ident = relPath || name;
    const key = sha1(`${kind}|${ident.toLowerCase()}`);
    const existing = Object.values(this.cat.sources).find((s) => s.key === key);
    if (existing && existing.hash === hash) {
      if (move) rmSync(file, { force: true });
      return { id: existing.id, status: 'unchanged' };
    }
    const sub = slug(collection || existing?.collection || 'chung');
    const id = existing?.id ?? newId('s');
    const dir = this.sourceDir(id);
    if (existing) {
      // Nạp lại cùng một file đã đổi: cập nhật nguồn cũ, không tạo nguồn mới.
      rmSync(join(dir, 'frames'), { recursive: true, force: true });
      rmSync(join(dir, 'derived.json'), { force: true });
    }
    mkdirSync(dir, { recursive: true });
    const ext = extOf(name);
    const src = {
      ...(existing ?? {}),
      id,
      key,
      kind,
      name: safeName(name),
      relPath: relPath || '',
      ext,
      size: stat.size,
      hash,
      note: String(note ?? existing?.note ?? '').slice(0, 1000),
      collection: sub,
      addedAt: existing?.addedAt ?? this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      status: 'estimating',
      error: '',
      warnings: [],
      sensitive: [],
      progress: { done: 0, total: 0, label: '' },
      updating: Boolean(existing),
    };
    delete src.localPath;
    if (inPlace) src.localPath = file;
    else {
      const dest = join(dir, `original.${ext || 'bin'}`);
      if (move) {
        try {
          renameSync(file, dest);
        } catch {
          copyFileSync(file, dest);
          rmSync(file, { force: true });
        }
      } else copyFileSync(file, dest);
    }
    this.cat.sources[id] = src;
    if (!this.cat.order.includes(id)) this.cat.order.unshift(id);
    this.save();
    await this.#prepare(src);
    return { id, status: existing ? 'updated' : 'created' };
  }

  /** Dán đường link: tải trang (HTML / PDF / DOCX…) và nạp như tài liệu. */
  async addUrl({ url, note, collection }) {
    let u;
    try {
      u = new URL(String(url).trim());
    } catch {
      throw new Error('Đường link không hợp lệ.');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Chỉ nhận link http / https.');
    u.hash = '';
    const response = await this.ctx.fetch(u.href, {
      headers: { 'user-agent': 'NSA-KnowledgeBase/1.0', accept: 'text/html,application/pdf,text/plain,*/*;q=0.5' },
    });
    if (!response.ok) throw new Error(`Không tải được trang (HTTP ${response.status}).`);
    const type = (response.headers.get('content-type') || '').toLowerCase();
    const bytes = Buffer.from(await response.arrayBuffer());
    let ext = 'html';
    if (type.includes('pdf')) ext = 'pdf';
    else if (type.includes('wordprocessingml')) ext = 'docx';
    else if (type.includes('spreadsheetml')) ext = 'xlsx';
    else if (type.includes('csv')) ext = 'csv';
    else if (type.includes('markdown')) ext = 'md';
    else if (type.startsWith('text/plain')) ext = 'txt';
    else if (!type.includes('html') && type && !type.startsWith('text/')) {
      throw new Error(`Loại nội dung "${type.split(';')[0]}" chưa hỗ trợ (cần trang web, PDF, DOCX, XLSX, CSV hoặc văn bản).`);
    }
    const label = `${u.hostname}${u.pathname === '/' ? '' : u.pathname}`.slice(0, 100);
    const tmp = join(this.dir, 'uploads', `${newId('u')}.part`);
    mkdirSync(join(this.dir, 'uploads'), { recursive: true });
    writeFileSync(tmp, bytes);
    const result = await this.addFile({
      file: tmp,
      name: `${safeName(label)}.${ext}`,
      relPath: `url:${u.href}`,
      note,
      collection,
      move: true,
    });
    const src = this.cat.sources[result.id];
    if (src) {
      src.kind = 'doc';
      src.url = u.href;
      this.save();
    }
    return result;
  }

  /** Quét thư mục đã được cấp quyền (id `kho`): nạp mọi file hỗ trợ, video dùng tại chỗ. */
  async addFolder({ folder, note, collection }) {
    const root = this.ctx.folder(folder || 'kho');
    const results = [];
    const walk = async (dir) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) {
          if (!ent.name.startsWith('.') && ent.name !== 'node_modules') await walk(full);
        } else if (ent.isFile() && kindOf(ent.name)) {
          try {
            const k = kindOf(ent.name);
            results.push({
              name: ent.name,
              ...(await this.addFile({
                file: full,
                name: ent.name,
                relPath: relative(root, full).replace(/\\/g, '/'),
                note,
                collection,
                inPlace: k === 'video' || k === 'audio',
              })),
            });
          } catch (err) {
            results.push({ name: ent.name, status: 'error', error: err.message });
          }
          if (results.length >= 500) return;
        }
      }
    };
    await walk(root);
    return results;
  }

  // ------------------------------------------------------------ tải lên từng đoạn (kéo-thả)

  uploadStart({ name, size }) {
    if (!kindOf(name)) throw new Error(`Chưa hỗ trợ file "${name}".`);
    const id = newId('u');
    mkdirSync(join(this.dir, 'uploads'), { recursive: true });
    writeFileSync(join(this.dir, 'uploads', `${id}.part`), '');
    return { uploadId: id, size: Number(size) || 0 };
  }
  uploadChunk({ uploadId, b64 }) {
    if (!/^u-[0-9a-f]{8}$/.test(String(uploadId))) throw new Error('Mã tải lên sai.');
    const bytes = Buffer.from(String(b64), 'base64');
    appendFileSync(join(this.dir, 'uploads', `${uploadId}.part`), bytes);
    return bytes.length;
  }
  async uploadFinish({ uploadId, name, relPath, note, collection }) {
    if (!/^u-[0-9a-f]{8}$/.test(String(uploadId))) throw new Error('Mã tải lên sai.');
    return this.addFile({
      file: join(this.dir, 'uploads', `${uploadId}.part`),
      name,
      relPath,
      note,
      collection,
      move: true,
    });
  }

  // ------------------------------------------------------------ ước tính + duyệt chạy

  /** Việc cần model, ước lượng token + chi phí (hiện cho người dùng trước khi chạy). */
  async #prepare(src) {
    try {
      const est = { calls: 0, inputTokens: 0, outputTokens: 0, usd: null, notes: [], seconds: 0 };
      if (src.kind === 'image') {
        est.calls = 1;
        est.inputTokens = 1500;
        est.outputTokens = 500;
      } else if (src.kind === 'video' || src.kind === 'audio') {
        const info = await probe(this.ctx.cli, this.original(src));
        src.duration = info.duration;
        src.hasVideo = info.hasVideo;
        src.hasAudio = info.hasAudio;
        if (src.kind === 'video' && info.hasVideo) {
          const frames = Math.min(this.cat.settings.maxFrames, Math.max(3, Math.ceil(info.duration / 30)));
          est.calls = frames;
          est.inputTokens = frames * 1500;
          est.outputTokens = frames * 250;
        }
        est.seconds = Math.round(info.duration * 0.4);
        est.notes.push(`Thời lượng ${clock(info.duration)}`);
      }
      if (est.calls > 0) {
        const st = await this.#visionStatus();
        est.visionAvailable = st.available;
        est.label = st.label ?? '';
        if (st.available && st.inputUsdPer1M != null && st.outputUsdPer1M != null) {
          est.usd = (est.inputTokens * st.inputUsdPer1M + est.outputTokens * st.outputUsdPer1M) / 1e6;
        }
        est.budget = st.budget;
      }
      src.estimate = est;
      if (est.calls > 0 && est.visionAvailable === false && src.kind === 'image') {
        src.status = 'failed';
        src.error = NO_VISION;
      } else {
        // Chưa có model nhìn ảnh mà là video: vẫn chạy được bằng phụ đề (cảnh báo khi chạy), không tốn token.
        const needsAsk =
          est.calls > 0 &&
          est.visionAvailable !== false &&
          (est.usd === null || est.usd >= this.cat.settings.askAboveUsd);
        src.status = needsAsk ? 'awaiting' : 'queued';
      }
    } catch (err) {
      src.status = 'failed';
      src.error = String(err.message ?? err);
    }
    this.save();
    this.kick();
  }

  async #visionStatus() {
    if (!this.ctx.model) return { available: false, budget: { limitUsd: null, spentUsd: 0, level: 'ok' } };
    try {
      return await this.ctx.model.status('vision');
    } catch {
      return { available: false, budget: { limitUsd: null, spentUsd: 0, level: 'ok' } };
    }
  }

  approve(ids) {
    for (const id of ids) {
      const s = this.cat.sources[id];
      if (s && s.status === 'awaiting') s.status = 'queued';
    }
    this.save();
    this.kick();
  }

  // ------------------------------------------------------------ điều khiển hàng đợi

  pause(id) {
    const s = this.src(id);
    if (s.status === 'running' || s.status === 'queued') s.status = 'paused';
    this.save();
  }
  resume(id) {
    const s = this.src(id);
    if (s.status === 'paused' || s.status === 'failed') {
      s.status = 'queued';
      s.error = '';
    }
    this.save();
    this.kick();
  }
  cancel(id) {
    const s = this.src(id);
    if (['queued', 'running', 'paused', 'awaiting', 'estimating', 'failed'].includes(s.status)) {
      s.status = 'cancelled';
    }
    this.save();
  }
  pauseAll() {
    this.cat.queuePaused = true;
    for (const s of Object.values(this.cat.sources)) if (s.status === 'running') s.status = 'paused';
    this.save();
  }
  resumeAll() {
    this.cat.queuePaused = false;
    for (const s of Object.values(this.cat.sources)) if (s.status === 'paused') s.status = 'queued';
    this.save();
    this.kick();
  }

  /** Gọi sau khi mở app, khi thêm nguồn, khi tiếp tục: chạy các nguồn đang chờ, lần lượt từng cái. */
  kick() {
    if (this.loop || this.cat.queuePaused) return;
    // Nguồn đang "chạy" mà tiến trình đã chết (đóng app giữa chừng) → xếp lại hàng đợi.
    for (const s of Object.values(this.cat.sources)) if (s.status === 'running') s.status = 'queued';
    this.loop = this.#drain().finally(() => {
      this.loop = null;
    });
  }

  async idle() {
    while (this.loop) await this.loop;
  }

  async #drain() {
    for (;;) {
      if (this.cat.queuePaused) return;
      const next = [...this.cat.order]
        .reverse()
        .map((id) => this.cat.sources[id])
        .find((s) => s && s.status === 'queued');
      if (!next) return;
      await this.#process(next);
    }
  }

  async #process(src) {
    src.status = 'running';
    src.error = '';
    src.startedAt = this.now().toISOString();
    this.save();
    try {
      if (src.kind === 'doc') await this.#ingestDoc(src);
      else if (src.kind === 'image') await this.#ingestImage(src);
      else await this.#ingestMedia(src);
      this.#check(src);
      src.status = 'ingested';
      src.finishedAt = this.now().toISOString();
      src.progress = { ...src.progress, label: 'Xong — chờ duyệt' };
      this.#notifyDone(src);
    } catch (err) {
      if (err instanceof Stop) {
        // paused / cancelled do người dùng đặt — giữ nguyên
      } else {
        src.status = 'failed';
        src.error = String(err.message ?? err).slice(0, 600);
        this.ctx.log(`Nạp "${src.name}" lỗi: ${src.error}`, 'warn');
      }
    }
    this.save();
  }

  #notifyDone(src) {
    this.ctx.notify?.({ title: 'Knowledge Base', body: `Đã học xong "${src.name}" — vào duyệt.` }).catch?.(() => undefined);
  }

  #check(src) {
    if (src.status !== 'running') throw new Stop();
  }

  #progress(src, done, total, label) {
    src.progress = { done, total, label };
    this.save();
  }

  // ------------------------------------------------------------ nạp tài liệu

  async #ingestDoc(src) {
    const d = this.derived(src.id);
    if (!d.chunks) {
      this.#progress(src, 0, 1, 'Đang đọc tài liệu');
      const bytes = readFileSync(this.original(src));
      let blocks;
      let warnings = [];
      if (src.url && extOf(src.name) === 'html') {
        const html = htmlToBlocks(bytes.toString('utf8'));
        blocks = html.blocks;
        if (html.title) src.title = html.title.slice(0, 160);
      } else {
        const r = await extractDocument(bytes, src.name);
        blocks = r.blocks;
        warnings = r.warnings;
      }
      this.#check(src);
      let chunks = makeChunks(blocks);
      if (chunks.length > MAX_CHUNKS) {
        warnings.push(`Tài liệu có ${chunks.length} đoạn; chỉ nạp ${MAX_CHUNKS} đoạn đầu (chia nhỏ tài liệu để nạp phần còn lại).`);
        chunks = chunks.slice(0, MAX_CHUNKS);
      }
      if (chunks.length === 0) warnings.push('Không tìm thấy chữ nào để nhớ trong tài liệu này.');
      src.warnings.push(...warnings);
      d.chunks = chunks;
      this.saveDerived(src.id, d);
    }
    await this.#publish(
      src,
      d.chunks.map((c) => ({ loc: c.loc, text: c.text, confidence: src.url ? 0.85 : 0.9 })),
    );
  }

  // ------------------------------------------------------------ nạp ảnh

  async #ingestImage(src) {
    const d = this.derived(src.id);
    if (!d.vision) {
      const mime = IMAGE_MIME[src.ext];
      const bytes = readFileSync(this.original(src));
      if (bytes.length > MAX_IMAGE_BYTES) {
        throw new Error(`Ảnh lớn ${(bytes.length / 1048576).toFixed(1)} MB (tối đa 10 MB). Hãy thu nhỏ ảnh rồi nạp lại.`);
      }
      if (!this.ctx.model) throw new Error('Plugin chưa được cấp quyền dùng model (App Store → Quản lý → Quyền).');
      await this.#needBudget('vision');
      this.#progress(src, 0, 1, 'Model đang nhìn ảnh');
      const text = await this.ctx.model.vision(imagePrompt(src.note), [{ mimeType: mime, base64: bytes.toString('base64') }], { system: VISION_SYSTEM });
      this.#check(src);
      d.vision = parseImageReply(text);
      this.saveDerived(src.id, d);
    }
    const { describe, ocr } = d.vision;
    const parts = [];
    if (src.note) parts.push(`Lời dặn của người dùng: ${src.note}`);
    if (describe) parts.push(`Mô tả: ${describe}`);
    if (ocr) parts.push(`Chữ trong ảnh:\n${ocr}`);
    await this.#publish(src, [{ loc: 'ảnh', text: parts.join('\n\n'), confidence: 0.8 }]);
  }

  async #needBudget(task) {
    if (!this.ctx.model) return;
    const st = await this.ctx.model.status(task).catch(() => null);
    if (st && !st.available) {
      throw new Error(task === 'vision' ? NO_VISION : `Chưa có model cho việc "${task}".`);
    }
    if (st && st.budget.level === 'over') {
      throw new Error(`Đã vượt hạn mức chi phí tháng (${st.budget.spentUsd.toFixed(2)} / ${st.budget.limitUsd} USD). Tăng hạn mức trong Nhà cung cấp rồi bấm Tiếp tục.`);
    }
  }

  // ------------------------------------------------------------ nạp video / âm thanh

  async #ingestMedia(src) {
    const file = this.original(src);
    const dir = this.sourceDir(src.id);
    const d = this.derived(src.id);
    const save = () => this.saveDerived(src.id, d);
    const cli = this.ctx.cli;

    if (!d.duration) {
      this.#progress(src, 0, 4, 'Đọc thông tin file');
      const info = await probe(cli, file);
      d.duration = info.duration;
      d.hasVideo = info.hasVideo;
      d.hasAudio = info.hasAudio;
      save();
    }
    const wantFrames = src.kind === 'video' && d.hasVideo;
    const wantSpeech = d.hasAudio;

    // 1) Tiếng → phụ đề có mốc thời gian
    if (wantSpeech && d.segments === undefined) {
      const tool = await this.tools();
      const model = this.#whisperModelFile();
      if (!tool.whisper.ok || !model) {
        d.segments = null; // bỏ qua, ghi cảnh báo
        src.warnings.push(
          !tool.whisper.ok
            ? `Chưa nhận dạng được giọng nói: ${tool.whisper.hint}`
            : 'Chưa nhận dạng được giọng nói: chưa tải model nhận dạng (Knowledge Base → Công cụ → Tải model).',
        );
      } else {
        this.#progress(src, 1, 4, 'Tách tiếng');
        const wav = join(dir, 'audio.wav');
        await extractAudio(cli, file, wav);
        this.#check(src);
        this.#progress(src, 2, 4, 'Nhận dạng giọng nói (có thể mất vài phút)');
        d.segments = await transcribe(cli, wav, model, join(dir, 'asr'), this.cat.settings.language);
        rmSync(wav, { force: true });
        if (d.segments.length === 0) src.warnings.push('Không nhận ra lời nói nào trong file.');
      }
      save();
    }
    this.#check(src);

    // 2) Khung hình theo cảnh
    if (wantFrames && !d.frames) {
      this.#progress(src, 2, 4, 'Tách khung hình theo cảnh');
      const frames = await extractFrames(cli, file, join(dir, 'frames'), d.duration, { maxFrames: this.cat.settings.maxFrames });
      d.frames = frames.map((f) => ({ time: f.time, file: f.file }));
      save();
    }
    this.#check(src);

    // 3) Model nhìn ảnh mô tả từng khung (lưu từng bước → chạy tiếp được sau khi đóng app)
    if (wantFrames && d.frames?.length && d.frames.some((f) => f.description === undefined)) {
      let canSee = true;
      try {
        await this.#needBudget('vision');
      } catch (err) {
        if (d.segments && d.segments.length) {
          canSee = false;
          src.warnings.push(`Bỏ qua mô tả hình ảnh: ${err.message}`);
          d.frames.forEach((f) => (f.description = ''));
          save();
        } else throw err;
      }
      if (canSee) {
        const todo = d.frames.map((f, i) => i).filter((i) => d.frames[i].description === undefined);
        let done = d.frames.length - todo.length;
        const total = d.frames.length;
        const worker = async () => {
          for (;;) {
            this.#check(src);
            const i = todo.shift();
            if (i === undefined) return;
            const f = d.frames[i];
            const bytes = readFileSync(f.file);
            f.description = (
              await this.ctx.model.vision(framePrompt(src.name, f.time, src.note), [{ mimeType: 'image/jpeg', base64: bytes.toString('base64') }], { system: VISION_SYSTEM })
            ).trim();
            done++;
            save();
            this.#progress(src, done, total, `Model mô tả khung hình ${done}/${total}`);
          }
        };
        await Promise.all([worker(), worker()]);
      }
    }
    this.#check(src);

    // 4) Gộp phụ đề + mô tả khung hình thành các mục dẫn về đúng phút-giây
    const windows = buildWindows(d.duration, d.segments ?? [], d.frames ?? []);
    d.windows = windows.map((w) => ({ loc: windowLoc(w), start: w.start, end: w.end, frames: w.frames }));
    save();
    if (windows.length === 0) {
      throw new Error('Không rút được nội dung nào từ file này (không nhận ra lời nói và không có mô tả hình ảnh). Kiểm tra công cụ nhận dạng giọng nói và model nhìn ảnh.');
    }
    await this.#publish(
      src,
      windows.map((w) => ({ loc: windowLoc(w), text: windowText(w), confidence: 0.75 })),
    );
  }

  #whisperModelFile() {
    const dir = join(this.dir, 'models');
    if (!existsSync(dir)) return '';
    const wanted = this.cat.settings.whisperModel;
    const files = readdirSync(dir).filter((f) => /^ggml-.*\.bin$/.test(f));
    const pick = wanted && files.includes(wanted) ? wanted : files.sort()[0];
    return pick ? join(dir, pick) : '';
  }

  /** Tình trạng công cụ ngoài + model — cache 30 giây. */
  async tools(force = false) {
    if (!force && this.toolCache.value && Date.now() - this.toolCache.at < 30_000) return this.toolCache.value;
    const check = async (id, args, install) => {
      if (!this.ctx.cli) return { ok: false, hint: 'Plugin chưa được cấp quyền chạy chương trình ngoài.' };
      const r = await this.ctx.cli.run(id, args, { timeoutMs: 15_000 }).catch((e) => ({ error: String(e.message ?? e) }));
      if (r.error) return { ok: false, hint: r.error };
      return { ok: true, hint: install };
    };
    const model = async (task) => {
      if (!this.ctx.model) return { available: false };
      try {
        return await this.ctx.model.status(task);
      } catch {
        return { available: false };
      }
    };
    const value = {
      ffmpeg: await check('ffmpeg', ['-hide_banner', '-version'], ''),
      whisper: await check('whisper-cli', ['-h'], ''),
      whisperModel: basename(this.#whisperModelFile() || ''),
      vision: await model('vision'),
      embedding: await model('embedding'),
    };
    this.toolCache = { at: Date.now(), value };
    return value;
  }

  /** Tải model nhận dạng giọng nói (whisper.cpp, ggml) từng khúc 8 MB — lệnh gọi mạng bị giới hạn 10 MB. */
  async downloadModel(name = 'base') {
    const sizes = { tiny: 77_691_713, base: 147_951_465, small: 487_601_967 };
    if (!sizes[name]) throw new Error('Chọn model: tiny, base hoặc small.');
    const file = `ggml-${name}.bin`;
    const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`;
    const dir = join(this.dir, 'models');
    mkdirSync(dir, { recursive: true });
    const part = join(dir, `${file}.part`);
    writeFileSync(part, '');
    const piece = 8 * 1024 * 1024;
    let offset = 0;
    let total = sizes[name];
    while (offset < total) {
      const end = Math.min(offset + piece, total) - 1;
      const res = await this.ctx.fetch(url, { headers: { range: `bytes=${offset}-${end}` } });
      if (res.status !== 206 && !(res.status === 200 && offset === 0 && total <= piece)) {
        rmSync(part, { force: true });
        throw new Error(`Máy chủ không cho tải từng khúc (HTTP ${res.status}).`);
      }
      const cr = /\/(\d+)$/.exec(res.headers.get('content-range') || '');
      if (cr) total = Number(cr[1]);
      const bytes = Buffer.from(await res.arrayBuffer());
      appendFileSync(part, bytes);
      offset += bytes.length;
      this.ctx.emit('download', { name, done: offset, total });
      if (bytes.length === 0) break;
    }
    renameSync(part, join(dir, file));
    this.cat.settings.whisperModel = file;
    this.save();
    this.toolCache = { at: 0, value: null };
    return { file, bytes: offset };
  }

  // ------------------------------------------------------------ đưa vào hộp duyệt

  async #ensureCollection(sub) {
    const mem = this.ctx.memory;
    if (!mem) throw new Error('Plugin chưa được cấp quyền nhớ (NSA Mem). Bật ở Quản lý → Quyền.');
    if (this.cat.collections[sub]) return;
    await mem.setAutoApprove(sub, this.cat.settings.autoApprove, this.cat.settings.minConfidence);
    this.cat.collections[sub] = { at: this.now().toISOString() };
    this.save();
  }

  /**
   * items: [{ loc, text, confidence }] → đề xuất vào hộp duyệt. Mục đã có và không đổi thì bỏ qua;
   * đổi thì sửa mục cũ (không nhân đôi); đoạn không còn trong bản mới thì gỡ (hoàn tác được).
   */
  async #publish(src, items) {
    const mem = this.ctx.memory;
    await this.#ensureCollection(src.collection);
    const sub = src.collection;
    const d = this.derived(src.id);
    const srcTag = `kb:src:${src.id}`;
    const entries = (await mem.entries({ subBranch: sub, limit: 2000 })).filter((e) => e.tags.includes(srcTag));
    const byLoc = new Map(entries.map((e) => [tagVal(e, 'kb:loc:'), e]));

    if (!d.publish) {
      // Bắt đầu mới: đề xuất cũ của chính nguồn này (bản trước của file) chưa duyệt thì bỏ.
      for (const p of await mem.pending({ subBranch: sub })) {
        if (p.tags.includes(srcTag)) await mem.reject(p.id).catch(() => undefined);
      }
      d.publish = { done: {} };
      this.saveDerived(src.id, d);
    }
    let n = 0;
    const flagged = [];
    for (const item of items) {
      this.#check(src);
      const text = item.text.trim();
      if (!text) continue;
      const h = sha1(text).slice(0, 10);
      const key = `${item.loc}|${h}`;
      n++;
      if (d.publish.done[key]) continue;
      const old = byLoc.get(item.loc);
      if (old && tagVal(old, 'kb:h:') === h) {
        d.publish.done[key] = 'giữ nguyên';
        continue;
      }
      const sens = detectSensitive(text);
      if (sens.length) flagged.push({ loc: item.loc, what: sens });
      const title = `${src.title || src.name} — ${item.loc}`.slice(0, 150);
      const body = `${text}\n\n— Nguồn: ${src.title || src.name} · ${item.loc}`;
      const res = await mem.propose({
        title,
        body,
        kind: 'fact',
        confidence: sens.length ? Math.min(item.confidence, 0.5) : item.confidence,
        sensitive: sens.length > 0,
        subBranch: sub,
        tags: ['kb', srcTag, `kb:kind:${src.kind}`, `kb:loc:${item.loc}`, `kb:h:${h}`],
        ...(old ? { targetId: old.id } : {}),
      });
      d.publish.done[key] = res.status;
      if (n % 10 === 0) {
        this.saveDerived(src.id, d);
        this.#progress(src, n, items.length, 'Đưa vào hộp duyệt');
      }
    }
    // Đoạn cũ không còn trong bản mới → gỡ.
    const keep = new Set(items.map((i) => i.loc));
    const stale = entries.filter((e) => !keep.has(tagVal(e, 'kb:loc:')));
    if (stale.length) {
      const { undo } = await mem.remove(stale.map((e) => e.id));
      src.staleUndo = undo;
      src.warnings.push(`Đã gỡ ${stale.length} mục không còn trong bản mới của file (hoàn tác được ở nút "Hoàn tác gỡ").`);
    }
    if (flagged.length) {
      src.sensitive = flagged.slice(0, 50);
      src.warnings.push(
        `Phát hiện thông tin nhạy cảm ở ${flagged.length} đoạn (${[...new Set(flagged.flatMap((f) => f.what))].join(', ')}): các mục này KHÔNG được tự nhận, chỉ vào hộp duyệt để bạn quyết định.`,
      );
    }
    delete d.publish;
    this.saveDerived(src.id, d);
    this.#progress(src, items.length, items.length, 'Xong');
  }

  /** Hoàn tác việc gỡ các mục cũ khi nạp lại file. */
  async undoStale(id) {
    const src = this.src(id);
    if (!src.staleUndo?.length) throw new Error('Không có gì để hoàn tác.');
    const r = await this.ctx.memory.restore(src.staleUndo);
    delete src.staleUndo;
    this.save();
    return r;
  }

  // ------------------------------------------------------------ xoá nguồn (hoàn tác được)

  async removeSource(id) {
    const src = this.src(id);
    if (src.status === 'running') {
      src.status = 'cancelled';
      await this.idle();
    }
    const mem = this.ctx.memory;
    const srcTag = `kb:src:${id}`;
    const entries = (await mem.entries({ subBranch: src.collection, limit: 2000 })).filter((e) => e.tags.includes(srcTag));
    for (const p of await mem.pending({ subBranch: src.collection })) {
      if (p.tags.includes(srcTag)) await mem.reject(p.id).catch(() => undefined);
    }
    const { undo } = entries.length ? await mem.remove(entries.map((e) => e.id)) : { undo: [] };
    // Giữ file gốc trong thùng để hoàn tác được.
    const trashDir = join(this.dir, 'trash', id);
    rmSync(trashDir, { recursive: true, force: true });
    mkdirSync(join(this.dir, 'trash'), { recursive: true });
    if (existsSync(this.sourceDir(id))) renameSync(this.sourceDir(id), trashDir);
    this.cat.trash.unshift({ id, source: src, undo, at: this.now().toISOString(), entries: entries.length });
    delete this.cat.sources[id];
    this.cat.order = this.cat.order.filter((x) => x !== id);
    for (const old of this.cat.trash.splice(TRASH_KEEP)) rmSync(join(this.dir, 'trash', old.id), { recursive: true, force: true });
    this.save();
    return { removed: entries.length, canUndo: true };
  }

  async undoRemove() {
    const item = this.cat.trash.shift();
    if (!item) throw new Error('Không có nguồn nào vừa xoá.');
    if (item.undo.length) await this.ctx.memory.restore(item.undo);
    const trashDir = join(this.dir, 'trash', item.id);
    if (existsSync(trashDir)) renameSync(trashDir, this.sourceDir(item.id));
    this.cat.sources[item.id] = item.source;
    this.cat.order.unshift(item.id);
    this.save();
    return { id: item.id, name: item.source.name, restored: item.entries };
  }

  // ------------------------------------------------------------ hộp duyệt riêng

  async overview() {
    const mem = this.ctx.memory;
    let entries = [];
    let pending = [];
    if (mem) {
      entries = await mem.entries({ limit: 2000 }).catch(() => []);
      pending = await mem.pending().catch(() => []);
    }
    const count = (list, id) => list.filter((e) => e.tags?.includes(`kb:src:${id}`)).length;
    const sources = this.cat.order
      .map((id) => this.cat.sources[id])
      .filter(Boolean)
      .map((s) => ({
        id: s.id,
        kind: s.kind,
        name: s.title || s.name,
        file: s.name,
        collection: s.collection,
        size: s.size,
        note: s.note,
        status: s.status,
        error: s.error,
        warnings: s.warnings,
        sensitive: s.sensitive,
        progress: s.progress,
        estimate: s.estimate,
        duration: s.duration,
        url: s.url,
        addedAt: s.addedAt,
        updatedAt: s.updatedAt,
        accepted: count(entries, s.id),
        pending: count(pending, s.id),
        canUndoStale: Boolean(s.staleUndo?.length),
      }));
    return {
      settings: this.cat.settings,
      queuePaused: this.cat.queuePaused,
      sources,
      pendingTotal: pending.length,
      acceptedTotal: entries.length,
      trash: this.cat.trash.map((t) => ({ id: t.id, name: t.source.name, entries: t.entries, at: t.at })),
    };
  }

  async pendingList() {
    const mem = this.ctx.memory;
    if (!mem) return [];
    const list = await mem.pending();
    const entries = await mem.entries({ limit: 2000 }).catch(() => []);
    const byId = new Map(entries.map((e) => [e.id, e]));
    return list.map((p) => {
      const sourceId = (p.tags.find((t) => t.startsWith('kb:src:')) ?? '').slice(7);
      const src = this.cat.sources[sourceId];
      const old = p.targetId ? byId.get(p.targetId) : undefined;
      return {
        id: p.id,
        title: p.title,
        body: p.body,
        confidence: p.confidence,
        sensitive: p.sensitive,
        sensitiveWhat: detectSensitive(p.body),
        reasons: p.reasons,
        conflicts: p.conflicts,
        sourceId,
        sourceName: src ? src.title || src.name : '(nguồn đã xoá)',
        kind: src?.kind ?? (p.tags.find((t) => t.startsWith('kb:kind:')) ?? '').slice(8),
        loc: (p.tags.find((t) => t.startsWith('kb:loc:')) ?? '').slice(7),
        collection: p.subBranch,
        previous: old ? old.body : undefined,
        createdAt: p.createdAt,
      };
    });
  }

  /** Đối chiếu: đoạn gốc / khung hình / đoạn phụ đề ứng với một vị trí của nguồn. */
  context(sourceId, loc) {
    const src = this.cat.sources[sourceId];
    if (!src) return { kind: 'missing', text: 'Nguồn này đã bị xoá.' };
    const d = this.derived(sourceId);
    if (src.kind === 'image') {
      const file = this.original(src);
      const mime = IMAGE_MIME[src.ext] ?? 'image/png';
      return { kind: 'image', note: src.note, images: [{ label: src.name, dataUrl: dataUrl(file, mime) }], text: d.vision ? `${d.vision.describe}\n\n${d.vision.ocr}` : '' };
    }
    if (src.kind === 'video' || src.kind === 'audio') {
      const w = (d.windows ?? []).find((x) => x.loc === loc);
      const segs = w ? (d.segments ?? []).filter((s) => s.start >= w.start && s.start < w.end) : [];
      const frames = (w?.frames ?? []).slice(0, 3).map((f) => ({
        label: clock((d.frames ?? []).find((x) => x.file === f)?.time ?? w.start),
        dataUrl: dataUrl(f, 'image/jpeg'),
      }));
      return {
        kind: 'media',
        range: loc,
        images: frames,
        text: segs.map((s) => `[${clock(s.start)}] ${s.text}`).join('\n') || '(không có lời nói trong đoạn này)',
      };
    }
    const chunks = d.chunks ?? [];
    const i = chunks.findIndex((c) => c.loc === loc);
    const around = i < 0 ? [] : chunks.slice(Math.max(0, i - 1), i + 2);
    return {
      kind: 'doc',
      range: loc,
      text: around.map((c) => `── ${c.loc} ──\n${c.text}`).join('\n\n') || '(không tìm thấy đoạn gốc)',
    };
  }

  mask(text) {
    return maskSensitive(text);
  }
}

function dataUrl(file, mime) {
  try {
    return `data:${mime};base64,${readFileSync(file).toString('base64')}`;
  } catch {
    return '';
  }
}

export { extname, estimateTokens };
