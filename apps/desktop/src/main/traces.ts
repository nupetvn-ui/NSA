import { join } from 'node:path';
import type { TraceKind, TraceQuery, TraceStatus, TracesIpcContract } from '@nsa/core';
import { createTraceIndex, type TraceIndex } from '@nsa/traces';

export type TracesHandlers = {
  [C in keyof TracesIpcContract]: (
    ...args: TracesIpcContract[C]['args']
  ) => TracesIpcContract[C]['result'] | Promise<TracesIpcContract[C]['result']>;
};

export interface TracesSetup {
  index: TraceIndex;
  handlers: TracesHandlers;
  close(): void;
}

/**
 * Traces (ADR-0018): chỉ mục SQLite dựng lại được từ nhật ký JSON Lines. Dựng nền lúc khởi động;
 * mỗi lần giao diện hỏi, đọc thêm phần nhật ký mới nhưng chỉ chờ tối đa `waitMs` để không treo.
 */
export function setupTraces(options: {
  userData: string;
  /** Bộ che key của nhà cung cấp (key đang lưu không bao giờ hiện trong Traces). */
  redact: (text: string) => string;
  monthCostUsd: () => number | null;
  waitMs?: number;
}): TracesSetup {
  const index = createTraceIndex({
    auditDir: join(options.userData, 'audit'),
    dbPath: join(options.userData, 'traces', 'index.sqlite'),
    redact: options.redact,
    monthCostUsd: options.monthCostUsd,
  });
  const waitMs = options.waitMs ?? 700;
  const refresh = async (): Promise<void> => {
    const run = index.sync().catch((err: unknown) => console.error('[traces] chỉ mục lỗi:', err));
    await Promise.race([run, new Promise<void>((resolve) => setTimeout(resolve, waitMs))]);
  };
  void index.sync().catch((err: unknown) => console.error('[traces] chỉ mục lỗi:', err));
  return {
    index,
    close: () => index.close(),
    handlers: {
      'traces:list': async (query) => {
        await refresh();
        return index.list(cleanQuery(query));
      },
      'traces:get': async (id) => {
        await refresh();
        return index.get(String(id));
      },
      'traces:filters': () => index.filters(),
      'traces:status': () => index.status(),
      'traces:reindex': () => index.reindex(),
    },
  };
}

/** Dữ liệu từ giao diện là đầu vào không tin cậy: chỉ giữ trường đúng kiểu. */
function cleanQuery(query: unknown): TraceQuery {
  const q = (typeof query === 'object' && query !== null ? query : {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 && v.length <= 400 ? v : undefined;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  const day = (v: unknown): string | undefined => {
    const s = str(v);
    return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
  };
  const status = str(q['status']);
  const kind = str(q['kind']);
  return {
    ...(day(q['from']) ? { from: day(q['from']) as string } : {}),
    ...(day(q['to']) ? { to: day(q['to']) as string } : {}),
    ...(str(q['agentId']) ? { agentId: str(q['agentId']) as string } : {}),
    ...(str(q['pluginId']) ? { pluginId: str(q['pluginId']) as string } : {}),
    ...(status && ['running', 'ok', 'error', 'cancelled', 'denied'].includes(status)
      ? { status: status as TraceStatus }
      : {}),
    ...(kind && ['turn', 'task', 'plugin', 'system'].includes(kind)
      ? { kind: kind as TraceKind }
      : {}),
    ...(str(q['text']) ? { text: str(q['text']) as string } : {}),
    ...(str(q['teamTaskId']) ? { teamTaskId: str(q['teamTaskId']) as string } : {}),
    ...(num(q['limit']) !== undefined ? { limit: num(q['limit']) as number } : {}),
    ...(num(q['offset']) !== undefined ? { offset: num(q['offset']) as number } : {}),
  };
}
