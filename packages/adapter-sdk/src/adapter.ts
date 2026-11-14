import type { AgentEvent } from './events.js';
import type { McpServerSpec } from './mcp.js';

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

/**
 * Tầng giao tiếp (nguyên tắc 3 của PLAN.md):
 * - `protocol`: giao thức chuẩn (ACP, SDK chính thức).
 * - `headless`: chế độ không giao diện có JSON (`claude -p --output-format stream-json`…).
 * - `pty`: giả lập terminal / đọc văn bản thô — chạy được với mọi CLI, dễ vỡ nhất.
 */
export type Tier = 'protocol' | 'headless' | 'pty';

/** Bảng năng lực — bộ định tuyến dùng để chọn agent phù hợp. */
export interface Capabilities {
  /** Văn bản trả về từng phần trong lúc agent đang viết. */
  streaming: boolean;
  /** Tiếp tục được phiên cũ bằng mã phiên. */
  resume: boolean;
  /** Chạy lệnh shell / đọc file trong thư mục làm việc. */
  tools: boolean;
  /** Sửa được file khi người dùng cho quyền `edit`. */
  editFiles: boolean;
  /** Nhận ảnh đính kèm. */
  images: boolean;
  /** Gắn được server MCP ngoài. */
  mcp: boolean;
  /** Tự chia việc cho agent con. */
  subagents: boolean;
  /** NSA chặn được từng lệnh bên trong một lượt (qua cổng chính sách — xem gate.ts). */
  toolGate: boolean;
  tier: Tier;
}

/** Các năng lực dạng có/không — dùng để khai báo "việc này cần gì". */
export type CapabilityFlag = Exclude<keyof Capabilities, 'tier'>;

/**
 * Quyền của agent trong thư mục làm việc:
 * - `read-only`: chỉ đọc, không sửa file, không chạy lệnh làm thay đổi máy.
 * - `edit`: được sửa file trong thư mục làm việc.
 */
export type PermissionLevel = 'read-only' | 'edit';

/** Địa chỉ cổng chính sách cục bộ mà móc (hook) của CLI gọi về trước mỗi lệnh. */
export interface ToolGateEndpoint {
  url: string;
  token: string;
}

export interface RunOptions {
  prompt: string;
  /** Thư mục làm việc của agent (đường dẫn tuyệt đối). */
  cwd: string;
  /** Mã phiên trả về từ lượt trước để tiếp tục cuộc trò chuyện. */
  sessionId?: string;
  permission: PermissionLevel;
  /**
   * Có thì adapter PHẢI gắn móc của CLI để hỏi cổng này trước mỗi lệnh,
   * và móc phải "lỗi là chặn". Chỉ truyền khi `capabilities().toolGate` là true.
   */
  gate?: ToolGateEndpoint;
  /**
   * Server MCP của NSA gắn cho lượt này (`attachMcp` trong PLAN.md). Adapter có
   * `capabilities().mcp` gắn vào CLI; adapter không hỗ trợ thì bỏ qua.
   */
  mcpServers?: McpServerSpec[];
  /**
   * Biến môi trường riêng của lượt này (ví dụ key của hãng khi NSA cấp key cho CLI — ADR-0009).
   * Có thể chứa bí mật: adapter chỉ được truyền cho tiến trình con, không ghi ra đâu cả.
   */
  env?: Record<string, string>;
  /**
   * Ảnh đính kèm lượt này (việc "nhìn ảnh" — ADR-0017). Chỉ adapter có `capabilities().images`
   * dùng; adapter khác bỏ qua. Dữ liệu base64, không có tiền tố `data:`.
   */
  images?: { mimeType: string; base64: string }[];
}

export interface AgentRun {
  /** Dừng lượt đang chạy (kết thúc bằng sự kiện `done` với `cancelled: true`). */
  cancel(): void;
  /** Hoàn tất khi đã phát sự kiện `done`. */
  finished: Promise<void>;
}

/** Dấu vân tay của CLI — so giữa các lần khởi động để phát hiện nhà cung cấp vừa cập nhật. */
export interface CliFingerprint {
  version: string | null;
  /** Đầu ra `--help` (đã chuẩn hoá xuống dòng). */
  help: string | null;
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
  /** Lấy phiên bản + `--help` để phát hiện thay đổi. */
  fingerprint?(): Promise<CliFingerprint>;
  /**
   * Adapter tầng dưới của cùng CLI, dùng khi tầng chính hỏng (ví dụ CLI đổi định dạng JSON).
   * Thường là adapter PTY / văn bản thô.
   */
  readonly fallback?: AgentAdapter;
}

/** Tuỳ chọn chung của các adapter CLI. */
export interface CliAdapterOptions {
  /** Lệnh gọi CLI (mặc định là tên CLI, tìm trong PATH). */
  command?: string;
  /** Tham số chèn trước tham số của adapter — dùng cho CLI giả trong test hợp đồng. */
  prefixArgs?: string[];
}
