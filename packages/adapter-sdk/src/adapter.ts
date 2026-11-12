import type { AgentEvent } from './events.js';

/** Kết quả dò tìm CLI trên máy người dùng. */
export interface DetectResult {
  /** CLI có chạy được không. */
  installed: boolean;
  version?: string;
  /** Đã đăng nhập / sẵn sàng nhận việc chưa (nếu CLI cho biết được). */
  ready: boolean;
  /** Ghi chú cho người dùng khi chưa sẵn sàng, ví dụ cách cài hoặc đăng nhập. */
  note?: string;
}

/** Bảng năng lực — bộ định tuyến dùng để chọn agent phù hợp. */
export interface Capabilities {
  /** Văn bản trả về từng phần trong lúc agent đang viết. */
  streaming: boolean;
  /** Tiếp tục được phiên cũ bằng mã phiên. */
  resume: boolean;
  /** Chạy lệnh shell / sửa file trong thư mục làm việc. */
  tools: boolean;
  /** Nhận ảnh đính kèm. */
  images: boolean;
  /** Gắn được server MCP ngoài. */
  mcp: boolean;
}

/**
 * Quyền của agent trong thư mục làm việc:
 * - `read-only`: chỉ đọc, không sửa file, không chạy lệnh làm thay đổi máy.
 * - `edit`: được sửa file trong thư mục làm việc.
 */
export type PermissionLevel = 'read-only' | 'edit';

export interface RunOptions {
  prompt: string;
  /** Thư mục làm việc của agent (đường dẫn tuyệt đối). */
  cwd: string;
  /** Mã phiên trả về từ lượt trước để tiếp tục cuộc trò chuyện. */
  sessionId?: string;
  permission: PermissionLevel;
}

export interface AgentRun {
  /** Dừng lượt đang chạy (kết thúc bằng sự kiện `done` với `cancelled: true`). */
  cancel(): void;
  /** Hoàn tất khi đã phát sự kiện `done`. */
  finished: Promise<void>;
}

/** Hợp đồng mọi adapter CLI phải theo. */
export interface AgentAdapter {
  /** Mã ngắn, cố định: 'claude', 'codex'… */
  readonly id: string;
  /** Tên hiển thị cho người dùng. */
  readonly displayName: string;
  detect(): Promise<DetectResult>;
  capabilities(): Capabilities;
  run(options: RunOptions, onEvent: (event: AgentEvent) => void): AgentRun;
}
