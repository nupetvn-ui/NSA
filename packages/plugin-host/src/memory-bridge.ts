import type {
  MemoryBranch,
  MemoryDraft,
  MemoryEntry,
  MemoryHistoryItem,
  MemoryProposal,
  MemorySearchHit,
} from '@nsa/core';
import type { PluginMemoryBridge } from './host.js';

/** Phần của `MemoryService` (@nsa/memory) mà cầu nối cần — để host không phụ thuộc vào gói bộ nhớ. */
export interface MemoryServiceLike {
  listBranches(): MemoryBranch[];
  saveBranch(
    path: string,
    meta: { title?: string; hidden?: boolean; autoApprove?: boolean; minConfidence?: number },
  ): Promise<MemoryBranch>;
  search(query: string, options?: { limit?: number; branch?: string }): MemorySearchHit[];
  searchHybrid(
    query: string,
    options?: { limit?: number; branch?: string },
  ): Promise<{ mode: 'semantic' | 'keyword'; hits: MemorySearchHit[]; note?: string }>;
  get(id: string): MemoryEntry | null;
  listEntries(branch?: string): MemoryEntry[];
  propose(draft: MemoryDraft, options?: { targetId?: string }): Promise<MemoryProposal>;
  listProposals(status?: MemoryProposal['status']): MemoryProposal[];
  accept(
    proposalId: string,
    edits?: Partial<Omit<MemoryDraft, 'source'>>,
    options?: { replace?: string },
  ): Promise<MemoryEntry>;
  reject(proposalId: string): Promise<void>;
  delete(id: string): Promise<void>;
  history(options?: { entryId?: string; limit?: number }): Promise<MemoryHistoryItem[]>;
  undo(commit: string): Promise<MemoryHistoryItem>;
}

const inBranch = (entryBranch: string, branch: string): boolean =>
  entryBranch === branch || entryBranch.startsWith(`${branch}/`);

/** Nhánh con của mục so với nhánh gốc đang xét (`''` nếu nằm ngay ở gốc). */
const relative = (entryBranch: string, branch: string): string =>
  entryBranch === branch ? '' : entryBranch.slice(branch.length + 1);

/**
 * Cầu nối plugin ↔ NSA Mem. Plugin chỉ thấy nhánh của chính nó (`plugin/<id>/<nhánh>`, ẩn mặc
 * định); điều plugin đề xuất đi qua HỘP DUYỆT và quy tắc tự duyệt của nhánh như mọi nguồn khác,
 * kèm nguồn gốc `plugin:<id>`. Duyệt / xoá / hoàn tác cũng bị khoá trong nhánh đó.
 */
export function createMemoryBridge(service: MemoryServiceLike): PluginMemoryBridge {
  const owned = (branch: string, id: string): MemoryEntry => {
    const entry = service.get(id);
    if (!entry || !inBranch(entry.branch, branch)) {
      throw new Error('Mục nhớ này không nằm trong nhánh của plugin.');
    }
    return entry;
  };
  const pendingIn = (branch: string, proposalId: string): MemoryProposal => {
    const p = service
      .listProposals('pending')
      .find((x) => x.id === proposalId && inBranch(x.draft.branch, branch));
    if (!p) throw new Error('Đề xuất không còn chờ duyệt, hoặc không thuộc nhánh của plugin.');
    return p;
  };

  return {
    async ensureBranch(path, title) {
      const parts = path.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join('/');
        if (service.listBranches().some((b) => b.path === prefix)) continue;
        await service.saveBranch(prefix, {
          title: i === parts.length ? title : (parts[i - 1] ?? prefix),
          hidden: true,
        });
      }
    },
    search: async (branch, query, limit) =>
      service
        .search(query, { limit, branch })
        .filter((h) => inBranch(h.entry.branch, branch))
        .map((h) => ({ id: h.entry.id, title: h.entry.title, snippet: h.snippet })),
    searchSemantic: async (branch, query, limit) => {
      const result = await service.searchHybrid(query, { limit, branch });
      return {
        mode: result.mode,
        hits: result.hits
          .filter((h) => inBranch(h.entry.branch, branch) && !h.entry.sensitive)
          .map((h) => ({ id: h.entry.id, title: h.entry.title, snippet: h.snippet })),
      };
    },
    list: async (branch, limit) =>
      service
        .listEntries(branch)
        .filter((e) => inBranch(e.branch, branch))
        .slice(0, limit)
        .map((e) => ({ id: e.id, title: e.title, body: e.body, updated: e.updated })),
    entries: async (branch, limit) =>
      service
        .listEntries(branch)
        .filter((e) => inBranch(e.branch, branch))
        .slice(0, limit)
        .map((e) => ({
          id: e.id,
          title: e.title,
          body: e.body,
          updated: e.updated,
          tags: e.tags,
          subBranch: relative(e.branch, branch),
          confidence: e.confidence,
          sensitive: e.sensitive,
        })),
    read: async (branch, id) => {
      const entry = service.get(id);
      if (!entry || !inBranch(entry.branch, branch)) return null;
      return { id: entry.id, title: entry.title, body: entry.body, updated: entry.updated };
    },
    propose: async (branch, pluginId, input) => {
      if (input.targetId) owned(branch, input.targetId);
      const proposal = await service.propose(
        {
          branch,
          title: input.title,
          body: input.body,
          kind: input.kind ?? 'fact',
          ...(input.subject ? { subject: input.subject } : {}),
          confidence: input.confidence ?? 0.8,
          ...(input.sensitive ? { sensitive: true } : {}),
          ...(input.tags ? { tags: input.tags } : {}),
          source: { kind: 'plugin', agentId: `plugin:${pluginId}`, ref: `plugin:${pluginId}` },
        },
        input.targetId ? { targetId: input.targetId } : {},
      );
      if (proposal.status === 'accepted') {
        return { status: 'accepted', entryId: proposal.entryId ?? '' };
      }
      return {
        status: proposal.status === 'rejected' ? 'rejected' : 'pending',
        reasons: proposal.reasons,
      };
    },
    pending: async (branch) =>
      service
        .listProposals('pending')
        .filter((p) => inBranch(p.draft.branch, branch))
        .map((p) => ({
          id: p.id,
          createdAt: p.createdAt,
          title: p.draft.title,
          body: p.draft.body,
          confidence: p.draft.confidence,
          sensitive: p.draft.sensitive === true || p.reasons.some((r) => /nhạy cảm/i.test(r)),
          tags: p.draft.tags ?? [],
          subBranch: relative(p.draft.branch, branch),
          reasons: p.reasons,
          ...(p.targetId ? { targetId: p.targetId } : {}),
          conflicts: p.conflicts.map((c) => ({ id: c.id, title: c.title })),
        })),
    accept: async (branch, proposalId, edits) => {
      pendingIn(branch, proposalId);
      const entry = await service.accept(proposalId, {
        ...(edits.title ? { title: edits.title } : {}),
        ...(edits.body ? { body: edits.body } : {}),
      });
      return { entryId: entry.id };
    },
    reject: async (branch, proposalId) => {
      pendingIn(branch, proposalId);
      await service.reject(proposalId);
    },
    remove: async (branch, ids) => {
      const undo: string[] = [];
      for (const id of ids) {
        owned(branch, id);
        await service.delete(id);
        const item = (await service.history({ entryId: id, limit: 5 })).find(
          (h) => h.op === 'delete',
        );
        if (item) undo.push(item.commit);
      }
      return { undo };
    },
    restore: async (branch, undo) => {
      // Chỉ hoàn tác lần XOÁ mà mọi file nằm trong nhánh của plugin — không đụng nhánh khác.
      const prefix = branch.endsWith('/') ? branch : `${branch}/`;
      const history = await service.history({ limit: 500 });
      let restored = 0;
      for (const commit of undo) {
        const item = history.find((h) => h.commit === commit);
        if (
          !item ||
          item.op !== 'delete' ||
          !item.paths?.length ||
          !item.paths.every((p) => p.startsWith(prefix))
        ) {
          throw new Error(
            'Không hoàn tác được: thay đổi này không phải lần xoá trong nhánh của plugin.',
          );
        }
        await service.undo(commit);
        restored++;
      }
      return { restored };
    },
    setAutoApprove: async (branch, autoApprove, minConfidence) => {
      await service.saveBranch(branch, {
        autoApprove,
        ...(minConfidence !== undefined ? { minConfidence } : {}),
      });
    },
  };
}
