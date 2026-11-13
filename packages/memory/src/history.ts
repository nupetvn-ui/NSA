/**
 * Lịch sử git cục bộ của kho nhớ (isomorphic-git — thuần JavaScript, máy người dùng không cần
 * cài git, đóng gói không có nhị phân gốc). Mỗi thay đổi là một commit; thông điệp commit
 * có các dòng `NSA-Op:` / `NSA-Entry:` / `NSA-Path:` để hoàn tác đúng file.
 */
import * as fs from 'node:fs';
import git from 'isomorphic-git';
import type { MemoryHistoryItem, MemoryOp } from '@nsa/core';

export interface CommitInfo {
  op: MemoryHistoryItem['op'];
  summary: string;
  entryId?: string;
  /** Đường dẫn tương đối (dấu `/`) của các file thay đổi trong commit. */
  paths: string[];
}

export interface Author {
  name: string;
  email: string;
}

export class GitHistory {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async init(): Promise<boolean> {
    if (fs.existsSync(`${this.#dir}/.git`)) return false;
    await git.init({ fs, dir: this.#dir, defaultBranch: 'main' });
    return true;
  }

  /** Ghi nhận các file đã thay đổi (thêm/sửa/xoá) thành một commit. */
  async commit(info: CommitInfo, author: Author): Promise<string> {
    for (const path of info.paths) {
      if (fs.existsSync(`${this.#dir}/${path}`)) {
        await git.add({ fs, dir: this.#dir, filepath: path });
      } else {
        await git.remove({ fs, dir: this.#dir, filepath: path });
      }
    }
    const trailers = [
      `NSA-Op: ${info.op}`,
      ...(info.entryId ? [`NSA-Entry: ${info.entryId}`] : []),
      ...info.paths.map((p) => `NSA-Path: ${p}`),
    ];
    return git.commit({
      fs,
      dir: this.#dir,
      message: `${info.summary}\n\n${trailers.join('\n')}\n`,
      author,
    });
  }

  /**
   * File đã đổi (hoặc mới) nhưng CHƯA có trong commit nào — dấu vết của lần ghi bị ngắt giữa chừng
   * (đã ghi file mà chưa kịp commit). Bỏ qua thư mục dữ liệu `.nsa/` và file tạm.
   */
  async uncommitted(): Promise<string[]> {
    const rows = await git.statusMatrix({ fs, dir: this.#dir });
    return rows
      .filter(([path, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1))
      .map(([path]) => String(path))
      .filter((p) => !p.startsWith('.nsa/') && !p.endsWith('.tmp') && p !== '.gitignore');
  }

  async log(
    depth = 200,
  ): Promise<(CommitInfo & { commit: string; at: string; parent?: string })[]> {
    let commits: Awaited<ReturnType<typeof git.log>>;
    try {
      commits = await git.log({ fs, dir: this.#dir, depth });
    } catch {
      return [];
    }
    return commits.map((c) => {
      const parsed = parseMessage(c.commit.message);
      return {
        ...parsed,
        commit: c.oid,
        at: new Date(c.commit.author.timestamp * 1000).toISOString(),
        ...(c.commit.parent[0] ? { parent: c.commit.parent[0] } : {}),
      };
    });
  }

  /** Nội dung một file ở một commit; `null` nếu file không có ở commit đó. */
  async read(commit: string, path: string): Promise<string | null> {
    try {
      const { blob } = await git.readBlob({ fs, dir: this.#dir, oid: commit, filepath: path });
      return Buffer.from(blob).toString('utf8');
    } catch {
      return null;
    }
  }
}

function parseMessage(message: string): CommitInfo {
  const lines = message.split('\n');
  const summary = lines[0] ?? '';
  let op: CommitInfo['op'] = 'init';
  let entryId: string | undefined;
  const paths: string[] = [];
  for (const line of lines) {
    const m = /^NSA-(Op|Entry|Path):\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const value = (m[2] ?? '').trim();
    if (m[1] === 'Op') op = value as MemoryOp;
    else if (m[1] === 'Entry') entryId = value;
    else paths.push(value);
  }
  return { op, summary, paths, ...(entryId ? { entryId } : {}) };
}
