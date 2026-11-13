/**
 * Cài đặt nhà cung cấp — KHÔNG chứa key (key nằm trong kho khoá, xem secrets.ts).
 * Lưu ở `%APPDATA%\NSA\providers.json`.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CliId, CustomProvider, ModelRef, TaskKind } from './catalog.js';

export interface TaskModelSetting {
  /** Model chính cho loại việc; bỏ trống = NSA tự chọn (model rẻ nhất phù hợp). */
  primary?: ModelRef;
  /** Model dự phòng theo thứ tự. */
  fallbacks: ModelRef[];
}

export interface BudgetSetting {
  /** Hạn mức chi phí ước tính mỗi tháng (USD); null = không đặt. */
  monthlyUsd: number | null;
  /** Cảnh báo khi đạt tỉ lệ này của hạn mức (mặc định 0.8). */
  warnAt: number;
  /** Vượt hạn mức thì chặn gọi model trả phí (qua ổ cắm chính sách). */
  stopAtLimit: boolean;
}

export interface ProviderState {
  /** Giá trị không bí mật người dùng nhập (Workspace ID…). */
  fields?: Record<string, string>;
  /** Model thêm tay hoặc lấy từ máy chủ (Ollama, LM Studio, OpenRouter). */
  extraModels?: string[];
  /** Lần bấm "Kiểm tra" gần nhất. */
  lastCheck?: { at: string; ok: boolean; message: string };
  /** Bật cho nhà cung cấp chạy trên máy (không cần key). */
  enabled?: boolean;
}

/** Một cặp CLI + nhà cung cấp mà người dùng bật: NSA chạy CLI với key của hãng theo từng lượt. */
export interface CliPairing {
  cli: CliId;
  model: ModelRef;
}

export interface ProviderSettings {
  version: 1;
  providers: Record<string, ProviderState>;
  custom: CustomProvider[];
  tasks: Partial<Record<TaskKind, TaskModelSetting>>;
  budget: BudgetSetting;
  pairings: CliPairing[];
  /** Model API hiện trong danh sách agent của chat (mặc định: model chính của mỗi hãng có key). */
  chatModels?: ModelRef[];
}

export function defaultSettings(): ProviderSettings {
  return {
    version: 1,
    providers: {},
    custom: [],
    tasks: {},
    budget: { monthlyUsd: null, warnAt: 0.8, stopAtLimit: false },
    pairings: [],
  };
}

export interface SettingsStore {
  load(): ProviderSettings;
  save(settings: ProviderSettings): void;
}

/** Chuẩn hoá dữ liệu đọc từ đĩa (file cũ / sửa tay) về đúng hình dạng. */
export function normalizeSettings(raw: unknown): ProviderSettings {
  const base = defaultSettings();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<ProviderSettings>;
  const budget = r.budget ?? base.budget;
  return {
    version: 1,
    providers: r.providers && typeof r.providers === 'object' ? r.providers : {},
    custom: Array.isArray(r.custom) ? r.custom : [],
    tasks: r.tasks && typeof r.tasks === 'object' ? r.tasks : {},
    budget: {
      monthlyUsd:
        typeof budget.monthlyUsd === 'number' && budget.monthlyUsd > 0 ? budget.monthlyUsd : null,
      warnAt:
        typeof budget.warnAt === 'number' && budget.warnAt > 0 && budget.warnAt <= 1
          ? budget.warnAt
          : 0.8,
      stopAtLimit: budget.stopAtLimit === true,
    },
    pairings: Array.isArray(r.pairings) ? r.pairings : [],
    ...(Array.isArray(r.chatModels) ? { chatModels: r.chatModels } : {}),
  };
}

export function createFileSettingsStore(file: string): SettingsStore {
  return {
    load() {
      try {
        return normalizeSettings(JSON.parse(readFileSync(file, 'utf8')));
      } catch {
        return defaultSettings();
      }
    },
    save(settings) {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
      renameSync(tmp, file);
    },
  };
}

export function memorySettingsStore(initial?: ProviderSettings): SettingsStore {
  let value = initial ?? defaultSettings();
  return { load: () => structuredClone(value), save: (s) => void (value = structuredClone(s)) };
}
