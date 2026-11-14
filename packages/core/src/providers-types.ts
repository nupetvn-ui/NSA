/**
 * Kiểu của màn hình Nhà cung cấp (ADR-0009): dữ liệu hãng/model, cài đặt, chi phí và `ProvidersView`
 * mà giao diện nhận. Chỉ có kiểu — hiện thực nằm ở `@nsa/providers`, nên lõi không phụ thuộc gói đó
 * (ADR-0015). `@nsa/providers` import lại các kiểu này từ đây và xuất lại để API công khai không đổi.
 */

/** Chuẩn API: chuẩn OpenAI (chat completions) hoặc chuẩn Anthropic (messages). */
export type ApiStandard = 'openai' | 'anthropic';

/** Các loại việc có model riêng (PLAN.md, "Chọn model theo việc"). */
export type TaskKind = 'main' | 'background' | 'vision' | 'embedding' | 'channel';

/**
 * - `stable`: NSA đã chạy thật việc gọi tool với model này — được giao việc sửa file.
 * - `documented`: tài liệu nói hỗ trợ, NSA chưa thử.
 * - `none`: không hỗ trợ.
 */
export type ToolCalling = 'stable' | 'documented' | 'none';

export type CliId = 'claude' | 'codex' | 'opencode';

/**
 * - `documented`: tài liệu chính thức hướng dẫn ghép.
 * - `tested-fake`: đã chạy CLI thật với máy chủ giả đúng chuẩn.
 * - `tested`: đã chạy thật với hãng.
 * - `unverified`: chưa xác minh — NSA không ghép.
 * - `unsupported`: không ghép được.
 */
export type CliPairStatus = 'documented' | 'tested-fake' | 'tested' | 'unverified' | 'unsupported';

export interface CliPair {
  status: CliPairStatus;
  note?: string;
  /** Tên model theo vai trò mà CLI dùng (Claude Code: model chính và model "haiku" cho việc phụ). */
  models?: { default?: string; haiku?: string };
  /** Biến môi trường nhận key mà CLI tự đọc (OpenCode với nhà cung cấp có sẵn). */
  env?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  kind: 'chat' | 'embedding';
  /** Loại việc model này hợp (dùng để tự chọn mặc định). */
  tasks: TaskKind[];
  /** USD / 1 triệu token; null = chưa xác minh. */
  inputUsdPer1M: number | null;
  outputUsdPer1M: number | null;
  freeTier: boolean | null;
  vision: boolean | null;
  toolCalling: ToolCalling;
  contextTokens?: number | null;
  note?: string;
}

export interface ProviderField {
  id: string;
  label: string;
  hint?: string;
}

export interface ProviderData {
  serverLocation: string | null;
  training: string | null;
  tier: 'free' | 'paid' | 'both' | 'local';
  /** Cảnh báo nổi bật cho người dùng (máy chủ nước ngoài, dùng dữ liệu để huấn luyện…). */
  warning?: string;
  sources: string[];
}

export interface ProviderInfo {
  id: string;
  name: string;
  group: 'major' | 'budget' | 'gateway' | 'local' | 'custom';
  keyRequired: boolean;
  keyUrl?: string;
  /** Chuẩn adapter `api` dùng khi gọi thẳng. */
  standard: ApiStandard;
  /** Địa chỉ gốc theo từng chuẩn (có thể chứa `{field}` thay bằng giá trị người dùng nhập). */
  endpoints: Partial<Record<ApiStandard, string>>;
  /** Thông tin thêm người dùng phải nhập (không bí mật), ví dụ Workspace ID. */
  fields?: ProviderField[];
  data: ProviderData;
  cli: Partial<Record<CliId, CliPair>>;
  /** Danh sách model lấy từ máy chủ (`GET /models`) — Ollama, LM Studio, OpenRouter. */
  modelsFromServer?: boolean;
  models: ModelInfo[];
}

export interface Catalog {
  schema: number;
  version: string;
  checkedAt: string;
  providers: ProviderInfo[];
}

/** Mã model đầy đủ: `<nhà cung cấp>/<model>` (model có thể chứa `/`). */
export type ModelRef = string;

/** Nhà cung cấp người dùng tự khai báo: địa chỉ + chuẩn + tên model. Không chứa key. */
export interface CustomProvider {
  id: string;
  name: string;
  standard: ApiStandard;
  baseUrl: string;
  models: string[];
  /** Người dùng xác nhận model gọi tool ổn định (mặc định: không). */
  toolCallingStable?: boolean;
}

export interface TaskModelSetting {
  /** Model chính cho loại việc; bỏ trống = NSA tự chọn (model rẻ nhất phù hợp). */
  primary?: ModelRef;
  /** Model dự phòng theo thứ tự. */
  fallbacks: ModelRef[];
}

export type BudgetLevel = 'none' | 'ok' | 'warn' | 'over';

export interface BudgetStatus {
  month: string;
  spentUsd: number;
  limitUsd: number | null;
  level: BudgetLevel;
  /** Có lượt chưa biết giá — tổng thật có thể cao hơn. */
  incomplete: boolean;
}

export interface ModelView extends ModelInfo {
  ref: ModelRef;
}

export interface ProviderView {
  id: string;
  name: string;
  group: ProviderInfo['group'];
  keyRequired: boolean;
  keyUrl?: string;
  standard: ProviderInfo['standard'];
  endpoints: ProviderInfo['endpoints'];
  fields: NonNullable<ProviderInfo['fields']>;
  fieldValues: Record<string, string>;
  data: ProviderData;
  /** Bốn ký tự cuối của key (••••abcd) — KHÔNG bao giờ là cả key. */
  keyHint: string | null;
  usable: boolean;
  enabled: boolean;
  lastCheck?: { at: string; ok: boolean; message: string };
  models: ModelView[];
  cli: { cli: CliId; status: CliPairStatus; allowed: boolean; note?: string }[];
  custom?: CustomProvider;
}

export interface TaskView {
  task: TaskKind;
  label: string;
  setting: TaskModelSetting;
  /** Chuỗi model NSA sẽ thử theo thứ tự (gồm cả phần tự thêm). */
  chain: { ref: ModelRef; name: string; providerName: string; chosen: boolean }[];
}

export interface UsageRow {
  ref: ModelRef;
  providerName: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  calls: number;
  unpricedCalls: number;
}

export interface ProvidersView {
  catalogVersion: string;
  catalogCheckedAt: string;
  catalogNote?: string;
  /** Kho khoá của hệ điều hành dùng được không. */
  keystore: boolean;
  providers: ProviderView[];
  tasks: TaskView[];
  pairings: { cli: CliId; model: ModelRef; agentId: string }[];
  budget: BudgetStatus & { warnAt: number; stopAtLimit: boolean };
  usage: UsageRow[];
}

export type ProviderSettingsPatch =
  | { kind: 'fields'; providerId: string; fields: Record<string, string> }
  | { kind: 'enabled'; providerId: string; enabled: boolean }
  | { kind: 'extraModels'; providerId: string; models: string[] }
  | { kind: 'task'; task: TaskKind; setting: TaskModelSetting }
  | { kind: 'budget'; monthlyUsd: number | null; warnAt?: number; stopAtLimit?: boolean }
  | { kind: 'pairing'; cli: CliId; model: ModelRef; on: boolean }
  | { kind: 'custom'; provider: CustomProvider }
  | { kind: 'removeCustom'; providerId: string };

export interface CheckResult {
  ok: boolean;
  message: string;
  models?: string[];
}
