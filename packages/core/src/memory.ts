/**
 * Kiểu dữ liệu NSA Mem dùng chung giữa lõi, gói `@nsa/memory` và giao diện,
 * cùng ổ cắm thứ tư của lõi: **lưu trữ bộ nhớ có chủ sở hữu và phạm vi**
 * (xem mục "Bốn ổ cắm trong lõi" của docs/PLAN.md và ADR-0008).
 */
import type { Identity } from './sockets.js';

// ---------------------------------------------------------------- Ổ cắm: chủ sở hữu + phạm vi

/** Phạm vi của một mục nhớ. Bản Cá nhân chỉ có `personal`; `team` để bản Doanh nghiệp. */
export type MemoryScope = 'personal' | 'team';

export interface MemoryOwnership {
  /** Mã người sở hữu (`Identity.id`). */
  owner: string;
  scope: MemoryScope;
  /** Mã nhóm khi `scope` là `team`. */
  team?: string;
}

/**
 * Ổ cắm thứ tư: ai sở hữu mục nhớ mới, ai đọc / sửa được mục nào.
 * Bản Cá nhân cắm `personalMemoryAccess` (một người, một máy). Bản Doanh nghiệp
 * (giai đoạn 9) cắm bộ có nhóm, phân quyền theo nhánh, mã hoá — không phải sửa lõi.
 */
export interface MemoryAccess {
  /** Chủ sở hữu + phạm vi gán cho mục nhớ mới tạo trong `branch`. */
  ownershipFor(actor: Identity, branch: string): MemoryOwnership;
  canRead(actor: Identity, entry: MemoryOwnership & { branch: string }): boolean;
  canWrite(actor: Identity, entry: MemoryOwnership & { branch: string }): boolean;
}

/** Bản Cá nhân: một người một máy — mọi mục là của người dùng máy này, phạm vi cá nhân. */
export function personalMemoryAccess(): MemoryAccess {
  return {
    ownershipFor: (actor) => ({ owner: actor.id, scope: 'personal' }),
    // Một máy một người: đọc / sửa được mọi mục cá nhân. Mục nhóm không có ở bản này.
    canRead: (_actor, entry) => entry.scope === 'personal',
    canWrite: (_actor, entry) => entry.scope === 'personal',
  };
}

// ---------------------------------------------------------------- Mục nhớ

/** `rule` là quy tắc hành vi (agent phải làm / không được làm gì) — luôn cần người duyệt. */
export type MemoryKind = 'fact' | 'preference' | 'rule';

export type MemorySourceKind = 'manual' | 'chat' | 'distill' | 'import' | 'agent';

/** Nguồn gốc của một mục nhớ — bắt buộc, để biết điều gì từ đâu ra. */
export interface MemorySource {
  kind: MemorySourceKind;
  /** Tham chiếu: `nsa:<mã cuộc trò chuyện>`, `claude:<mã phiên>`… */
  ref?: string;
  /** Agent đã đề xuất / chắt lọc. */
  agentId?: string;
}

export interface MemoryEntry extends MemoryOwnership {
  id: string;
  /** Đường dẫn nhánh, ví dụ `nguoi-dung` hoặc `du-an/nsa`. */
  branch: string;
  title: string;
  body: string;
  kind: MemoryKind;
  /** Khoá chủ đề ngắn (vd. `mau-yeu-thich`) — hai mục cùng chủ đề mà khác nội dung là mâu thuẫn. */
  subject?: string;
  /** 0–1. */
  confidence: number;
  sensitive: boolean;
  source: MemorySource;
  tags: string[];
  created: string;
  updated: string;
}

export interface MemoryBranch {
  path: string;
  title: string;
  description: string;
  /** Tự nhận đề xuất khi đủ tin cậy và không mâu thuẫn. */
  autoApprove: boolean;
  /** Độ tin cậy tối thiểu để tự nhận. */
  minConfidence: number;
  /** Nhánh ẩn (của plugin) — giao diện không hiện mặc định. */
  hidden: boolean;
  count: number;
}

/** Nội dung một mục nhớ chưa lưu (người dạy, agent đề xuất, chắt lọc…). */
export interface MemoryDraft {
  branch: string;
  title: string;
  body: string;
  kind: MemoryKind;
  subject?: string;
  confidence: number;
  sensitive?: boolean;
  tags?: string[];
  source: MemorySource;
}

export type MemoryOp = 'create' | 'update' | 'delete' | 'revert';

// ---------------------------------------------------------------- Hộp duyệt

export type ProposalStatus = 'pending' | 'accepted' | 'rejected';

export interface MemoryProposal {
  id: string;
  createdAt: string;
  draft: MemoryDraft;
  /** Có thì đề xuất sửa mục này thay vì tạo mục mới. */
  targetId?: string;
  status: ProposalStatus;
  /** Vì sao phải chờ người duyệt (hoặc vì sao bị tự từ chối). */
  reasons: string[];
  /** Mục đã có mâu thuẫn với đề xuất. */
  conflicts: { id: string; title: string; body: string }[];
  decidedAt?: string;
  decidedBy?: 'auto' | 'user';
  /** Mục nhớ được tạo / sửa khi nhận. */
  entryId?: string;
}

// ---------------------------------------------------------------- Lịch sử, tìm kiếm

export interface MemoryHistoryItem {
  commit: string;
  at: string;
  /** Dòng đầu của thông điệp commit. */
  summary: string;
  op: MemoryOp | 'branch' | 'init';
  entryId?: string;
  /** Hoàn tác được (mục chưa bị đổi tiếp sau thay đổi này). */
  undoable: boolean;
}

export interface MemorySearchHit {
  entry: MemoryEntry;
  /** Trích đoạn có đánh dấu `[` `]` quanh từ khớp. */
  snippet: string;
}

/** Ngữ cảnh bộ nhớ chèn vào đầu một lượt. */
export interface MemoryContext {
  text: string;
  entries: { id: string; title: string }[];
}

// ---------------------------------------------------------------- Cấu hình

export interface DistillSettings {
  enabled: boolean;
  /** Agent chắt lọc, hoặc `auto`. */
  agentId: string;
  /** Chắt lọc sau mỗi N lượt người dùng (0 = tắt). */
  everyTurns: number;
  /** Coi như kết thúc cuộc trò chuyện sau N phút không có lượt mới (0 = tắt). */
  idleMinutes: number;
  /** Chắt lọc ngay khi người dùng sửa lỗi agent ("sai rồi", "không phải"…). */
  onCorrection: boolean;
  /** Chắt lọc ngay khi người dùng dặn nhớ ("hãy nhớ", "ghi nhớ"…). */
  onTeach: boolean;
}

export interface MemorySettings {
  distill: DistillSettings;
  inject: {
    enabled: boolean;
    /** Giới hạn ký tự phần ngữ cảnh chèn vào mỗi lượt. */
    maxChars: number;
  };
  /** Lộ `mem_search` / `mem_read` / `mem_propose` cho agent qua MCP. */
  agentTools: boolean;
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  distill: {
    enabled: true,
    agentId: 'auto',
    everyTurns: 8,
    idleMinutes: 15,
    onCorrection: true,
    onTeach: true,
  },
  inject: { enabled: true, maxChars: 4000 },
  agentTools: true,
};

// ---------------------------------------------------------------- Nhập lịch sử chat

export type ImportSource = 'nsa' | 'claude' | 'codex' | 'opencode';

export interface ImportSourceStatus {
  source: ImportSource;
  name: string;
  /** Đọc được định dạng trên máy này không. */
  available: boolean;
  note: string;
  count: number;
}

export interface ImportCandidate {
  source: ImportSource;
  id: string;
  title: string;
  cwd?: string;
  updatedAt: string;
  messages: number;
  /** Vài câu đầu để người dùng xem trước. */
  preview: { role: 'user' | 'assistant'; text: string }[];
}

/** Trạng thái chắt lọc / nhập, hiển thị trên giao diện. */
export interface DistillStatus {
  running: boolean;
  /** Mô tả việc đang / vừa làm. */
  label: string;
  error?: string;
  /** Số đề xuất vừa sinh ra. */
  proposals?: number;
  at: string;
}
