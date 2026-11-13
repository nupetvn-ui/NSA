/**
 * Ba "ổ cắm" của lõi NSA (xem mục "Hai bản đóng gói" trong docs/PLAN.md).
 * Lõi chỉ định nghĩa interface; mỗi bản đóng gói cắm bộ cài đặt của mình vào.
 * File này kèm bộ cắm mặc định của bản Cá nhân — đơn giản, không chứa nghiệp vụ doanh nghiệp.
 */
import type { AgentEvent, PermissionLevel } from '@nsa/adapter-sdk';
import type { MemoryKind, MemoryOp } from './memory.js';

// ---------------------------------------------------------------- Danh tính

export interface Identity {
  /** Mã ổn định của người dùng (bản Cá nhân: tên tài khoản hệ điều hành). */
  id: string;
  displayName: string;
  /** Vai trò — bản Cá nhân luôn là ['owner']; bản Doanh nghiệp lấy từ SSO. */
  roles: string[];
  edition: 'personal' | 'enterprise';
}

/** Ổ cắm danh tính: ai đang dùng. License để giai đoạn 8. */
export interface IdentityProvider {
  current(): Identity;
}

export function localIdentity(username: string): IdentityProvider {
  const identity: Identity = {
    id: `local:${username}`,
    displayName: username,
    roles: ['owner'],
    edition: 'personal',
  };
  return { current: () => identity };
}

// ---------------------------------------------------------------- Chính sách

/** Một việc cần xin phép trước khi làm. Plugin sẽ thêm loại hành động ở giai đoạn 3. */
export type PolicyAction =
  /** Cho một agent chạy một lượt. */
  | {
      kind: 'agent.run';
      agentId: string;
      cwd: string;
      permission: PermissionLevel;
      prompt: string;
      conversationId?: string;
    }
  /**
   * Một lệnh BÊN TRONG lượt (chạy shell, sửa file…), hỏi qua cổng chính sách — chỉ có với
   * agent khai báo `toolGate` (xem ADR-0007).
   */
  | {
      kind: 'agent.tool';
      agentId: string;
      cwd: string;
      permission: PermissionLevel;
      conversationId: string;
      turnId: string;
      /** Tên công cụ theo CLI (`Bash`, `Edit`, `bash`, `write`…). */
      tool: string;
      /** Tham số của công cụ, dạng văn bản (lệnh shell, đường dẫn…). */
      input: string;
    }
  /**
   * Ghi / sửa / xoá / hoàn tác một mục nhớ (NSA Mem). `by`: người dùng bấm, bộ tự duyệt,
   * hay agent (agent chỉ được đề xuất — xem `memory.propose`).
   */
  | {
      kind: 'memory.write';
      op: MemoryOp;
      /** Mục nhớ hay nhánh (tạo / sửa cấu hình nhánh). */
      target: 'entry' | 'branch';
      by: 'user' | 'auto';
      branch: string;
      entryId?: string;
      title: string;
      memoryKind: MemoryKind;
      sensitive: boolean;
    }
  /** Agent (qua `mem_propose`) hoặc bộ chắt lọc đưa một đề xuất vào hộp duyệt. */
  | {
      kind: 'memory.propose';
      agentId: string;
      branch: string;
      title: string;
      conversationId?: string;
    };

export interface PolicyRequest {
  actor: Identity;
  action: PolicyAction;
  /** Người dùng đã xác nhận cho việc này (sau một lần trả lời "hỏi"). */
  confirmed: boolean;
}

export type PolicyDecision =
  | { decision: 'allow' }
  | { decision: 'ask'; reason: string }
  | { decision: 'deny'; reason: string };

/** Ổ cắm chính sách: mọi lệnh của agent (sau này cả plugin) phải qua đây trước khi chạy. */
export interface Policy {
  check(request: PolicyRequest): PolicyDecision | Promise<PolicyDecision>;
}

/**
 * Lệnh shell phá huỷ không thể hoàn tác — bản Cá nhân luôn chặn, kể cả khi đã cho sửa file.
 * Danh sách cố ý ngắn: chỉ bắt lệnh rõ ràng là xoá sạch ổ đĩa / thư mục người dùng / định dạng.
 */
const DESTRUCTIVE: { pattern: RegExp; what: string }[] = [
  {
    pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~|\$HOME|\/\*)(\s|$)/i,
    what: 'xoá toàn bộ ổ đĩa / thư mục người dùng',
  },
  { pattern: /\b(format|format\.com)\s+[a-z]:/i, what: 'định dạng ổ đĩa' },
  { pattern: /\bmkfs(\.\w+)?\b/i, what: 'định dạng ổ đĩa' },
  { pattern: /\bdd\b[^|]*\bof=\/dev\//i, what: 'ghi đè thiết bị' },
  {
    pattern: /\b(rd|rmdir|del|erase)\b[^&|]*\/s\b[^&|]*\b[a-z]:\\?(\s|$|\*)/i,
    what: 'xoá toàn bộ ổ đĩa',
  },
  {
    pattern: /\bremove-item\b[^|]*-recurse[^|]*\s['"]?[a-z]:\\?['"]?(\s|$)/i,
    what: 'xoá toàn bộ ổ đĩa',
  },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, what: 'fork bomb' },
];

/** Lệnh ra ngoài máy hoặc khó hoàn tác — bản Cá nhân hỏi người dùng trước. */
const RISKY: { pattern: RegExp; what: string }[] = [
  { pattern: /\bgit\s+push\b/i, what: 'đẩy mã lên kho từ xa (git push)' },
  { pattern: /\b(npm|pnpm|yarn)\s+publish\b/i, what: 'phát hành gói lên npm' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, what: 'xoá thay đổi chưa commit (git reset --hard)' },
  { pattern: /\bgit\s+clean\s+-[a-z]*f/i, what: 'xoá file chưa theo dõi (git clean)' },
  {
    pattern: /\b(curl|wget|iwr|invoke-webrequest)\b[^|]*\|\s*(sh|bash|iex|powershell)\b/i,
    what: 'tải và chạy mã từ mạng',
  },
];

/**
 * Chính sách mặc định bản Cá nhân: cho phép; hỏi khi nguy hiểm.
 * - Lượt chạy: cho agent sửa file thì hỏi một lần cho mỗi cuộc trò chuyện; sửa ngay ở gốc
 *   ổ đĩa / thư mục người dùng thì lần nào cũng hỏi.
 * - Từng lệnh (agent có cổng): chặn lệnh phá huỷ hiển nhiên; hỏi với lệnh ra ngoài máy
 *   hoặc khó hoàn tác; còn lại cho phép.
 */
export function personalPolicy(options: { homeDir?: string } = {}): Policy {
  const home = options.homeDir ? normalizePath(options.homeDir) : null;
  return {
    check({ action, confirmed }) {
      // Bộ nhớ của chính người dùng trên máy họ: cho phép. Đề xuất của agent chỉ vào hộp
      // duyệt; quy tắc hành vi / nhạy cảm / mâu thuẫn do hộp duyệt giữ lại chờ người duyệt.
      if (action.kind === 'memory.write' || action.kind === 'memory.propose') {
        return { decision: 'allow' };
      }
      if (action.kind === 'agent.tool') {
        const destructive = DESTRUCTIVE.find((r) => r.pattern.test(action.input));
        if (destructive) {
          return { decision: 'deny', reason: `Chặn lệnh ${destructive.what}: ${action.input}` };
        }
        const risky = RISKY.find((r) => r.pattern.test(action.input));
        if (risky && !confirmed) {
          return { decision: 'ask', reason: `Agent muốn ${risky.what}: ${action.input}` };
        }
        return { decision: 'allow' };
      }
      if (action.permission !== 'edit') return { decision: 'allow' };
      const cwd = normalizePath(action.cwd);
      if (isDriveRoot(cwd) || (home !== null && cwd === home)) {
        return confirmed
          ? { decision: 'allow' }
          : {
              decision: 'ask',
              reason: `Cho agent sửa file ngay trong "${action.cwd}" — cả ổ đĩa / thư mục người dùng. Bạn chắc chứ?`,
            };
      }
      return confirmed
        ? { decision: 'allow' }
        : {
            decision: 'ask',
            reason: `Cho agent sửa file trong "${action.cwd}"? Bạn chỉ phải xác nhận một lần cho cuộc trò chuyện này.`,
          };
    },
  };
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function isDriveRoot(path: string): boolean {
  return path === '' || /^[a-z]:$/.test(path);
}

// ---------------------------------------------------------------- Nhật ký

export type AuditEntry = {
  at: string;
  actor: { id: string; displayName: string };
  conversationId?: string;
  turnId?: string;
  agentId: string;
} & (
  | { type: 'request'; prompt: string; cwd: string; permission: PermissionLevel }
  | {
      type: 'policy';
      decision: PolicyDecision['decision'];
      reason?: string;
      confirmed: boolean;
      /** Có khi quyết định cho một lệnh bên trong lượt (`agent.tool`). */
      tool?: { name: string; input: string };
    }
  /** Tầng chính hỏng nên lùi tầng, hoặc agent hỏng / chưa cài nên đổi agent. */
  | { type: 'fallback'; kind: 'tier' | 'agent'; from: string; to: string; reason: string }
  /** Phát hiện CLI vừa đổi phiên bản hoặc `--help` so với lần khởi động trước. */
  | { type: 'cli_change'; summary: string }
  /** Sự kiện của agent (trừ từng mẩu văn bản — văn bản trả lời được ghi gộp khi lượt kết thúc). */
  | { type: 'agent_event'; event: Exclude<AgentEvent, { type: 'text' }> }
  | { type: 'reply'; text: string }
  /** Mọi thay đổi bộ nhớ (kể cả bị chính sách chặn) và mọi quyết định của hộp duyệt. */
  | {
      type: 'memory';
      op: MemoryOp | 'propose' | 'accept' | 'reject' | 'reindex';
      by: 'user' | 'auto' | 'agent';
      branch?: string;
      entryId?: string;
      proposalId?: string;
      title?: string;
      decision: PolicyDecision['decision'];
      reason?: string;
    }
);

/** Ổ cắm nhật ký: nhận mọi việc đã xảy ra (ai ra lệnh, agent làm gì, sửa gì). */
export interface AuditLog {
  record(entry: AuditEntry): void;
}

/** Nhật ký giữ trong bộ nhớ — dùng cho test hoặc khi không cần lưu. */
export function memoryAuditLog(): AuditLog & { entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return { entries, record: (entry) => void entries.push(entry) };
}
