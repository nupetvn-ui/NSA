/**
 * NSA Mem — dịch vụ bộ nhớ thuần (không phụ thuộc Electron).
 *
 * - Bản gốc: cây thư mục Markdown trong `root` (mỗi nhánh một thư mục có `_branch.md`, mỗi
 *   mục nhớ một file `<mã>.md`), có lịch sử git cục bộ để hoàn tác từng thay đổi.
 * - Chỉ mục: SQLite FTS5 trong `root/.nsa/index.sqlite` — xoá đi thì dựng lại từ Markdown.
 * - Hộp duyệt: `root/.nsa/inbox.json`.
 * - Mọi thao tác ghi / sửa / xoá / hoàn tác đều hỏi ổ cắm `Policy` trước và ghi `AuditLog`.
 * - Ổ cắm chủ sở hữu + phạm vi (`MemoryAccess`) quyết định ai đọc / sửa được mục nào.
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  personalMemoryAccess,
  type AuditEntry,
  type AuditLog,
  type Identity,
  type IdentityProvider,
  type MemoryAccess,
  type MemoryBranch,
  type MemoryContext,
  type MemoryDraft,
  type MemoryEntry,
  type MemoryHistoryItem,
  type MemoryKind,
  type MemoryOp,
  type MemoryProposal,
  type MemorySearchHit,
  type Policy,
  type PolicyAction,
  type PolicyDecision,
} from '@nsa/core';
import { GitHistory, type Author } from './history.js';
import {
  branchFromMarkdown,
  branchToMarkdown,
  entryFromMarkdown,
  entryToMarkdown,
  slugify,
  type BranchMeta,
} from './markdown.js';
import type { McpCallContext, McpTool } from './mcp-server.js';
import { findConflicts, judgeProposal } from './review.js';
import { SearchIndex } from './search-index.js';
import { noVectorIndex, type VectorIndex } from './vector.js';

export interface MemoryServiceOptions {
  /** Thư mục kho nhớ (thư mục dữ liệu người dùng của app, KHÔNG nằm trong repo). */
  root: string;
  identity: IdentityProvider;
  policy: Policy;
  audit?: AuditLog;
  /** Ổ cắm chủ sở hữu + phạm vi — mặc định bản Cá nhân. */
  access?: MemoryAccess;
  vector?: VectorIndex;
  /** Báo giao diện khi bộ nhớ / hộp duyệt thay đổi. */
  onChange?: () => void;
  now?: () => Date;
}

/** Nhánh có sẵn khi tạo kho mới. */
export const DEFAULT_BRANCHES: (BranchMeta & { path: string })[] = [
  {
    path: 'nguoi-dung',
    title: 'Về người dùng',
    description: 'Thông tin, sở thích, thói quen làm việc của người dùng.',
    autoApprove: true,
    minConfidence: 0.8,
    hidden: false,
  },
  {
    path: 'du-an',
    title: 'Dự án',
    description: 'Kiến thức về các dự án: công nghệ, quy ước, quyết định đã chốt.',
    autoApprove: true,
    minConfidence: 0.85,
    hidden: false,
  },
  {
    path: 'quy-tac',
    title: 'Quy tắc cho agent',
    description: 'Agent phải làm / không được làm gì. Luôn cần người duyệt.',
    autoApprove: false,
    minConfidence: 1,
    hidden: false,
  },
  {
    path: 'chung',
    title: 'Kiến thức chung',
    description: 'Những điều khác đáng nhớ.',
    autoApprove: true,
    minConfidence: 0.85,
    hidden: false,
  },
];

const BRANCH_FILE = '_branch.md';
const DATA_DIR = '.nsa';
const BRANCH_PATH = /^[a-z0-9][a-z0-9-]{0,47}(\/[a-z0-9][a-z0-9-]{0,47}){0,5}$/;
const ENTRY_ID = /^m-[a-z0-9-]{4,40}$/;

type By = 'user' | 'auto';

export class MemoryService {
  readonly root: string;
  readonly #identity: IdentityProvider;
  readonly #policy: Policy;
  readonly #audit: AuditLog | undefined;
  readonly #access: MemoryAccess;
  readonly #vector: VectorIndex;
  readonly #onChange: () => void;
  readonly #now: () => Date;
  readonly #git: GitHistory;
  #index: SearchIndex;
  #proposals: MemoryProposal[];
  /** Ghi tuần tự — git và file không được ghi chồng. */
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(options: MemoryServiceOptions, index: SearchIndex) {
    this.root = options.root;
    this.#identity = options.identity;
    this.#policy = options.policy;
    this.#audit = options.audit;
    this.#access = options.access ?? personalMemoryAccess();
    this.#vector = options.vector ?? noVectorIndex;
    this.#onChange = options.onChange ?? (() => undefined);
    this.#now = options.now ?? (() => new Date());
    this.#git = new GitHistory(options.root);
    this.#index = index;
    this.#proposals = this.#loadProposals();
  }

  static async open(options: MemoryServiceOptions): Promise<MemoryService> {
    mkdirSync(join(options.root, DATA_DIR), { recursive: true });
    const indexPath = join(options.root, DATA_DIR, 'index.sqlite');
    const indexExisted = existsSync(indexPath);
    const service = new MemoryService(options, SearchIndex.open(indexPath));
    await service.#ensureRepo();
    // Chỉ mục mất / trống mà Markdown có dữ liệu → dựng lại.
    if (!indexExisted || service.#index.count() !== service.#scanEntries().length) {
      await service.rebuildIndex({ audit: indexExisted });
    }
    return service;
  }

  get vectorAvailable(): boolean {
    return this.#vector.available;
  }

  async #ensureRepo(): Promise<void> {
    const created = await this.#git.init();
    const gitignore = join(this.root, '.gitignore');
    if (!existsSync(gitignore)) writeFileSync(gitignore, `/${DATA_DIR}/\n`, 'utf8');
    if (!created) return;
    const paths = ['.gitignore'];
    for (const branch of DEFAULT_BRANCHES) {
      const file = join(this.root, branch.path, BRANCH_FILE);
      if (!existsSync(file)) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, branchToMarkdown(branch), 'utf8');
      }
      paths.push(`${branch.path}/${BRANCH_FILE}`);
    }
    await this.#git.commit({ op: 'init', summary: 'Tạo kho nhớ NSA', paths }, this.#author());
  }

  #author(): Author {
    const actor = this.#identity.current();
    return { name: actor.displayName, email: `${actor.id.replace(/[^\w.-]/g, '_')}@nsa.local` };
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  // ------------------------------------------------------------ Đọc

  /** Quét toàn bộ file Markdown (bản gốc). */
  #scanEntries(): MemoryEntry[] {
    const entries: MemoryEntry[] = [];
    const walk = (dir: string, branch: string): void => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (name.startsWith('.')) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full, branch ? `${branch}/${name}` : name);
        } else if (branch && name.endsWith('.md') && name !== BRANCH_FILE) {
          try {
            entries.push(entryFromMarkdown(readFileSync(full, 'utf8'), branch, name.slice(0, -3)));
          } catch (err) {
            console.error(`[memory] bỏ qua file hỏng ${full}:`, err);
          }
        }
      }
    };
    walk(this.root, '');
    return entries;
  }

  listBranches(): MemoryBranch[] {
    const counts = new Map<string, number>();
    for (const entry of this.#readable()) {
      counts.set(entry.branch, (counts.get(entry.branch) ?? 0) + 1);
    }
    const branches: MemoryBranch[] = [];
    const walk = (dir: string, path: string): void => {
      for (const name of readdirSync(dir)) {
        if (name.startsWith('.')) continue;
        const full = join(dir, name);
        if (!statSync(full).isDirectory()) continue;
        const branchPath = path ? `${path}/${name}` : name;
        const metaFile = join(full, BRANCH_FILE);
        const meta = existsSync(metaFile)
          ? branchFromMarkdown(readFileSync(metaFile, 'utf8'), branchPath)
          : branchFromMarkdown('', branchPath);
        branches.push({ ...meta, path: branchPath, count: counts.get(branchPath) ?? 0 });
        walk(full, branchPath);
      }
    };
    walk(this.root, '');
    return branches.sort((a, b) => a.path.localeCompare(b.path));
  }

  #branch(path: string): MemoryBranch | undefined {
    return this.listBranches().find((b) => b.path === path);
  }

  #readable(): MemoryEntry[] {
    const actor = this.#identity.current();
    return this.#index.all().filter((e) => this.#access.canRead(actor, e));
  }

  listEntries(branch?: string): MemoryEntry[] {
    return this.#readable()
      .filter((e) => !branch || e.branch === branch || e.branch.startsWith(`${branch}/`))
      .sort((a, b) => b.updated.localeCompare(a.updated));
  }

  get(id: string): MemoryEntry | null {
    const entry = this.#index.get(id);
    if (!entry || !this.#access.canRead(this.#identity.current(), entry)) return null;
    return entry;
  }

  search(query: string, options: { limit?: number; branch?: string } = {}): MemorySearchHit[] {
    const actor = this.#identity.current();
    return this.#index.search(query, options).filter((h) => this.#access.canRead(actor, h.entry));
  }

  // ------------------------------------------------------------ Chính sách + nhật ký

  async #check(action: PolicyAction): Promise<PolicyDecision> {
    try {
      return await this.#policy.check({
        actor: this.#identity.current(),
        action,
        confirmed: false,
      });
    } catch (err) {
      return { decision: 'deny', reason: `Lỗi khi kiểm chính sách: ${String(err)}` };
    }
  }

  #log(
    body: Omit<Extract<AuditEntry, { type: 'memory' }>, 'at' | 'actor' | 'type' | 'agentId'> & {
      agentId?: string;
    },
  ): void {
    if (!this.#audit) return;
    const actor = this.#identity.current();
    try {
      this.#audit.record({
        ...body,
        type: 'memory',
        agentId: body.agentId ?? (body.by === 'agent' ? 'agent' : 'nsa-mem'),
        at: this.#now().toISOString(),
        actor: { id: actor.id, displayName: actor.displayName },
      } as AuditEntry);
    } catch (err) {
      console.error('[memory] không ghi được nhật ký:', err);
    }
  }

  /** Hỏi chính sách cho một thay đổi; bị chặn thì ghi nhật ký và ném lỗi. */
  async #authorize(
    op: MemoryOp,
    by: By,
    target: { branch: string; title: string; id?: string; kind?: MemoryKind; sensitive?: boolean },
    kind: 'entry' | 'branch' = 'entry',
  ): Promise<void> {
    const verdict = await this.#check({
      kind: 'memory.write',
      op,
      target: kind,
      by,
      branch: target.branch,
      title: target.title,
      memoryKind: target.kind ?? 'fact',
      sensitive: target.sensitive ?? false,
      ...(target.id ? { entryId: target.id } : {}),
    });
    if (verdict.decision !== 'allow') {
      const reason =
        verdict.decision === 'ask'
          ? `Chính sách yêu cầu xác nhận: ${verdict.reason}`
          : verdict.reason;
      this.#log({
        op,
        by,
        branch: target.branch,
        title: target.title,
        ...(target.id ? { entryId: target.id } : {}),
        decision: verdict.decision,
        reason,
      });
      throw new Error(`Chính sách không cho phép: ${reason}`);
    }
  }

  #assertWritable(entry: MemoryEntry): void {
    if (!this.#access.canWrite(this.#identity.current(), entry)) {
      throw new Error('Bạn không có quyền sửa mục nhớ này');
    }
  }

  // ------------------------------------------------------------ Ghi

  #newEntryId(): string {
    const day = this.#now().toISOString().slice(0, 10).replace(/-/g, '');
    return `m-${day}-${randomBytes(4).toString('hex')}`;
  }

  #entryPath(entry: Pick<MemoryEntry, 'branch' | 'id'>): string {
    return `${entry.branch}/${entry.id}.md`;
  }

  #writeFile(relative: string, content: string | null): void {
    const full = join(this.root, relative);
    if (content === null) {
      rmSync(full, { force: true });
      return;
    }
    mkdirSync(dirname(full), { recursive: true });
    const tmp = `${full}.tmp`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, full);
  }

  #validateDraft(draft: MemoryDraft): MemoryDraft {
    const title = draft.title.replace(/\s+/g, ' ').trim().slice(0, 160);
    const body = draft.body.trim();
    if (!title && !body) throw new Error('Mục nhớ trống');
    if (!BRANCH_PATH.test(draft.branch)) throw new Error(`Tên nhánh không hợp lệ: ${draft.branch}`);
    return {
      ...draft,
      title: title || body.split('\n')[0]?.slice(0, 80) || 'Không tiêu đề',
      body: body || title,
      confidence: Math.min(
        1,
        Math.max(0, Number.isFinite(draft.confidence) ? draft.confidence : 0.5),
      ),
      ...(draft.subject ? { subject: slugify(draft.subject) } : {}),
    };
  }

  /** Tạo hoặc sửa một mục (sau khi đã qua hộp duyệt hoặc do người dùng tự viết). */
  async #save(draft: MemoryDraft, by: By, targetId?: string): Promise<MemoryEntry> {
    const clean = this.#validateDraft(draft);
    if (!this.#branch(clean.branch)) throw new Error(`Chưa có nhánh "${clean.branch}"`);
    const existing = targetId ? this.#index.get(targetId) : null;
    if (targetId && !existing) throw new Error('Không tìm thấy mục nhớ');
    if (existing) this.#assertWritable(existing);
    const op: MemoryOp = existing ? 'update' : 'create';
    await this.#authorize(op, by, {
      branch: clean.branch,
      title: clean.title,
      kind: clean.kind,
      sensitive: clean.sensitive ?? false,
      ...(existing ? { id: existing.id } : {}),
    });

    const now = this.#now().toISOString();
    const actor = this.#identity.current();
    const ownership = existing
      ? {
          owner: existing.owner,
          scope: existing.scope,
          ...(existing.team ? { team: existing.team } : {}),
        }
      : this.#access.ownershipFor(actor, clean.branch);
    const entry: MemoryEntry = {
      id: existing?.id ?? this.#newEntryId(),
      branch: clean.branch,
      title: clean.title,
      body: clean.body,
      kind: clean.kind,
      ...(clean.subject ? { subject: clean.subject } : {}),
      confidence: clean.confidence,
      sensitive: clean.sensitive ?? false,
      source:
        existing && by === 'user' && clean.source.kind === 'manual'
          ? existing.source
          : clean.source,
      tags: clean.tags ?? existing?.tags ?? [],
      created: existing?.created ?? now,
      updated: now,
      ...ownership,
    };
    const paths = [this.#entryPath(entry)];
    if (existing && existing.branch !== entry.branch) {
      paths.push(this.#entryPath(existing));
      this.#writeFile(this.#entryPath(existing), null);
    }
    this.#writeFile(this.#entryPath(entry), entryToMarkdown(entry));
    await this.#git.commit(
      {
        op,
        summary: `${op === 'create' ? 'Thêm' : 'Sửa'}: ${entry.title}`,
        entryId: entry.id,
        paths,
      },
      this.#author(),
    );
    this.#index.upsert(entry);
    await this.#vector.upsert(entry).catch(() => undefined);
    this.#log({
      op,
      by,
      branch: entry.branch,
      entryId: entry.id,
      title: entry.title,
      decision: 'allow',
    });
    return entry;
  }

  /** Người dùng dạy trực tiếp bằng văn bản (màn hình Bộ nhớ) — người dùng chính là người duyệt. */
  teach(
    draft: Omit<MemoryDraft, 'source' | 'confidence'> & { confidence?: number },
  ): Promise<MemoryEntry> {
    return this.#serial(async () => {
      const entry = await this.#save(
        { ...draft, confidence: draft.confidence ?? 1, source: { kind: 'manual' } },
        'user',
      );
      this.#onChange();
      return entry;
    });
  }

  update(id: string, patch: Partial<Omit<MemoryDraft, 'source'>>): Promise<MemoryEntry> {
    return this.#serial(async () => {
      const existing = this.#index.get(id);
      if (!existing) throw new Error('Không tìm thấy mục nhớ');
      const entry = await this.#save(
        {
          branch: patch.branch ?? existing.branch,
          title: patch.title ?? existing.title,
          body: patch.body ?? existing.body,
          kind: patch.kind ?? existing.kind,
          confidence: patch.confidence ?? existing.confidence,
          sensitive: patch.sensitive ?? existing.sensitive,
          tags: patch.tags ?? existing.tags,
          ...((patch.subject ?? existing.subject)
            ? { subject: patch.subject ?? existing.subject }
            : {}),
          source: { kind: 'manual' },
        },
        'user',
        id,
      );
      this.#onChange();
      return entry;
    });
  }

  delete(id: string): Promise<void> {
    return this.#serial(async () => {
      const entry = this.#index.get(id);
      if (!entry) throw new Error('Không tìm thấy mục nhớ');
      this.#assertWritable(entry);
      await this.#authorize('delete', 'user', {
        branch: entry.branch,
        title: entry.title,
        id,
        kind: entry.kind,
        sensitive: entry.sensitive,
      });
      const path = this.#entryPath(entry);
      this.#writeFile(path, null);
      await this.#git.commit(
        { op: 'delete', summary: `Xoá: ${entry.title}`, entryId: id, paths: [path] },
        this.#author(),
      );
      this.#index.remove(id);
      await this.#vector.remove(id).catch(() => undefined);
      this.#log({
        op: 'delete',
        by: 'user',
        branch: entry.branch,
        entryId: id,
        title: entry.title,
        decision: 'allow',
      });
      this.#onChange();
    });
  }

  saveBranch(path: string, meta: Partial<BranchMeta>): Promise<MemoryBranch> {
    return this.#serial(async () => {
      if (!BRANCH_PATH.test(path)) throw new Error(`Tên nhánh không hợp lệ: ${path}`);
      const existing = this.#branch(path);
      const merged: BranchMeta = {
        title: meta.title?.trim() || existing?.title || path.split('/').pop() || path,
        description: meta.description ?? existing?.description ?? '',
        autoApprove: meta.autoApprove ?? existing?.autoApprove ?? true,
        minConfidence: meta.minConfidence ?? existing?.minConfidence ?? 0.85,
        hidden: meta.hidden ?? existing?.hidden ?? false,
      };
      const op: MemoryOp = existing ? 'update' : 'create';
      await this.#authorize(op, 'user', { branch: path, title: merged.title }, 'branch');
      const file = `${path}/${BRANCH_FILE}`;
      this.#writeFile(file, branchToMarkdown(merged));
      await this.#git.commit(
        {
          op: 'branch',
          summary: `${existing ? 'Sửa' : 'Tạo'} nhánh: ${merged.title}`,
          paths: [file],
        },
        this.#author(),
      );
      this.#log({ op, by: 'user', branch: path, title: merged.title, decision: 'allow' });
      this.#onChange();
      return { ...merged, path, count: existing?.count ?? 0 };
    });
  }

  // ------------------------------------------------------------ Lịch sử + hoàn tác

  async #current(path: string): Promise<string | null> {
    const full = join(this.root, path);
    return existsSync(full) ? readFileSync(full, 'utf8') : null;
  }

  async history(options: { entryId?: string; limit?: number } = {}): Promise<MemoryHistoryItem[]> {
    const log = await this.#git.log(options.entryId ? 500 : (options.limit ?? 100));
    const items: MemoryHistoryItem[] = [];
    // Commit mới nhất chạm vào từng file — chỉ thay đổi mới nhất của một file mới hoàn tác được.
    const latestFor = new Map<string, string>();
    for (const c of log) for (const p of c.paths) if (!latestFor.has(p)) latestFor.set(p, c.commit);
    for (const c of log) {
      if (options.entryId && c.entryId !== options.entryId) continue;
      const undoable =
        c.parent !== undefined &&
        c.op !== 'init' &&
        c.paths.length > 0 &&
        c.paths.every((p) => latestFor.get(p) === c.commit);
      items.push({
        commit: c.commit,
        at: c.at,
        summary: c.summary,
        op: c.op,
        ...(c.entryId ? { entryId: c.entryId } : {}),
        undoable,
      });
      if (items.length >= (options.limit ?? 100)) break;
    }
    return items;
  }

  /** Hoàn tác một thay đổi: đưa các file của commit đó về như trước commit. */
  undo(commit: string): Promise<MemoryHistoryItem> {
    return this.#serial(async () => {
      const log = await this.#git.log(1000);
      const target = log.find((c) => c.commit === commit);
      if (!target) throw new Error('Không tìm thấy thay đổi này trong lịch sử');
      if (!target.parent || target.op === 'init')
        throw new Error('Không hoàn tác được bước tạo kho');
      for (const path of target.paths) {
        const after = await this.#git.read(commit, path);
        if ((await this.#current(path)) !== after) {
          throw new Error('Mục này đã thay đổi sau lần đó — hãy hoàn tác thay đổi mới hơn trước.');
        }
      }
      const entryPaths = target.paths.filter((p) => p.endsWith('.md') && !p.endsWith(BRANCH_FILE));
      const before = new Map<string, string | null>();
      for (const path of target.paths) before.set(path, await this.#git.read(target.parent, path));
      const branch = dirname(target.paths[0] ?? '');
      const title = target.summary.replace(/^[^:]+:\s*/, '');
      await this.#authorize('revert', 'user', {
        branch: branch === '.' ? '' : branch,
        title,
        ...(target.entryId ? { id: target.entryId } : {}),
      });
      for (const [path, content] of before) this.#writeFile(path, content);
      const summary = `Hoàn tác: ${target.summary}`;
      const result = await this.#git.commit(
        {
          op: 'revert',
          summary,
          ...(target.entryId ? { entryId: target.entryId } : {}),
          paths: target.paths,
        },
        this.#author(),
      );
      for (const path of entryPaths) {
        const content = before.get(path);
        const id = path.split('/').pop()?.slice(0, -3) ?? '';
        if (content === null || content === undefined) {
          this.#index.remove(id);
          await this.#vector.remove(id).catch(() => undefined);
        } else {
          const entry = entryFromMarkdown(content, dirname(path), id);
          this.#index.upsert(entry);
          await this.#vector.upsert(entry).catch(() => undefined);
        }
      }
      this.#log({
        op: 'revert',
        by: 'user',
        branch,
        ...(target.entryId ? { entryId: target.entryId } : {}),
        title: summary,
        decision: 'allow',
      });
      this.#onChange();
      return {
        commit: result,
        at: this.#now().toISOString(),
        summary,
        op: 'revert',
        ...(target.entryId ? { entryId: target.entryId } : {}),
        undoable: true,
      };
    });
  }

  /** Dựng lại chỉ mục SQLite (và vector nếu có) từ file Markdown. */
  rebuildIndex(options: { audit?: boolean } = {}): Promise<number> {
    return this.#serial(async () => {
      const entries = this.#scanEntries();
      this.#index.rebuild(entries);
      await this.#vector.rebuild(entries).catch(() => undefined);
      if (options.audit !== false) {
        this.#log({ op: 'reindex', by: 'user', title: `${entries.length} mục`, decision: 'allow' });
      }
      this.#onChange();
      return entries.length;
    });
  }

  // ------------------------------------------------------------ Hộp duyệt

  #inboxFile(): string {
    return join(this.root, DATA_DIR, 'inbox.json');
  }

  #loadProposals(): MemoryProposal[] {
    try {
      const data = JSON.parse(readFileSync(this.#inboxFile(), 'utf8')) as {
        proposals?: MemoryProposal[];
      };
      return Array.isArray(data.proposals) ? data.proposals : [];
    } catch {
      return [];
    }
  }

  #saveProposals(): void {
    // Giữ mọi đề xuất đang chờ + 300 đề xuất đã quyết định gần nhất.
    const pending = this.#proposals.filter((p) => p.status === 'pending');
    const decided = this.#proposals.filter((p) => p.status !== 'pending').slice(-300);
    this.#proposals = [...decided, ...pending].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    this.#writeFile(
      `${DATA_DIR}/inbox.json`,
      JSON.stringify({ version: 1, proposals: this.#proposals }, null, 2),
    );
  }

  listProposals(status?: MemoryProposal['status']): MemoryProposal[] {
    return this.#proposals
      .filter((p) => !status || p.status === status)
      .slice()
      .reverse();
  }

  /**
   * Đưa một đề xuất ghi nhớ vào hộp duyệt (từ agent qua `mem_propose`, từ bộ chắt lọc, từ nhập
   * lịch sử). Hộp duyệt tự nhận nếu đủ điều kiện của nhánh; không thì giữ lại chờ người duyệt.
   */
  propose(
    draft: MemoryDraft,
    options: { targetId?: string; conversationId?: string } = {},
  ): Promise<MemoryProposal> {
    return this.#serial(async () => {
      const clean = this.#validateDraft(draft);
      const agentId = clean.source.agentId;
      if (agentId) {
        const verdict = await this.#check({
          kind: 'memory.propose',
          agentId,
          branch: clean.branch,
          title: clean.title,
          ...(options.conversationId ? { conversationId: options.conversationId } : {}),
        });
        if (verdict.decision !== 'allow') {
          this.#log({
            op: 'propose',
            by: 'agent',
            agentId,
            branch: clean.branch,
            title: clean.title,
            decision: verdict.decision,
            reason: verdict.decision === 'ask' ? verdict.reason : verdict.reason,
          });
          throw new Error(`Chính sách không cho phép: ${verdict.reason}`);
        }
      }
      const readable = this.#readable();
      const report = findConflicts(clean, readable, options.targetId);
      const judgement = judgeProposal(clean, this.#branch(clean.branch), report, options);
      const proposal: MemoryProposal = {
        id: `p-${randomBytes(6).toString('hex')}`,
        createdAt: this.#now().toISOString(),
        draft: clean,
        ...(options.targetId ? { targetId: options.targetId } : {}),
        status: 'pending',
        reasons: judgement.verdict === 'accept' ? [] : judgement.reasons,
        conflicts: report.conflicts.map((c) => ({ id: c.id, title: c.title, body: c.body })),
      };
      this.#log({
        op: 'propose',
        by: agentId ? 'agent' : 'auto',
        ...(agentId ? { agentId } : {}),
        branch: clean.branch,
        proposalId: proposal.id,
        title: clean.title,
        decision: 'allow',
      });
      this.#proposals.push(proposal);

      if (judgement.verdict === 'accept') {
        try {
          const entry = await this.#save(clean, 'auto', options.targetId);
          Object.assign(proposal, {
            status: 'accepted',
            decidedAt: this.#now().toISOString(),
            decidedBy: 'auto',
            entryId: entry.id,
          });
          this.#log({
            op: 'accept',
            by: 'auto',
            branch: clean.branch,
            proposalId: proposal.id,
            entryId: entry.id,
            title: clean.title,
            decision: 'allow',
          });
        } catch (err) {
          proposal.reasons = [
            `Không tự nhận được: ${err instanceof Error ? err.message : String(err)}`,
          ];
        }
      } else if (judgement.verdict === 'reject') {
        Object.assign(proposal, {
          status: 'rejected',
          decidedAt: this.#now().toISOString(),
          decidedBy: 'auto',
        });
        this.#log({
          op: 'reject',
          by: 'auto',
          branch: clean.branch,
          proposalId: proposal.id,
          title: clean.title,
          decision: 'allow',
          reason: judgement.reasons.join('; '),
        });
      }
      this.#saveProposals();
      this.#onChange();
      return proposal;
    });
  }

  /** Người dùng nhận đề xuất (có thể sửa nội dung trước khi nhận). */
  accept(
    proposalId: string,
    edits: Partial<Omit<MemoryDraft, 'source'>> = {},
  ): Promise<MemoryEntry> {
    return this.#serial(async () => {
      const proposal = this.#proposals.find((p) => p.id === proposalId);
      if (!proposal || proposal.status !== 'pending')
        throw new Error('Đề xuất không còn chờ duyệt');
      const draft: MemoryDraft = { ...proposal.draft, ...edits, source: proposal.draft.source };
      const targetId =
        proposal.targetId && this.#index.get(proposal.targetId) ? proposal.targetId : undefined;
      const entry = await this.#save(draft, 'user', targetId);
      Object.assign(proposal, {
        draft,
        status: 'accepted',
        decidedAt: this.#now().toISOString(),
        decidedBy: 'user',
        entryId: entry.id,
      });
      this.#log({
        op: 'accept',
        by: 'user',
        branch: entry.branch,
        proposalId,
        entryId: entry.id,
        title: entry.title,
        decision: 'allow',
      });
      this.#saveProposals();
      this.#onChange();
      return entry;
    });
  }

  reject(proposalId: string): Promise<void> {
    return this.#serial(async () => {
      const proposal = this.#proposals.find((p) => p.id === proposalId);
      if (!proposal || proposal.status !== 'pending')
        throw new Error('Đề xuất không còn chờ duyệt');
      Object.assign(proposal, {
        status: 'rejected',
        decidedAt: this.#now().toISOString(),
        decidedBy: 'user',
      });
      this.#log({
        op: 'reject',
        by: 'user',
        branch: proposal.draft.branch,
        proposalId,
        title: proposal.draft.title,
        decision: 'allow',
      });
      this.#saveProposals();
      this.#onChange();
    });
  }

  // ------------------------------------------------------------ Cho agent dùng

  /**
   * Phần ngữ cảnh chèn vào đầu một lượt: quy tắc hành vi (luôn có), các mục liên quan đến câu
   * hỏi (FTS5), rồi — nếu kho còn nhỏ — các mục mới nhất cho tới khi hết giới hạn ký tự.
   */
  contextFor(
    prompt: string,
    options: { maxChars?: number; tools?: boolean } = {},
  ): MemoryContext | null {
    const maxChars = options.maxChars ?? 4000;
    // Agent có tool mem_* thì luôn được báo, kể cả khi kho còn trống — để khi người dùng dặn
    // nhớ, agent đề xuất vào NSA Mem thay vì ghi vào bộ nhớ riêng của CLI (đã thấy khi chạy thật).
    const toolsHint = options.tools
      ? 'Bạn có tool MCP của NSA (server nsa_mem): mem_search / mem_read để tra bộ nhớ của người ' +
        'dùng; mem_propose để đề xuất ghi nhớ khi người dùng dặn nhớ hoặc khi có điều đáng nhớ lâu ' +
        'dài. Dùng mem_propose thay cho file nhớ hay bộ nhớ riêng của bạn — bộ nhớ NSA dùng chung cho mọi agent.'
      : null;
    const readable = this.#readable();
    if (readable.length === 0) {
      return toolsHint ? { text: `[Bộ nhớ NSA] ${toolsHint}`, entries: [] } : null;
    }
    const branches = new Map(this.listBranches().map((b) => [b.path, b]));
    const picked = new Map<string, MemoryEntry>();
    for (const e of readable) if (e.kind === 'rule') picked.set(e.id, e);
    for (const hit of this.search(prompt, { limit: 12 })) picked.set(hit.entry.id, hit.entry);
    if (readable.length <= 60) {
      for (const e of [...readable].sort((a, b) => b.updated.localeCompare(a.updated))) {
        picked.set(e.id, e);
      }
    }
    const header =
      '[Bộ nhớ NSA] Những điều người dùng đã dạy NSA, dùng chung cho mọi agent. Dùng khi liên quan, ' +
      'không cần nhắc lại phần này. Quy tắc hành vi phải tuân theo. Cần thêm thì gọi tool mem_search.';
    const footer = '[Hết bộ nhớ]';
    const lines: string[] = [];
    const used: { id: string; title: string }[] = [];
    let size = header.length + footer.length;
    for (const e of picked.values()) {
      if (e.sensitive) continue; // nhạy cảm: không tự chèn, agent phải đọc qua tool khi cần
      const branch = branches.get(e.branch)?.title ?? e.branch;
      const body = e.body.replace(/\s+/g, ' ').trim();
      const text = body.toLowerCase().startsWith(e.title.toLowerCase())
        ? body
        : `${e.title}: ${body}`;
      const line = `- ${e.kind === 'rule' ? '(Quy tắc) ' : ''}[${branch}] ${text.length > 500 ? `${text.slice(0, 497)}…` : text}`;
      if (size + line.length + 1 > maxChars) {
        if (e.kind === 'rule') continue;
        break;
      }
      lines.push(line);
      used.push({ id: e.id, title: e.title });
      size += line.length + 1;
    }
    if (lines.length === 0) {
      return toolsHint ? { text: `[Bộ nhớ NSA] ${toolsHint}`, entries: [] } : null;
    }
    return {
      text: [header, ...(toolsHint ? [toolsHint] : []), ...lines, footer].join('\n'),
      entries: used,
    };
  }

  /** Ba thao tác cho agent: `mem_search` / `mem_read` / `mem_propose`. */
  tools(): McpTool[] {
    const branchList = () =>
      this.listBranches()
        .filter((b) => !b.hidden)
        .map((b) => `${b.path} (${b.title})`)
        .join(', ');
    return [
      {
        name: 'mem_search',
        description:
          'Tìm trong bộ nhớ NSA của người dùng (điều người dùng đã dạy, dùng chung cho mọi agent). ' +
          'Trả về danh sách mục: mã, nhánh, tiêu đề, trích đoạn.',
        readOnly: true,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Từ khoá hoặc câu hỏi' },
            branch: { type: 'string', description: 'Chỉ tìm trong nhánh này (tuỳ chọn)' },
            limit: { type: 'number', description: 'Số kết quả tối đa (mặc định 8)' },
          },
          required: ['query'],
        },
        call: (args) => {
          const hits = this.search(String(args['query'] ?? ''), {
            limit: Number(args['limit']) || 8,
            ...(typeof args['branch'] === 'string' && args['branch']
              ? { branch: args['branch'] }
              : {}),
          });
          if (hits.length === 0) return 'Không tìm thấy mục nhớ nào.';
          return hits
            .map((h) => `${h.entry.id} | ${h.entry.branch} | ${h.entry.title}\n  ${h.snippet}`)
            .join('\n');
        },
      },
      {
        name: 'mem_read',
        description: 'Đọc toàn văn một mục trong bộ nhớ NSA theo mã (lấy mã từ mem_search).',
        readOnly: true,
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'Mã mục nhớ, dạng m-…' } },
          required: ['id'],
        },
        call: (args) => {
          const id = String(args['id'] ?? '');
          const entry = ENTRY_ID.test(id) ? this.get(id) : null;
          if (!entry) throw new Error(`Không có mục nhớ ${id}`);
          return [
            `# ${entry.title}`,
            `Nhánh: ${entry.branch} · Loại: ${entry.kind} · Tin cậy: ${Math.round(entry.confidence * 100)}% · Cập nhật: ${entry.updated}`,
            '',
            entry.body,
          ].join('\n');
        },
      },
      {
        name: 'mem_propose',
        description:
          'Đề xuất ghi một điều đáng nhớ vào bộ nhớ NSA (khi người dùng dặn nhớ, hoặc khi phát hiện ' +
          'sở thích / quy ước / quyết định lâu dài). Đề xuất vào HỘP DUYỆT, không ghi thẳng: điều ' +
          'chắc chắn và không mâu thuẫn thì tự nhận; quy tắc hành vi, nhạy cảm hoặc mâu thuẫn thì chờ người duyệt. ' +
          `Nhánh có sẵn: ${branchList()}.`,
        // Không sửa file nào của người dùng — chỉ thêm một đề xuất vào hộp duyệt.
        readOnly: true,
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Tiêu đề ngắn' },
            body: { type: 'string', description: 'Nội dung, viết thành câu đầy đủ, tự hiểu được' },
            branch: { type: 'string', description: 'Đường dẫn nhánh (mặc định nguoi-dung)' },
            kind: {
              type: 'string',
              enum: ['fact', 'preference', 'rule'],
              description: 'fact: sự thật; preference: sở thích; rule: quy tắc agent phải theo',
            },
            subject: { type: 'string', description: 'Khoá chủ đề ngắn, ví dụ mau-yeu-thich' },
            confidence: { type: 'number', description: '0–1: chắc chắn đến đâu' },
          },
          required: ['title', 'body'],
        },
        call: async (args, context: McpCallContext) => {
          const kind = ['fact', 'preference', 'rule'].includes(String(args['kind']))
            ? (String(args['kind']) as MemoryKind)
            : 'fact';
          const proposal = await this.propose(
            {
              branch:
                typeof args['branch'] === 'string' && args['branch']
                  ? args['branch']
                  : 'nguoi-dung',
              title: String(args['title'] ?? ''),
              body: String(args['body'] ?? ''),
              kind,
              ...(typeof args['subject'] === 'string' ? { subject: args['subject'] } : {}),
              confidence: Number.isFinite(Number(args['confidence']))
                ? Number(args['confidence'])
                : 0.8,
              source: {
                kind: 'agent',
                agentId: context.agentId,
                ...(context.conversationId ? { ref: `nsa:${context.conversationId}` } : {}),
              },
            },
            context.conversationId ? { conversationId: context.conversationId } : {},
          );
          if (proposal.status === 'accepted') return `Đã ghi vào bộ nhớ (mã ${proposal.entryId}).`;
          if (proposal.status === 'rejected') return `Không ghi: ${proposal.reasons.join('; ')}.`;
          return `Đã đưa vào hộp duyệt, chờ người dùng duyệt: ${proposal.reasons.join('; ')}.`;
        },
      },
    ];
  }

  close(): void {
    this.#index.close();
  }

  /** Để test: người đang dùng. */
  get actor(): Identity {
    return this.#identity.current();
  }
}
