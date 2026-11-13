import type {
  MemoryBranch,
  MemoryDraft,
  MemoryEntry,
  MemoryProposal,
  MemorySearchHit,
} from '@nsa/core';
import type { PluginMemoryBridge } from './host.js';

/** Phần của `MemoryService` (@nsa/memory) mà cầu nối cần — để host không phụ thuộc vào gói bộ nhớ. */
export interface MemoryServiceLike {
  listBranches(): MemoryBranch[];
  saveBranch(path: string, meta: { title?: string; hidden?: boolean }): Promise<MemoryBranch>;
  search(query: string, options?: { limit?: number; branch?: string }): MemorySearchHit[];
  get(id: string): MemoryEntry | null;
  listEntries(branch?: string): MemoryEntry[];
  propose(draft: MemoryDraft): Promise<MemoryProposal>;
}

const inBranch = (entryBranch: string, branch: string): boolean =>
  entryBranch === branch || entryBranch.startsWith(`${branch}/`);

/**
 * Cầu nối plugin ↔ NSA Mem. Plugin chỉ thấy nhánh của chính nó (`plugin/<id>/<nhánh>`, ẩn mặc
 * định); điều plugin đề xuất đi qua HỘP DUYỆT và quy tắc tự duyệt của nhánh như mọi nguồn khác,
 * kèm nguồn gốc `plugin:<id>`.
 */
export function createMemoryBridge(service: MemoryServiceLike): PluginMemoryBridge {
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
    list: async (branch, limit) =>
      service
        .listEntries(branch)
        .filter((e) => inBranch(e.branch, branch))
        .slice(0, limit)
        .map((e) => ({ id: e.id, title: e.title, body: e.body, updated: e.updated })),
    read: async (branch, id) => {
      const entry = service.get(id);
      if (!entry || !inBranch(entry.branch, branch)) return null;
      return { id: entry.id, title: entry.title, body: entry.body, updated: entry.updated };
    },
    propose: async (branch, pluginId, input) => {
      const proposal = await service.propose({
        branch,
        title: input.title,
        body: input.body,
        kind: input.kind ?? 'fact',
        ...(input.subject ? { subject: input.subject } : {}),
        confidence: input.confidence ?? 0.8,
        source: { kind: 'plugin', agentId: `plugin:${pluginId}`, ref: `plugin:${pluginId}` },
      });
      if (proposal.status === 'accepted') {
        return { status: 'accepted', entryId: proposal.entryId ?? '' };
      }
      return {
        status: proposal.status === 'rejected' ? 'rejected' : 'pending',
        reasons: proposal.reasons,
      };
    },
  };
}
