/** Kiểu dùng chung của adapter `api`. */

export type ApiStandard = 'openai' | 'anthropic';

export interface ImagePart {
  mimeType: string;
  /** Dữ liệu base64 (không có tiền tố data:). */
  base64: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Tham số dạng JSON (chuỗi). */
  arguments: string;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: ImagePart[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError: boolean };

/** Mô tả một tool cho model (giai đoạn 3: lấy từ cổng MCP của NSA). */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema của tham số. */
  inputSchema: Record<string, unknown>;
}

/**
 * Nơi adapter lấy danh sách tool và chạy tool model gọi.
 * Giai đoạn 3 nối với MCP gateway; mỗi lần `call` phải đi qua ổ cắm chính sách (`agent.tool`).
 */
export interface ToolExecutor {
  list(): ToolSpec[] | Promise<ToolSpec[]>;
  call(
    name: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<{ output: string; isError: boolean }>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  /** Lý do dừng theo hãng (`stop`, `end_turn`, `tool_calls`, `tool_use`…). */
  stopReason: string | null;
}

/** Địa chỉ + chuẩn + key để gọi một hãng. */
export interface Endpoint {
  standard: ApiStandard;
  /** Địa chỉ gốc, ví dụ `https://api.deepseek.com` hoặc `https://api.anthropic.com`. */
  baseUrl: string;
  /** Không có key (máy cục bộ) thì để trống. */
  apiKey?: string;
  /** Tên hiển thị trong thông báo lỗi. */
  label: string;
}

/**
 * Loại lỗi khi gọi hãng — bộ định tuyến dựa vào đây:
 * - `auth`: key sai / hết hạn / không có quyền.
 * - `quota`: hết hạn mức, quá giới hạn tốc độ, hết tiền.
 * - `network`: không kết nối được.
 * - `server`: hãng lỗi (5xx).
 * - `request`: yêu cầu sai (model không tồn tại…).
 * - `protocol`: không đọc được trả lời.
 */
export type ApiErrorKind = 'auth' | 'quota' | 'network' | 'server' | 'request' | 'protocol';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | undefined;
  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}
