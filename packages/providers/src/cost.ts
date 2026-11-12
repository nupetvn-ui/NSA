/**
 * Theo dõi token và chi phí ước tính theo hãng/model, hạn mức tháng tự đặt.
 * Sổ ghi lưu mỗi tháng một file JSON trong `%APPDATA%\NSA\usage\` — chỉ số đếm, không có nội dung.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelInfo, ModelRef } from './catalog.js';
import type { BudgetSetting } from './settings.js';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Chi phí ước tính (USD) theo bảng giá trong file dữ liệu; null nếu chưa biết giá. */
export function estimateCostUsd(
  model: Pick<ModelInfo, 'inputUsdPer1M' | 'outputUsdPer1M'>,
  usage: TokenUsage,
): number | null {
  if (model.inputUsdPer1M === null || model.outputUsdPer1M === null) return null;
  return (
    (usage.inputTokens * model.inputUsdPer1M + usage.outputTokens * model.outputUsdPer1M) /
    1_000_000
  );
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tổng chi phí của các lượt biết giá. */
  costUsd: number;
  calls: number;
  /** Số lượt không ước tính được chi phí (model chưa có giá). */
  unpricedCalls: number;
}

export interface MonthUsage {
  month: string;
  models: Record<ModelRef, ModelUsage>;
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

export function budgetStatus(usage: MonthUsage, budget: BudgetSetting): BudgetStatus {
  const all = Object.values(usage.models);
  const spentUsd = all.reduce((s, m) => s + m.costUsd, 0);
  const incomplete = all.some((m) => m.unpricedCalls > 0);
  const limit = budget.monthlyUsd;
  const level: BudgetLevel =
    limit === null
      ? 'none'
      : spentUsd >= limit
        ? 'over'
        : spentUsd >= limit * budget.warnAt
          ? 'warn'
          : 'ok';
  return { month: usage.month, spentUsd, limitUsd: limit, level, incomplete };
}

export interface UsageLedger {
  /** Ghi một lượt; trả về chi phí ước tính của lượt (null nếu chưa biết giá). */
  record(ref: ModelRef, usage: TokenUsage, costUsd: number | null): void;
  month(month?: string): MonthUsage;
}

export function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function addTo(month: MonthUsage, ref: ModelRef, usage: TokenUsage, costUsd: number | null): void {
  const m = (month.models[ref] ??= {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    calls: 0,
    unpricedCalls: 0,
  });
  m.inputTokens += Math.max(0, Math.round(usage.inputTokens));
  m.outputTokens += Math.max(0, Math.round(usage.outputTokens));
  m.calls += 1;
  if (costUsd === null) m.unpricedCalls += 1;
  else m.costUsd += costUsd;
}

export function createFileUsageLedger(
  dir: string,
  now: () => Date = () => new Date(),
): UsageLedger {
  const cache = new Map<string, MonthUsage>();
  const fileOf = (month: string): string => join(dir, `${month}.json`);
  const load = (month: string): MonthUsage => {
    const cached = cache.get(month);
    if (cached) return cached;
    let value: MonthUsage = { month, models: {} };
    try {
      const raw = JSON.parse(readFileSync(fileOf(month), 'utf8')) as MonthUsage;
      if (raw && typeof raw.models === 'object') value = { month, models: raw.models };
    } catch {
      // chưa có file
    }
    cache.set(month, value);
    return value;
  };
  return {
    record(ref, usage, costUsd) {
      const month = load(monthKey(now()));
      addTo(month, ref, usage, costUsd);
      try {
        mkdirSync(dir, { recursive: true });
        const tmp = `${fileOf(month.month)}.tmp`;
        writeFileSync(tmp, JSON.stringify(month, null, 2), 'utf8');
        renameSync(tmp, fileOf(month.month));
      } catch (err) {
        console.error('[usage] không ghi được sổ chi phí:', err);
      }
    },
    month: (m) => structuredClone(load(m ?? monthKey(now()))),
  };
}

export function memoryUsageLedger(now: () => Date = () => new Date()): UsageLedger {
  const months = new Map<string, MonthUsage>();
  const get = (m: string): MonthUsage => {
    let v = months.get(m);
    if (!v) months.set(m, (v = { month: m, models: {} }));
    return v;
  };
  return {
    record: (ref, usage, cost) => addTo(get(monthKey(now())), ref, usage, cost),
    month: (m) => structuredClone(get(m ?? monthKey(now()))),
  };
}
