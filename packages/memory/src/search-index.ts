/**
 * Chỉ mục tìm kiếm SQLite FTS5 — chỉ là bản sao dựng lại được từ file Markdown (bản gốc).
 * Dùng `node:sqlite` có sẵn trong Node 24 / Electron 45: không có module native nào phải đóng
 * gói (đã thử FTS5 chạy được cả bằng runtime Electron — xem ADR-0008).
 * Tách từ `unicode61 remove_diacritics 2`: "mau" khớp "màu".
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type * as NodeSqlite from 'node:sqlite';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { createRequire } from 'node:module';
import type { MemoryEntry, MemorySearchHit } from '@nsa/core';
import { foldText } from './markdown.js';

// Nạp lúc chạy để trình đóng gói (Vite/Rollup) không cố gộp `node:sqlite`.
const require = createRequire(import.meta.url);

function openDatabase(path: string): DatabaseSyncType {
  const { DatabaseSync } = require('node:sqlite') as typeof NodeSqlite;
  return new DatabaseSync(path);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
  id UNINDEXED, title, body, tags, branch UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

export class SearchIndex {
  readonly #db: DatabaseSyncType;

  private constructor(db: DatabaseSyncType) {
    this.#db = db;
  }

  /** `:memory:` cho test. */
  static open(path: string): SearchIndex {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = openDatabase(path);
    db.exec(SCHEMA);
    return new SearchIndex(db);
  }

  count(): number {
    const row = this.#db.prepare('SELECT count(*) AS c FROM entries').get() as { c: number };
    return Number(row.c);
  }

  /** Xoá sạch rồi nạp lại toàn bộ (dựng lại từ Markdown). */
  rebuild(entries: MemoryEntry[]): void {
    this.#db.exec('BEGIN');
    try {
      this.#db.exec('DELETE FROM entries; DELETE FROM entries_fts;');
      for (const entry of entries) this.#insert(entry);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  upsert(entry: MemoryEntry): void {
    this.remove(entry.id);
    this.#insert(entry);
  }

  remove(id: string): void {
    this.#db.prepare('DELETE FROM entries WHERE id = ?').run(id);
    this.#db.prepare('DELETE FROM entries_fts WHERE id = ?').run(id);
  }

  #insert(entry: MemoryEntry): void {
    this.#db
      .prepare('INSERT INTO entries (id, branch, data) VALUES (?, ?, ?)')
      .run(entry.id, entry.branch, JSON.stringify(entry));
    this.#db
      .prepare('INSERT INTO entries_fts (id, title, body, tags, branch) VALUES (?, ?, ?, ?, ?)')
      .run(entry.id, entry.title, entry.body, entry.tags.join(' '), entry.branch);
  }

  get(id: string): MemoryEntry | null {
    const row = this.#db.prepare('SELECT data FROM entries WHERE id = ?').get(id) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as MemoryEntry) : null;
  }

  all(): MemoryEntry[] {
    return (this.#db.prepare('SELECT data FROM entries').all() as { data: string }[]).map(
      (r) => JSON.parse(r.data) as MemoryEntry,
    );
  }

  /**
   * Tìm theo từ khoá. Câu hỏi tự nhiên ("màu yêu thích của tôi là gì?") được tách thành các
   * từ nối bằng OR, xếp theo bm25 — mục khớp nhiều từ hơn lên trước.
   */
  search(query: string, options: { limit?: number; branch?: string } = {}): MemorySearchHit[] {
    const match = toMatchQuery(query);
    if (!match) return [];
    const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
    const branchFilter = options.branch ? 'AND (f.branch = ? OR f.branch LIKE ?)' : '';
    const params: (string | number)[] = [match];
    if (options.branch) params.push(options.branch, `${options.branch}/%`);
    params.push(limit);
    const rows = this.#db
      .prepare(
        `SELECT e.data AS data, snippet(entries_fts, 2, '[', ']', '…', 16) AS snip
         FROM entries_fts f JOIN entries e ON e.id = f.id
         WHERE entries_fts MATCH ? ${branchFilter}
         ORDER BY bm25(entries_fts, 0, 4.0, 1.0, 2.0) LIMIT ?`,
      )
      .all(...params) as { data: string; snip: string }[];
    return rows.map((r) => ({ entry: JSON.parse(r.data) as MemoryEntry, snippet: r.snip }));
  }

  close(): void {
    this.#db.close();
  }
}

/** Từ quá phổ biến, khớp gần như mọi mục — bỏ khỏi truy vấn. */
const STOP = new Set(
  (
    'la cua va co khong the nao gi toi ban minh nay do thi ma cho voi duoc nhung cac mot nhu ' +
    'roi da se dang de khi neu vi tai tu den trong ra vao len xuong hay hoac a ah oi nhe ' +
    'the is a an of to in and or for on with what which who how be are was it this that me my'
  ).split(' '),
);

export function tokenize(text: string): string[] {
  return foldText(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

/** Truy vấn FTS5 an toàn: mỗi từ trong ngoặc kép, nối bằng OR. `null` nếu không còn từ nào. */
export function toMatchQuery(query: string): string | null {
  const terms = [...new Set(tokenize(query))].slice(0, 24);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"`).join(' OR ');
}
