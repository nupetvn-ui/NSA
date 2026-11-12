/**
 * Luồng sự kiện chuẩn hoá mà mọi adapter phát ra, bất kể CLI phía dưới là gì.
 * Giao diện và lõi chỉ hiểu các sự kiện này, nên CLI đổi định dạng thì chỉ sửa adapter.
 */
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
  /** Agent cần người dùng cho phép (chưa CLI nào phát ra ở chế độ headless hiện tại). */
  | { type: 'ask_permission'; id: string; description: string }
  /** Lượng token đã dùng trong lượt này. */
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
  /** Lỗi trong lượt (đăng nhập, mạng, CLI hỏng…). Sau đó vẫn có `done`. */
  | { type: 'error'; message: string }
  /** Lượt kết thúc — luôn là sự kiện cuối cùng. */
  | { type: 'done'; cancelled: boolean };

export type AgentEventType = AgentEvent['type'];
