/**
 * Nhập lịch sử chat để chắt lọc thành đề xuất ghi nhớ. Chỉ chạy khi người dùng bấm, có xem trước.
 *
 * Định dạng đã xác minh trên máy thật (2026-11-12, xem ADR-0008):
 * - NSA: `conversations.json` của chính app.
 * - Claude Code 2.1.x: `~/.claude/projects/<thư mục>/<mã phiên>.jsonl`, dòng `type: user|assistant`,
 *   `message.content` là chuỗi hoặc mảng khối `{type:'text'}`.
 * - Codex 0.167: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, dòng `type: session_meta` và
 *   `type: response_item` với `payload.type: message`, `payload.role: user|assistant`.
 * - OpenCode 1.19: SQLite `~/.local/share/opencode/opencode.db`, bảng `session` / `message` / `part`
 *   (cột `data` là JSON). Bản OpenCode cũ lưu file JSON trong `storage/` — chưa hỗ trợ.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type * as NodeSqlite from 'node:sqlite';
import type { Conversation, ImportCandidate, ImportSource, ImportSourceStatus } from '@nsa/core';
import { conversationTranscript, type Transcript } from './distill.js';

const require = createRequire(import.meta.url);

export interface ImportOptions {
  /** Thư mục người dùng (đổi được để test). */
  home?: string;
  /** Cuộc trò chuyện NSA đã lưu. */
  conversations?: () => Conversation[];
  /** Số phiên tối đa liệt kê mỗi nguồn. */
  limit?: number;
}

type Message = Transcript['messages'][number];

interface Loaded {
  candidate: ImportCandidate;
  transcript: () => Transcript;
}

const PREVIEW = 4;

function preview(messages: Message[]): ImportCandidate['preview'] {
  return messages
    .slice(0, PREVIEW)
    .map((m) => ({ role: m.role, text: m.text.replace(/\s+/g, ' ').slice(0, 220) }));
}

function title(messages: Message[], fallback: string): string {
  const first = messages
    .find((m) => m.role === 'user')
    ?.text.replace(/\s+/g, ' ')
    .trim();
  if (!first) return fallback;
  return first.length > 70 ? `${first.slice(0, 67)}…` : first;
}

/** Văn bản do CLI tự chèn (nhắc hệ thống, ngữ cảnh môi trường…), không phải người dùng gõ. */
function isInjected(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith('<') ||
    t.startsWith('# AGENTS.md') ||
    t.startsWith('Caveat:') ||
    t.startsWith('[Request interrupted')
  );
}

function readJsonLines(file: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // dòng hỏng / đang ghi dở
    }
  }
  return out;
}

function recentFiles(dir: string, match: (name: string) => boolean, limit: number): string[] {
  const files: { path: string; mtime: number }[] = [];
  const walk = (d: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(d, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 4) walk(full, depth + 1);
      } else if (match(name)) {
        files.push({ path: full, mtime: st.mtimeMs });
      }
    }
  };
  walk(dir, 0);
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((f) => f.path);
}

// ------------------------------------------------------------ Claude Code

export function parseClaudeSession(lines: Record<string, unknown>[]): {
  messages: Message[];
  cwd?: string;
  updatedAt?: string;
} {
  const messages: Message[] = [];
  let cwd: string | undefined;
  let updatedAt: string | undefined;
  for (const line of lines) {
    if (typeof line['cwd'] === 'string') cwd ??= line['cwd'];
    if (typeof line['timestamp'] === 'string') updatedAt = line['timestamp'];
    const type = line['type'];
    if ((type !== 'user' && type !== 'assistant') || line['isSidechain'] === true) continue;
    if (line['isMeta'] === true) continue;
    const content = (line['message'] as { content?: unknown } | undefined)?.content;
    const texts =
      typeof content === 'string'
        ? [content]
        : Array.isArray(content)
          ? content
              .filter(
                (c): c is { type: 'text'; text: string } =>
                  c?.type === 'text' && typeof c.text === 'string',
              )
              .map((c) => c.text)
          : [];
    const text = texts.join('\n').trim();
    if (!text || (type === 'user' && isInjected(text))) continue;
    const last = messages.at(-1);
    // Claude ghi mỗi khối của một câu trả lời thành một dòng — gộp lại.
    if (last && last.role === type && type === 'assistant') last.text += `\n${text}`;
    else messages.push({ role: type, text });
  }
  return { messages, ...(cwd ? { cwd } : {}), ...(updatedAt ? { updatedAt } : {}) };
}

function claudeSessions(home: string, limit: number): Loaded[] | string {
  const dir = join(home, '.claude', 'projects');
  if (!existsSync(dir))
    return 'Không thấy ~/.claude/projects (chưa dùng Claude Code trên máy này).';
  return recentFiles(dir, (n) => n.endsWith('.jsonl'), limit).flatMap((file): Loaded[] => {
    const parsed = parseClaudeSession(readJsonLines(file));
    if (!parsed.messages.some((m) => m.role === 'user')) return [];
    const id =
      file
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.jsonl$/, '') ?? file;
    const candidate: ImportCandidate = {
      source: 'claude',
      id,
      title: title(parsed.messages, id),
      ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
      updatedAt: parsed.updatedAt ?? new Date(statSync(file).mtimeMs).toISOString(),
      messages: parsed.messages.length,
      preview: preview(parsed.messages),
    };
    return [
      {
        candidate,
        transcript: () => ({
          title: candidate.title,
          ref: `claude:${id}`,
          messages: parsed.messages,
        }),
      },
    ];
  });
}

// ------------------------------------------------------------ Codex

export function parseCodexSession(lines: Record<string, unknown>[]): {
  messages: Message[];
  id?: string;
  cwd?: string;
  updatedAt?: string;
} {
  const messages: Message[] = [];
  let id: string | undefined;
  let cwd: string | undefined;
  let updatedAt: string | undefined;
  for (const line of lines) {
    if (typeof line['timestamp'] === 'string') updatedAt = line['timestamp'];
    const payload = line['payload'] as Record<string, unknown> | undefined;
    if (!payload) continue;
    if (line['type'] === 'session_meta') {
      if (typeof payload['id'] === 'string') id = payload['id'];
      if (typeof payload['cwd'] === 'string') cwd = payload['cwd'];
      continue;
    }
    if (line['type'] !== 'response_item' || payload['type'] !== 'message') continue;
    const role = payload['role'];
    if (role !== 'user' && role !== 'assistant') continue;
    const content = Array.isArray(payload['content']) ? payload['content'] : [];
    const text = content
      .filter((c): c is { text: string } => typeof (c as { text?: unknown })?.text === 'string')
      .map((c) => c.text)
      .join('\n')
      .trim();
    if (!text || (role === 'user' && isInjected(text))) continue;
    messages.push({ role, text });
  }
  return {
    messages,
    ...(id ? { id } : {}),
    ...(cwd ? { cwd } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function codexSessions(home: string, limit: number): Loaded[] | string {
  const dir = join(home, '.codex', 'sessions');
  if (!existsSync(dir)) return 'Không thấy ~/.codex/sessions (chưa dùng Codex trên máy này).';
  return recentFiles(dir, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'), limit).flatMap(
    (file): Loaded[] => {
      const parsed = parseCodexSession(readJsonLines(file));
      if (!parsed.messages.some((m) => m.role === 'user')) return [];
      const id = parsed.id ?? file.split(/[\\/]/).pop() ?? file;
      const candidate: ImportCandidate = {
        source: 'codex',
        id,
        title: title(parsed.messages, id),
        ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
        updatedAt: parsed.updatedAt ?? new Date(statSync(file).mtimeMs).toISOString(),
        messages: parsed.messages.length,
        preview: preview(parsed.messages),
      };
      return [
        {
          candidate,
          transcript: () => ({
            title: candidate.title,
            ref: `codex:${id}`,
            messages: parsed.messages,
          }),
        },
      ];
    },
  );
}

// ------------------------------------------------------------ OpenCode

function openCodeDb(home: string): string {
  const xdg = process.env['XDG_DATA_HOME'];
  const base = xdg && home === homedir() ? xdg : join(home, '.local', 'share');
  return join(base, 'opencode', 'opencode.db');
}

function openCodeSessions(home: string, limit: number): Loaded[] | string {
  const file = openCodeDb(home);
  if (!existsSync(file)) {
    return 'Không thấy opencode.db (chưa dùng OpenCode, hoặc bản OpenCode cũ lưu file JSON — chưa hỗ trợ).';
  }
  const { DatabaseSync } = require('node:sqlite') as typeof NodeSqlite;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const sessions = db
      .prepare(
        'SELECT id, title, directory, time_updated FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT ?',
      )
      .all(limit) as { id: string; title: string; directory: string; time_updated: number }[];
    const rows = db
      .prepare(
        `SELECT p.session_id AS sid, m.data AS mdata, p.data AS pdata
         FROM part p JOIN message m ON m.id = p.message_id
         WHERE p.session_id IN (${sessions.map(() => '?').join(',') || "''"})
         ORDER BY m.time_created, p.time_created`,
      )
      .all(...sessions.map((s) => s.id)) as { sid: string; mdata: string; pdata: string }[];
    const bySession = new Map<string, Message[]>();
    for (const row of rows) {
      let role: unknown;
      let part: { type?: unknown; text?: unknown; synthetic?: unknown };
      try {
        role = (JSON.parse(row.mdata) as { role?: unknown }).role;
        part = JSON.parse(row.pdata) as typeof part;
      } catch {
        continue;
      }
      if ((role !== 'user' && role !== 'assistant') || part.type !== 'text') continue;
      if (part.synthetic === true || typeof part.text !== 'string' || !part.text.trim()) continue;
      const list = bySession.get(row.sid) ?? [];
      const last = list.at(-1);
      if (last && last.role === role) last.text += `\n${part.text.trim()}`;
      else list.push({ role, text: part.text.trim() });
      bySession.set(row.sid, list);
    }
    return sessions.flatMap((s): Loaded[] => {
      const messages = bySession.get(s.id) ?? [];
      if (!messages.some((m) => m.role === 'user')) return [];
      const candidate: ImportCandidate = {
        source: 'opencode',
        id: s.id,
        title: s.title || title(messages, s.id),
        cwd: s.directory,
        updatedAt: new Date(s.time_updated).toISOString(),
        messages: messages.length,
        preview: preview(messages),
      };
      return [
        {
          candidate,
          transcript: () => ({ title: candidate.title, ref: `opencode:${s.id}`, messages }),
        },
      ];
    });
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------ NSA

function nsaSessions(conversations: Conversation[]): Loaded[] {
  return conversations
    .filter((c) => c.turns.length > 0)
    .map((c) => {
      const transcript = conversationTranscript(c);
      return {
        candidate: {
          source: 'nsa' as const,
          id: c.id,
          title: c.title,
          cwd: c.cwd,
          updatedAt: c.updatedAt,
          messages: transcript.messages.length,
          preview: preview(transcript.messages),
        },
        transcript: () => transcript,
      };
    });
}

const NAMES: Record<ImportSource, string> = {
  nsa: 'NSA',
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

export class ChatHistoryImporter {
  readonly #home: string;
  readonly #conversations: () => Conversation[];
  readonly #limit: number;

  constructor(options: ImportOptions = {}) {
    this.#home = options.home ?? homedir();
    this.#conversations = options.conversations ?? (() => []);
    this.#limit = options.limit ?? 60;
  }

  #load(source: ImportSource): Loaded[] | string {
    try {
      switch (source) {
        case 'nsa':
          return nsaSessions(this.#conversations());
        case 'claude':
          return claudeSessions(this.#home, this.#limit);
        case 'codex':
          return codexSessions(this.#home, this.#limit);
        case 'opencode':
          return openCodeSessions(this.#home, this.#limit);
      }
    } catch (err) {
      return `Không đọc được: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  sources(): ImportSourceStatus[] {
    return (Object.keys(NAMES) as ImportSource[]).map((source) => {
      const loaded = this.#load(source);
      return typeof loaded === 'string'
        ? { source, name: NAMES[source], available: false, note: loaded, count: 0 }
        : {
            source,
            name: NAMES[source],
            available: true,
            note: loaded.length ? `${loaded.length} phiên gần nhất` : 'Không có phiên nào',
            count: loaded.length,
          };
    });
  }

  /** Danh sách phiên để người dùng xem trước và chọn. */
  list(source: ImportSource): ImportCandidate[] {
    const loaded = this.#load(source);
    return typeof loaded === 'string' ? [] : loaded.map((l) => l.candidate);
  }

  transcript(source: ImportSource, id: string): Transcript {
    const loaded = this.#load(source);
    if (typeof loaded === 'string') throw new Error(loaded);
    const found = loaded.find((l) => l.candidate.id === id);
    if (!found) throw new Error('Không tìm thấy phiên này');
    return found.transcript();
  }
}
