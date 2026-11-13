/**
 * API có kiểu cho người viết plugin. Plugin chạy trong một tiến trình Node riêng do NSA
 * khởi động; NSA nạp file `main` của manifest, lấy `export default` (kết quả của
 * `definePlugin`) và truyền `ctx` vào từng hàm. Plugin không cần `import` gì lúc chạy —
 * `definePlugin` chỉ để có kiểu — nên gói plugin không phụ thuộc vào SDK này khi chạy.
 */

export interface MemoryHit {
  id: string;
  title: string;
  snippet: string;
}

export interface MemoryNote {
  id: string;
  title: string;
  body: string;
  updated: string;
}

export type MemoryProposeResult =
  | { status: 'accepted'; entryId: string }
  | { status: 'pending'; reasons: string[] }
  | { status: 'rejected'; reasons: string[] };

/** Nhánh nhớ riêng của plugin. Chỉ có khi manifest khai `memory` và người dùng đã cấp quyền. */
export interface PluginMemory {
  /**
   * Tìm trong nhánh của chính plugin (không thấy nhánh khác). `subBranch` thu hẹp vào nhánh con,
   * ví dụ `theo-nhom/123` (ADR-0011).
   */
  search(query: string, options?: { limit?: number; subBranch?: string }): Promise<MemoryHit[]>;
  /** Liệt kê mục nhớ đã được duyệt trong một nhánh con (mới nhất trước), kèm nội dung. */
  list(options?: { subBranch?: string; limit?: number }): Promise<MemoryNote[]>;
  read(id: string): Promise<MemoryNote>;
  /**
   * Đề xuất ghi một mục. Không ghi thẳng: đi qua hộp duyệt và quy tắc tự duyệt của NSA Mem
   * (quy tắc hành vi, nhạy cảm, mâu thuẫn thì chờ người dùng duyệt).
   */
  propose(input: {
    title: string;
    body: string;
    kind?: 'fact' | 'preference' | 'rule';
    subject?: string;
    confidence?: number;
    /** Nhánh con dưới nhánh của plugin, tối đa 3 cấp `a/b/c` (chữ thường, số, `-`, `_`). */
    subBranch?: string;
    /** Đánh dấu nhạy cảm: luôn chờ người duyệt, không tự chèn vào ngữ cảnh agent. */
    sensitive?: boolean;
    tags?: string[];
    /** Sửa mục đã có (cập nhật nội dung) thay vì tạo mục mới. Chỉ trong nhánh của plugin. */
    targetId?: string;
  }): Promise<MemoryProposeResult>;
  /**
   * Tìm theo nghĩa (vector) khi đã có model embedding, lùi về từ khoá (FTS5) khi chưa có.
   * `mode` cho biết kết quả đến từ đâu.
   */
  searchSemantic(
    query: string,
    options?: { limit?: number; subBranch?: string },
  ): Promise<{ mode: 'semantic' | 'keyword'; hits: MemoryHit[] }>;
  /** Mục nhớ (đã duyệt) kèm thẻ và nguồn — để plugin biết mục nào sinh ra từ nguồn nào. */
  entries(options?: { subBranch?: string; limit?: number }): Promise<MemoryEntryInfo[]>;
  /** Đề xuất đang chờ người duyệt trong nhánh của plugin. */
  pending(options?: { subBranch?: string }): Promise<MemoryPendingInfo[]>;
  /** Nhận một đề xuất (có thể sửa tiêu đề / nội dung trước). */
  accept(
    proposalId: string,
    edits?: { title?: string; body?: string },
  ): Promise<{ entryId: string }>;
  reject(proposalId: string): Promise<void>;
  /** Xoá mục nhớ (ghi vào lịch sử, hoàn tác được bằng `restore`). Trả mã hoàn tác. */
  remove(ids: string[]): Promise<{ undo: string[] }>;
  /** Hoàn tác các lần xoá (mã từ `remove`). */
  restore(undo: string[]): Promise<{ restored: number }>;
  /** Cách nhánh con tự nhận đề xuất: tắt thì mọi thứ học được chờ người duyệt. */
  setAutoApprove(subBranch: string, autoApprove: boolean, minConfidence?: number): Promise<void>;
}

export interface MemoryEntryInfo extends MemoryNote {
  tags: string[];
  subBranch: string;
  confidence: number;
  sensitive: boolean;
}

export interface MemoryPendingInfo {
  id: string;
  createdAt: string;
  title: string;
  body: string;
  confidence: number;
  sensitive: boolean;
  tags: string[];
  subBranch: string;
  reasons: string[];
  /** Có thì đây là đề xuất sửa mục này. */
  targetId?: string;
  conflicts: { id: string; title: string }[];
}

/** Ảnh gửi cho model nhìn ảnh. */
export interface ModelImage {
  mimeType: string;
  /** Dữ liệu base64, không có tiền tố `data:`. */
  base64: string;
}

/** Tình trạng model của một loại việc: có model nào dùng được, giá, và hạn mức tháng. */
export interface ModelTaskStatus {
  available: boolean;
  /** Tên model đầu chuỗi (để hiện cho người dùng). */
  label?: string;
  inputUsdPer1M?: number | null;
  outputUsdPer1M?: number | null;
  /** Hạn mức tháng của NSA (USD); `null` = không đặt. */
  budget: { limitUsd: number | null; spentUsd: number; level: 'ok' | 'warn' | 'over' };
}

/**
 * Việc plugin nhờ NSA chạy model. Có khi được cấp quyền `model`; chỉ các loại việc khai ở
 * `permissions.modelTasks` của manifest. Plugin không có key; qua chính sách, chi phí, hạn mức.
 */
export interface PluginModel {
  /** `task`: `channel` (mặc định) hoặc `background` (chắt lọc, tóm tắt). */
  complete(
    prompt: string,
    options?: { system?: string; maxChars?: number; task?: 'channel' | 'background' },
  ): Promise<string>;
  /** Việc "nhìn ảnh / video": mô tả, rút chữ. */
  vision(
    prompt: string,
    images: ModelImage[],
    options?: { system?: string; maxChars?: number },
  ): Promise<string>;
  /** Việc "embedding". Ném lỗi nếu chưa có model embedding — bên gọi lùi về từ khoá. */
  embed(texts: string[]): Promise<number[][]>;
  status(task: 'background' | 'vision' | 'embedding'): Promise<ModelTaskStatus>;
}

/** Kết quả một lần chạy chương trình dòng lệnh. `code` là mã thoát (null: hết giờ / không chạy được). */
export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Có khi không chạy được (chưa cài, hết giờ): lý do đọc được. */
  error?: string;
}

/** Chương trình dòng lệnh nhờ NSA chạy hộ (quyền `cli` — ADR-0012). */
export interface PluginCli {
  /**
   * Chạy chương trình `id` (khai ở `permissions.cli`) với các tham số. KHÔNG qua shell: mỗi phần tử là
   * một tham số. Chỉ chạy được lệnh con nằm trong `allow`; mỗi lần chạy đi qua chính sách + nhật ký.
   */
  run(
    id: string,
    args: string[],
    options?: { tool?: string; timeoutMs?: number },
  ): Promise<CliResult>;
}

/** Hành động ra ngoài mà plugin xin phép NSA (đi qua Policy + AuditLog). */
export interface PluginActionRequest {
  /** Tên ngắn, ví dụ `send_message`, `ban_member`, `broadcast`. */
  action: string;
  /** Thao tác nhạy cảm (đổi trưởng nhóm, xoá, gửi hàng loạt…): bản Cá nhân luôn hỏi người dùng. */
  sensitive?: boolean;
  /** Đối tượng bị tác động (mã nhóm, mã người…). */
  target?: string;
  /** Câu đọc được cho người duyệt và nhật ký. */
  summary: string;
  /** Tool đang chạy (để NSA biết người dùng đã xác nhận ở cổng MCP, khỏi hỏi lại lần hai). */
  tool?: string;
}

export interface PluginConfig {
  /** Cấu hình riêng của plugin, lưu trong thư mục dữ liệu của chính nó. */
  get<T = unknown>(key: string, fallback?: T): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  all(): Promise<Record<string, unknown>>;
}

export interface PluginContext {
  readonly pluginId: string;
  readonly version: string;
  /**
   * Thư mục dữ liệu riêng của plugin — đọc / ghi bằng `node:fs` bình thường. Ngoài thư mục
   * này, thư mục cài đặt (chỉ đọc) và các thư mục người dùng đã cấp, mọi truy cập file bị từ chối.
   */
  readonly dataDir: string;
  /** Thư mục người dùng đã cấp cho quyền `folders` (id khai trong manifest). Ném lỗi nếu chưa cấp. */
  folder(id: string): string;
  readonly config: PluginConfig;
  /** Có khi người dùng đã cấp quyền `memory`. */
  readonly memory: PluginMemory | null;
  /** Có khi người dùng đã cấp quyền `model`. */
  readonly model: PluginModel | null;
  /** Có khi người dùng đã cấp ít nhất một chương trình ở quyền `cli`. */
  readonly cli: PluginCli | null;
  /**
   * Bí mật (token…) khai ở `secrets` của manifest. Plugin không đọc được giá trị — chỉ biết
   * đã nhập chưa, và dùng `{{secret:<id>}}` trong `fetch`.
   */
  readonly secrets: { has(id: string): Promise<boolean> };
  /**
   * Xin phép làm một hành động ra ngoài (gửi tin, xoá, cấm…). Chính sách chặn / người dùng từ chối
   * thì ném lỗi — mã gọi KHÔNG được làm hành động đó. Hành động nhạy cảm luôn hỏi người dùng.
   */
  gate(request: PluginActionRequest): Promise<void>;
  log(message: string, level?: 'info' | 'warn' | 'error'): void;
  /** Cần quyền `notifications`. */
  notify(notification: { title: string; body?: string }): Promise<void>;
  /**
   * Gọi mạng: `fetch` toàn cục trong plugin chính là hàm này — chỉ tới được các tên miền người
   * dùng đã cấp quyền `network`, mọi tên miền khác bị từ chối.
   */
  fetch: typeof fetch;
  /** Gửi sự kiện tới màn hình đang mở của plugin (`window.nsa.on(tên, hàm)`). */
  emit(event: string, data?: unknown): void;
}

/** Ngữ cảnh khi agent gọi tool. */
export interface ToolContext extends PluginContext {
  readonly caller: { agentId: string; conversationId?: string };
}

export type ToolResult = string | number | boolean | null | Record<string, unknown> | unknown[];

export interface PluginDefinition {
  /** Chạy một lần khi plugin được bật (hoặc khởi động lại sau lỗi). */
  activate?(ctx: PluginContext): void | Promise<void>;
  /** Chạy khi plugin bị tắt / gỡ — có ~3 giây để dọn dẹp. */
  deactivate?(): void | Promise<void>;
  /** Khoá = `name` trong `tools` của manifest. Trả chuỗi hoặc dữ liệu JSON. */
  tools?: Record<
    string,
    (args: Record<string, unknown>, ctx: ToolContext) => ToolResult | Promise<ToolResult>
  >;
  /** Khoá = `id` trong `jobs` của manifest. */
  jobs?: Record<string, (ctx: PluginContext) => void | Promise<void>>;
  /** Hàm màn hình gọi được bằng `await nsa.call('tên', tham số)`. */
  ui?: Record<string, (params: unknown, ctx: PluginContext) => ToolResult | Promise<ToolResult>>;
}

/** Chỉ để có gợi ý kiểu: trả lại đúng đối tượng truyền vào. */
export function definePlugin(definition: PluginDefinition): PluginDefinition {
  return definition;
}

/** Màn hình của plugin chạy trong khung cô lập và có sẵn `window.nsa`. */
export interface NsaScreenBridge {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  on(event: string, handler: (data: unknown) => void): () => void;
}
