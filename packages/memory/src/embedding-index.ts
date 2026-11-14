/**
 * Tìm theo nghĩa (vector) — hiện thực `VectorIndex` bằng model loại việc "embedding" (ADR-0015).
 *
 * - Không nhị phân gốc, không model đóng gói kèm: vector tính bằng model embedding của hãng người
 *   dùng đã có key (hoặc máy cục bộ như Ollama / LM Studio). Chưa có model → `available = false`
 *   và nơi gọi lùi về FTS5.
 * - File Markdown vẫn là bản gốc: chỉ mục vector (`.nsa/vectors.json`) mất thì dựng lại từ Markdown.
 * - Tính vector LƯỜI: ghi mục nhớ không gọi mạng; vector được bổ sung ở lần tìm kế tiếp
 *   (hoặc khi gọi `sync`). Mục nhạy cảm KHÔNG bao giờ được gửi đi tính vector.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MemoryEntry } from '@nsa/core';
import type { VectorIndex } from './vector.js';

export interface EmbeddingIndexOptions {
  /** File lưu vector, ví dụ `<kho>/.nsa/vectors.json`. */
  file: string;
  /** Tính vector cho một lô văn bản (ném lỗi khi chưa có model embedding). */
  embed: (texts: string[]) => Promise<number[][]>;
  /** Đã có model embedding để dùng chưa (rẻ, đồng bộ). */
  ready: () => boolean;
  /** Toàn bộ mục nhớ hiện có — để bổ sung vector còn thiếu. */
  entries: () => MemoryEntry[];
  batchSize?: number;
}

interface Stored {
  /** Phiên bản định dạng. */
  v: 1;
  /** Số chiều; đổi model (số chiều khác) thì bỏ hết vector cũ. */
  dims: number;
  items: Record<string, { hash: string; vec: number[] }>;
}

export function embeddingText(entry: Pick<MemoryEntry, 'title' | 'body'>): string {
  return `${entry.title}\n${entry.body}`.slice(0, 6000);
}

const hashOf = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 16);

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export class EmbeddingVectorIndex implements VectorIndex {
  readonly #o: EmbeddingIndexOptions;
  #data: Stored;
  #syncing: Promise<void> | null = null;

  constructor(options: EmbeddingIndexOptions) {
    this.#o = options;
    this.#data = this.#load();
  }

  get available(): boolean {
    return this.#o.ready();
  }

  /** Số mục đã có vector (cho màn hình trạng thái). */
  get count(): number {
    return Object.keys(this.#data.items).length;
  }

  #load(): Stored {
    try {
      if (existsSync(this.#o.file)) {
        const raw = JSON.parse(readFileSync(this.#o.file, 'utf8')) as Stored;
        if (raw && raw.v === 1 && typeof raw.items === 'object') return raw;
      }
    } catch {
      /* hỏng thì dựng lại từ Markdown */
    }
    return { v: 1, dims: 0, items: {} };
  }

  #save(): void {
    mkdirSync(dirname(this.#o.file), { recursive: true });
    const tmp = `${this.#o.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#data));
    renameSync(tmp, this.#o.file);
  }

  // Ghi mục nhớ không tính vector ngay (không chờ mạng): `sync` sẽ bổ sung.
  async upsert(): Promise<void> {
    return;
  }

  async remove(id: string): Promise<void> {
    if (this.#data.items[id]) {
      delete this.#data.items[id];
      this.#save();
    }
  }

  async rebuild(): Promise<void> {
    this.#data = { v: 1, dims: 0, items: {} };
    this.#save();
  }

  /** Bổ sung vector cho mục còn thiếu / đã đổi, bỏ vector của mục đã mất. Không chạy chồng nhau. */
  sync(): Promise<void> {
    this.#syncing ??= this.#doSync().finally(() => {
      this.#syncing = null;
    });
    return this.#syncing;
  }

  async #doSync(): Promise<void> {
    const entries = this.#o.entries().filter((e) => !e.sensitive);
    const alive = new Set(entries.map((e) => e.id));
    let changed = false;
    for (const id of Object.keys(this.#data.items)) {
      if (!alive.has(id)) {
        delete this.#data.items[id];
        changed = true;
      }
    }
    const todo = entries.filter((e) => this.#data.items[e.id]?.hash !== hashOf(embeddingText(e)));
    const size = this.#o.batchSize ?? 24;
    for (let i = 0; i < todo.length; i += size) {
      const batch = todo.slice(i, i + size);
      const vectors = await this.#o.embed(batch.map(embeddingText));
      if (vectors.length !== batch.length) throw new Error('Model embedding trả thiếu vector');
      const dims = vectors[0]?.length ?? 0;
      if (dims === 0) throw new Error('Model embedding trả vector rỗng');
      if (this.#data.dims && this.#data.dims !== dims) {
        // Đổi model embedding: vector cũ không so được với vector mới.
        this.#data = { v: 1, dims, items: {} };
        return this.#doSync();
      }
      this.#data.dims = dims;
      batch.forEach((e, j) => {
        this.#data.items[e.id] = {
          hash: hashOf(embeddingText(e)),
          vec: (vectors[j] ?? []).map((x) => Math.round(x * 1e5) / 1e5),
        };
      });
      changed = true;
      this.#save();
    }
    if (changed) this.#save();
  }

  async query(text: string, limit: number): Promise<{ id: string; score: number }[]> {
    await this.sync();
    const [q] = await this.#o.embed([text.slice(0, 2000)]);
    if (!q || q.length === 0) throw new Error('Model embedding trả vector rỗng');
    if (this.#data.dims && q.length !== this.#data.dims) {
      // Model đổi giữa chừng — dựng lại rồi tìm lại một lần.
      this.#data = { v: 1, dims: 0, items: {} };
      await this.sync();
    }
    return Object.entries(this.#data.items)
      .map(([id, item]) => ({ id, score: cosine(q, item.vec) }))
      .filter((r) => r.score > 0.2)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
