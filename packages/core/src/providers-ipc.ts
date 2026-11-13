/**
 * Kênh IPC của màn hình Nhà cung cấp (ADR-0008). Giao diện KHÔNG BAO GIỜ nhận key:
 * `ProvidersView` chỉ có bốn ký tự cuối. Key đi một chiều renderer → main qua `providers:setKey`.
 */
import type { CheckResult, ProviderSettingsPatch, ProvidersView, TaskKind } from '@nsa/providers';

export type { CheckResult, ProviderSettingsPatch, ProvidersView, TaskKind };

/** Kết quả chạy thử một loại việc (ví dụ việc nền) qua chuỗi model. */
export interface TaskTryResult {
  ok: boolean;
  /** Model đã làm việc này. */
  model?: string;
  text?: string;
  notices: string[];
  error?: string;
}

export interface BudgetAlert {
  level: 'warn' | 'over';
  spentUsd: number;
  limitUsd: number;
}

export interface ProvidersIpcContract {
  'providers:view': { args: []; result: ProvidersView };
  'providers:setKey': { args: [providerId: string, key: string]; result: ProvidersView };
  'providers:deleteKey': { args: [providerId: string]; result: ProvidersView };
  'providers:check': { args: [providerId: string]; result: CheckResult };
  'providers:update': { args: [patch: ProviderSettingsPatch]; result: ProvidersView };
  'providers:tryTask': { args: [task: TaskKind, prompt: string]; result: TaskTryResult };
}

export interface ProvidersIpcEventContract {
  'providers:changed': ProvidersView;
  'providers:budget': BudgetAlert;
  /** Thông báo khi việc nền phải chuyển model dự phòng. */
  'providers:notice': string;
}

export const PROVIDERS_IPC_CHANNELS = [
  'providers:view',
  'providers:setKey',
  'providers:deleteKey',
  'providers:check',
  'providers:update',
  'providers:tryTask',
] as const satisfies readonly (keyof ProvidersIpcContract)[];

export const PROVIDERS_IPC_EVENT_CHANNELS = [
  'providers:changed',
  'providers:budget',
  'providers:notice',
] as const satisfies readonly (keyof ProvidersIpcEventContract)[];
