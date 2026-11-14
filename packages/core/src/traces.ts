/**
 * Traces (giai đoạn 6b, ADR-0018): xem lại từng lượt chạy. Dữ liệu LẤY TỪ nhật ký (`AuditLog`),
 * không có nguồn ghi mới. File này chỉ có kiểu dùng chung (lõi, gói `traces`, giao diện) và hợp đồng IPC;
 * phần đọc nhật ký + chỉ mục nằm ở gói `@nsa/traces`.
 */

/** Loại "lượt chạy" trong Traces. */
export type TraceKind =
  /** Một lượt chat giữa người dùng và agent (kể cả lượt do trưởng đội giao việc). */
  | 'turn'
  /** Việc nền giao cho agent (chắt lọc bộ nhớ…): không có cuộc trò chuyện. */
  | 'task'
  /** Một lần chạy của plugin (việc nền, hành động ra ngoài, lỗi sập…). */
  | 'plugin'
  /** Sự kiện hệ thống đứng riêng (vượt hạn mức, đổi model dự phòng…). */
  | 'system';

export type TraceStatus = 'running' | 'ok' | 'error' | 'cancelled' | 'denied';

export interface TraceSummary {
  id: string;
  kind: TraceKind;
  /** ISO 8601. */
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  /** Tên một dòng: câu lệnh (cắt ngắn) hoặc tên việc / plugin. */
  title: string;
  status: TraceStatus;
  actor: string;
  /** Agent cuối cùng trả lời (sau lùi tầng / đổi agent). */
  agentId: string;
  /** Mọi agent đã tham gia, theo thứ tự. */
  agentIds: string[];
  pluginIds: string[];
  conversationId?: string;
  /** Mã việc trên bảng việc của đội (giai đoạn 6b phần 2) — để nhảy từ bảng việc sang Traces. */
  teamTaskId?: string;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Chi phí ước tính cộng từ các sự kiện `usage` có giá; null nếu không lượt nào biết giá. */
  costUsd: number | null;
  errors: number;
  /** Số lần lùi tầng / đổi agent / đổi model. */
  fallbacks: number;
  /** Có quyết định "hỏi" / "chặn" của chính sách. */
  policyFlags: number;
}

export type TraceStepKind =
  | 'request'
  | 'policy'
  | 'tool_call'
  | 'tool_result'
  | 'permission'
  | 'usage'
  | 'notice'
  | 'error'
  | 'fallback'
  | 'mcp_tool'
  | 'plugin'
  | 'reply'
  | 'done'
  | 'budget';

export interface TraceStep {
  seq: number;
  at: string;
  kind: TraceStepKind;
  agentId: string;
  /** Dòng tóm tắt. */
  title: string;
  /** Nội dung đầy đủ (đầu vào / kết quả / văn bản…), đã che bí mật và cắt ở giới hạn lưu. */
  detail?: string;
  /** Nội dung đã bị cắt bớt khi lưu. */
  truncated?: boolean;
  /** Quyết định của chính sách, nếu bước này là một quyết định. */
  decision?: 'allow' | 'ask' | 'deny';
  ok?: boolean;
  ms?: number;
}

export interface TraceDetail extends TraceSummary {
  steps: TraceStep[];
}

export interface TraceQuery {
  /** Ngày, dạng `YYYY-MM-DD` (theo giờ UTC của nhật ký), gồm cả hai đầu. */
  from?: string;
  to?: string;
  agentId?: string;
  pluginId?: string;
  status?: TraceStatus;
  kind?: TraceKind;
  /** Tìm theo chữ trong câu lệnh, lệnh gọi tool, kết quả, câu trả lời, lỗi. */
  text?: string;
  teamTaskId?: string;
  limit?: number;
  offset?: number;
}

export interface TraceList {
  items: TraceSummary[];
  /** Tổng số khớp bộ lọc (không tính giới hạn). */
  total: number;
}

export interface TraceFilters {
  agents: string[];
  plugins: string[];
}

/** Tình trạng chỉ mục — giao diện hiện "đang dựng chỉ mục" khi file nhật ký lớn. */
export interface TraceIndexStatus {
  state: 'idle' | 'indexing';
  /** Số dòng nhật ký đã đưa vào chỉ mục. */
  indexedLines: number;
  traces: number;
  /** Chi phí ước tính cả tháng theo sổ chi phí (null nếu không đọc được). */
  monthCostUsd: number | null;
}

export interface TracesIpcContract {
  'traces:list': { args: [query: TraceQuery]; result: TraceList };
  'traces:get': { args: [id: string]; result: TraceDetail | null };
  'traces:filters': { args: []; result: TraceFilters };
  'traces:status': { args: []; result: TraceIndexStatus };
  /** Dựng lại chỉ mục từ file nhật ký gốc (xoá chỉ mục cũ). */
  'traces:reindex': { args: []; result: TraceIndexStatus };
}

export const TRACES_IPC_CHANNELS = [
  'traces:list',
  'traces:get',
  'traces:filters',
  'traces:status',
  'traces:reindex',
] as const satisfies readonly (keyof TracesIpcContract)[];
