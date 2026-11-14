/**
 * Chỉ mục Traces trong SQLite (`node:sqlite`, hướng G6). Chỉ là BẢN SAO dựng lại được từ các file
 * JSON Lines của nhật ký (`<audit>/YYYY-MM.jsonl`): xoá file chỉ mục thì lần sau dựng lại từ đầu.
 *
 * - Đọc tăng dần: nhớ vị trí byte đã đọc của từng file, lần sau chỉ đọc phần mới.
 * - Đọc theo khối + nhường luồng (`setImmediate`) giữa các lô để giao diện không bị treo khi file lớn.
 * - File nhật ký bị xoá / thu nhỏ (người dùng xoá lịch sử) → dựng lại toàn bộ.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type * as NodeSqlite from 'node:sqlite';
import type { DatabaseSync as Db } from 'node:sqlite';
import type {
  AuditEntry,
  TraceDetail,
  TraceFilters,
  TraceIndexStatus,
  TraceList,
  TraceQuery,
  TraceStep,
  TraceSummary,
} from '@nsa/core';
import { applyEntry, fold, newState, traceKeyOf, type Redact, type TraceState } from './build.js';

const require = createRequire(import.meta.url);

/** Đổi cách dựng lượt thì tăng số này: chỉ mục cũ tự bị dựng lại. */
export const TRACE_INDEX_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (name TEXT PRIMARY KEY, bytes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  started TEXT NOT NULL,
  day TEXT NOT NULL,
  status TEXT NOT NULL,
  team_task TEXT,
  summary TEXT NOT NULL,
  state TEXT NOT NULL,
  search TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS traces_started ON traces(started DESC);
CREATE INDEX IF NOT EXISTS traces_team ON traces(team_task);
CREATE TABLE IF NOT EXISTS trace_agents (trace_id TEXT NOT NULL, agent TEXT NOT NULL, PRIMARY KEY (trace_id, agent)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS trace_agents_agent ON trace_agents(agent);
CREATE TABLE IF NOT EXISTS trace_plugins (trace_id TEXT NOT NULL, plugin TEXT NOT NULL, PRIMARY KEY (trace_id, plugin)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS trace_plugins_plugin ON trace_plugins(plugin);
CREATE TABLE IF NOT EXISTS steps (trace_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (trace_id, seq)) WITHOUT ROWID;
`;

export interface TraceIndexOptions {
  /** Thư mục nhật ký (các file `YYYY-MM.jsonl`). */
  auditDir: string;
  /** File SQLite của chỉ mục. */
  dbPath: string;
  /** Bộ che key sẵn có; mọi chữ vào chỉ mục và mọi chữ trả về đều đi qua đây. */
  redact?: Redact;
  /** Chi phí ước tính cả tháng theo sổ chi phí (đọc khi hỏi trạng thái). */
  monthCostUsd?: () => number | null;
  /** Số dòng mỗi lô trước khi nhường luồng (test chỉnh nhỏ). */
  batchLines?: number;
}

export interface TraceIndex {
  /** Đọc phần nhật ký mới vào chỉ mục. Gọi chồng nhau thì dùng chung một lần chạy. */
  sync(): Promise<void>;
  list(query: TraceQuery): TraceList;
  get(id: string): TraceDetail | null;
  filters(): TraceFilters;
  status(): TraceIndexStatus;
  /** Xoá chỉ mục và dựng lại từ file nhật ký gốc. */
  reindex(): Promise<TraceIndexStatus>;
  close(): void;
}

const CHUNK_BYTES = 1 << 20;

export function createTraceIndex(options: TraceIndexOptions): TraceIndex {
  const redact: Redact = options.redact ?? ((t) => t);
  const batchLines = options.batchLines ?? 1_500;
  const db = open();
  let syncing: Promise<void> | null = null;
  let indexedLines = 0;

  function open(): Db {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    const tryOpen = (): Db => {
      const { DatabaseSync } = require('node:sqlite') as typeof NodeSqlite;
      const d = new DatabaseSync(options.dbPath);
      try {
        d.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
        d.exec(SCHEMA);
        const row = d.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
          { value: string } | undefined;
        if (row && row.value !== String(TRACE_INDEX_VERSION))
          throw new Error('phiên bản chỉ mục cũ');
        if (!row) {
          d.prepare("INSERT INTO meta (key, value) VALUES ('version', ?)").run(
            String(TRACE_INDEX_VERSION),
          );
        }
        return d;
      } catch (err) {
        d.close(); // Windows không xoá được file còn đang mở
        throw err;
      }
    };
    try {
      return tryOpen();
    } catch {
      // Chỉ mục hỏng hoặc phiên bản cũ: bỏ đi, dựng lại từ nhật ký gốc.
      for (const suffix of ['', '-wal', '-shm'])
        rmSync(`${options.dbPath}${suffix}`, { force: true });
      return tryOpen();
    }
  }

  function logFiles(): string[] {
    if (!existsSync(options.auditDir)) return [];
    return readdirSync(options.auditDir)
      .filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n))
      .sort();
  }

  /** Cần dựng lại từ đầu? (file đã index bị xoá hoặc nhỏ đi.) */
  function needsRebuild(): boolean {
    const rows = db.prepare('SELECT name, bytes FROM files').all() as {
      name: string;
      bytes: number;
    }[];
    for (const row of rows) {
      const path = join(options.auditDir, row.name);
      if (!existsSync(path) || statSync(path).size < row.bytes) return true;
    }
    return false;
  }

  function wipe(): void {
    db.exec(
      'DELETE FROM traces; DELETE FROM steps; DELETE FROM trace_agents; DELETE FROM trace_plugins; DELETE FROM files;',
    );
    indexedLines = 0;
  }

  const loadState = (id: string): TraceState | null => {
    const row = db.prepare('SELECT summary, state, search FROM traces WHERE id = ?').get(id) as
      { summary: string; state: string; search: string } | undefined;
    if (!row) return null;
    const st = JSON.parse(row.state) as { nextSeq: number; replied: boolean };
    return {
      summary: JSON.parse(row.summary) as TraceSummary,
      search: row.search,
      nextSeq: st.nextSeq,
      replied: st.replied,
    };
  };

  async function run(): Promise<void> {
    if (needsRebuild()) wipe();
    const files = logFiles();
    for (const name of files) {
      const path = join(options.auditDir, name);
      const known = db.prepare('SELECT bytes FROM files WHERE name = ?').get(name) as
        { bytes: number } | undefined;
      let offset = known?.bytes ?? 0;
      const size = statSync(path).size;
      if (size <= offset) continue;
      const fd = openSync(path, 'r');
      try {
        let carry = Buffer.alloc(0);
        while (offset + carry.length < size) {
          const buf = Buffer.alloc(Math.min(CHUNK_BYTES, size - offset - carry.length));
          const n = readSync(fd, buf, 0, buf.length, offset + carry.length);
          if (n === 0) break;
          const data = Buffer.concat([carry, buf.subarray(0, n)]);
          // Chỉ xử lý tới dòng trọn vẹn cuối cùng (dòng đang ghi dở để lần sau).
          const lastNl = data.lastIndexOf(0x0a);
          if (lastNl === -1) {
            carry = data;
            continue;
          }
          const complete = data.subarray(0, lastNl + 1);
          carry = data.subarray(lastNl + 1);
          await ingest(name, offset, complete);
          offset += complete.length;
          db.prepare(
            'INSERT INTO files (name, bytes) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET bytes = excluded.bytes',
          ).run(name, offset);
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } finally {
        closeSync(fd);
      }
    }
  }

  /** Đưa các dòng của một khối (đã trọn vẹn) vào chỉ mục, theo lô. */
  async function ingest(file: string, baseOffset: number, complete: Buffer): Promise<void> {
    let pos = 0;
    let lineCount = 0;
    const cache = new Map<string, { state: TraceState; fresh: TraceStep[]; kind: string }>();
    const flush = (): void => {
      db.exec('BEGIN');
      try {
        for (const [id, item] of cache) writeTrace(id, item.state, item.fresh);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      cache.clear();
    };
    while (pos < complete.length) {
      const nl = complete.indexOf(0x0a, pos);
      const end = nl === -1 ? complete.length : nl;
      const lineOffset = baseOffset + pos;
      const line = complete.toString('utf8', pos, end).trim();
      pos = end + 1;
      if (!line) continue;
      let entry: AuditEntry;
      try {
        entry = JSON.parse(line) as AuditEntry;
      } catch {
        continue; // dòng hỏng: bỏ qua, không làm hỏng cả chỉ mục
      }
      if (!entry || typeof entry.at !== 'string' || typeof entry.type !== 'string') continue;
      indexedLines++;
      const key = traceKeyOf(entry, () => `e:${file}:${lineOffset}`);
      if (!key) continue;
      let item = cache.get(key.id);
      if (!item) {
        const existing = loadState(key.id);
        item = {
          state: existing ?? newState(key.id, key.kind, entry),
          fresh: [],
          kind: key.kind,
        };
        cache.set(key.id, item);
      }
      item.fresh.push(...applyEntry(item.state, entry, redact));
      if (++lineCount % batchLines === 0) {
        flush();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    flush();
  }

  function writeTrace(id: string, state: TraceState, fresh: TraceStep[]): void {
    const s = state.summary;
    db.prepare(
      `INSERT INTO traces (id, kind, started, day, status, team_task, summary, state, search)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, started = excluded.started, day = excluded.day,
         status = excluded.status, team_task = excluded.team_task, summary = excluded.summary,
         state = excluded.state, search = excluded.search`,
    ).run(
      id,
      s.kind,
      s.startedAt,
      s.startedAt.slice(0, 10),
      s.status,
      s.teamTaskId ?? null,
      JSON.stringify(s),
      JSON.stringify({ nextSeq: state.nextSeq, replied: state.replied }),
      state.search,
    );
    const insStep = db.prepare(
      'INSERT OR REPLACE INTO steps (trace_id, seq, data) VALUES (?, ?, ?)',
    );
    for (const step of fresh) insStep.run(id, step.seq, JSON.stringify(step));
    const insAgent = db.prepare(
      'INSERT OR IGNORE INTO trace_agents (trace_id, agent) VALUES (?, ?)',
    );
    for (const agent of s.agentIds) insAgent.run(id, agent);
    const insPlugin = db.prepare(
      'INSERT OR IGNORE INTO trace_plugins (trace_id, plugin) VALUES (?, ?)',
    );
    for (const plugin of s.pluginIds) insPlugin.run(id, plugin);
  }

  const clean = (s: TraceSummary): TraceSummary => ({ ...s, title: redact(s.title) });

  return {
    sync() {
      syncing ??= run().finally(() => {
        syncing = null;
      });
      return syncing;
    },
    list(query) {
      const where: string[] = [];
      const args: (string | number)[] = [];
      const cond = (sql: string, value: string): void => {
        where.push(sql);
        args.push(value);
      };
      if (query.from) cond('t.day >= ?', query.from);
      if (query.to) cond('t.day <= ?', query.to);
      if (query.status) cond('t.status = ?', query.status);
      if (query.kind) cond('t.kind = ?', query.kind);
      if (query.teamTaskId) cond('t.team_task = ?', query.teamTaskId);
      if (query.agentId) {
        where.push('EXISTS (SELECT 1 FROM trace_agents a WHERE a.trace_id = t.id AND a.agent = ?)');
        args.push(query.agentId);
      }
      if (query.pluginId) {
        where.push(
          'EXISTS (SELECT 1 FROM trace_plugins p WHERE p.trace_id = t.id AND p.plugin = ?)',
        );
        args.push(query.pluginId);
      }
      const text = query.text?.trim();
      if (text) cond('instr(t.search, ?) > 0', fold(text));
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = (
        db.prepare(`SELECT COUNT(*) AS n FROM traces t ${clause}`).get(...args) as { n: number }
      ).n;
      const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
      const rows = db
        .prepare(
          `SELECT t.summary FROM traces t ${clause} ORDER BY t.started DESC LIMIT ? OFFSET ?`,
        )
        .all(...args, limit, Math.max(query.offset ?? 0, 0)) as { summary: string }[];
      return { items: rows.map((r) => clean(JSON.parse(r.summary) as TraceSummary)), total };
    },
    get(id) {
      const row = db.prepare('SELECT summary FROM traces WHERE id = ?').get(id) as
        { summary: string } | undefined;
      if (!row) return null;
      const steps = (
        db.prepare('SELECT data FROM steps WHERE trace_id = ? ORDER BY seq').all(id) as {
          data: string;
        }[]
      ).map((r) => {
        const step = JSON.parse(r.data) as TraceStep;
        return {
          ...step,
          title: redact(step.title),
          ...(step.detail ? { detail: redact(step.detail) } : {}),
        };
      });
      return { ...clean(JSON.parse(row.summary) as TraceSummary), steps };
    },
    filters() {
      const col = (sql: string): string[] =>
        (db.prepare(sql).all() as { v: string }[]).map((r) => r.v);
      return {
        agents: col('SELECT DISTINCT agent AS v FROM trace_agents ORDER BY agent'),
        plugins: col('SELECT DISTINCT plugin AS v FROM trace_plugins ORDER BY plugin'),
      };
    },
    status() {
      const n = (db.prepare('SELECT COUNT(*) AS n FROM traces').get() as { n: number }).n;
      const monthCostUsd = ((): number | null => {
        try {
          return options.monthCostUsd?.() ?? null;
        } catch {
          return null;
        }
      })();
      return {
        state: syncing ? 'indexing' : 'idle',
        indexedLines,
        traces: n,
        monthCostUsd,
      };
    },
    async reindex() {
      if (syncing) await syncing.catch(() => undefined);
      wipe();
      await this.sync();
      return this.status();
    },
    close() {
      try {
        db.close();
      } catch {
        // đã đóng
      }
    },
  };
}
