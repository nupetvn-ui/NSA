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
  /** Tìm trong nhánh của chính plugin (không thấy nhánh khác). */
  search(query: string, options?: { limit?: number }): Promise<MemoryHit[]>;
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
  }): Promise<MemoryProposeResult>;
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
