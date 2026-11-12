/**
 * Ba "ổ cắm" của lõi NSA (xem mục "Hai bản đóng gói" trong docs/PLAN.md).
 * Lõi chỉ định nghĩa interface; mỗi bản đóng gói cắm bộ cài đặt của mình vào.
 * File này kèm bộ cắm mặc định của bản Cá nhân — đơn giản, không chứa nghiệp vụ doanh nghiệp.
 */
import type { AgentEvent, PermissionLevel } from '@nsa/adapter-sdk';

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
export type PolicyAction = {
  kind: 'agent.run';
  agentId: string;
  cwd: string;
  permission: PermissionLevel;
  prompt: string;
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
 * Chính sách mặc định bản Cá nhân: cho phép; hỏi khi nguy hiểm.
 * "Nguy hiểm" = cho agent sửa file (hỏi một lần cho mỗi cuộc trò chuyện),
 * hoặc sửa file ngay ở gốc ổ đĩa / thư mục người dùng (lần nào cũng hỏi).
 */
export function personalPolicy(options: { homeDir?: string } = {}): Policy {
  const home = options.homeDir ? normalizePath(options.homeDir) : null;
  return {
    check({ action, confirmed }) {
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
  | { type: 'policy'; decision: PolicyDecision['decision']; reason?: string; confirmed: boolean }
  /** Sự kiện của agent (trừ từng mẩu văn bản — văn bản trả lời được ghi gộp khi lượt kết thúc). */
  | { type: 'agent_event'; event: Exclude<AgentEvent, { type: 'text' }> }
  | { type: 'reply'; text: string }
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
