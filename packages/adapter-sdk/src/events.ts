/**
 * Luồng sự kiện chuẩn hoá mà mọi adapter phát ra, bất kể CLI phía dưới là gì.
 * Giao diện và lõi chỉ hiểu các sự kiện này, nên CLI đổi định dạng thì chỉ sửa adapter.
 */

/**
 * Loại lỗi — lõi dựa vào đây để quyết định lùi tầng hay đổi agent:
 * - `not_installed`: không tìm thấy CLI → đổi agent.
 * - `auth`: chưa đăng nhập / hết hạn → đổi agent (lùi tầng cũng vô ích).
 * - `protocol`: không đọc được đầu ra (CLI có thể đã đổi định dạng hoặc cờ) → lùi tầng.
 * - `cli`: CLI báo lỗi khác (mạng, model, giới hạn…).
 */
export type AgentErrorCode = 'not_installed' | 'auth' | 'protocol' | 'cli';

export type AgentEvent =
  /** CLI đã cấp mã phiên — dùng để tiếp tục (resume) ở lượt sau. */
  | { type: 'session'; sessionId: string }
  /**
   * Một đoạn văn bản của agent. Các sự kiện cùng `id` nối tiếp nhau thành một khối
   * (CLI có stream từng phần thì gửi nhiều lần, không thì gửi một lần đủ cả khối).
   */
  | { type: 'text'; id: string; text: string }
  /** Agent gọi một công cụ (chạy lệnh, sửa file, đọc file…). */
  | { type: 'tool_call'; id: string; name: string; input: string }
  /** Kết quả của lần gọi công cụ cùng `id`. */
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  /** Một lệnh bên trong lượt cần người dùng cho phép (do ổ cắm chính sách trả lời "hỏi"). */
  | { type: 'ask_permission'; id: string; description: string }
  /** Người dùng (hoặc chính sách) đã trả lời yêu cầu `ask_permission` cùng `id`. */
  | { type: 'permission_result'; id: string; allowed: boolean; reason?: string }
  /** Lượng token đã dùng trong lượt này. */
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
  /** Thông báo của NSA cho người dùng (lùi tầng, đổi agent…). Không phải lỗi. */
  | { type: 'notice'; message: string }
  /** Lỗi trong lượt (đăng nhập, mạng, CLI hỏng…). Sau đó vẫn có `done`. */
  | { type: 'error'; message: string; code?: AgentErrorCode }
  /** Lượt kết thúc — luôn là sự kiện cuối cùng. */
  | { type: 'done'; cancelled: boolean };

export type AgentEventType = AgentEvent['type'];
