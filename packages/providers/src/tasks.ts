/**
 * Chọn model theo loại việc: mỗi loại có model chính + dự phòng (người dùng chỉnh được).
 * Không chỉnh thì NSA tự xếp: model hợp loại việc, của hãng đã có key, rẻ trước.
 */
import type { ModelInfo, ModelRef, ProviderInfo, TaskKind } from './catalog.js';
import { findModel, modelRef } from './catalog.js';
import type { ProviderSettings } from './settings.js';

export const TASK_LABELS: Record<TaskKind, string> = {
  main: 'Việc chính (agent)',
  background: 'Việc nền (chắt lọc bộ nhớ, tóm tắt)',
  vision: 'Nhìn ảnh / video',
  embedding: 'Embedding (tìm kiếm bộ nhớ)',
  channel: 'Kênh chat (Telegram, Zalo…)',
};

/** Giá ước tính để xếp: tổng giá vào + ra; chưa biết giá thì xếp sau cùng. */
export function priceRank(model: ModelInfo): number {
  if (model.inputUsdPer1M === null || model.outputUsdPer1M === null) return Number.MAX_VALUE;
  return model.inputUsdPer1M + model.outputUsdPer1M;
}

export interface ChainOptions {
  /** Việc cần gọi tool (sửa file, chạy lệnh): chỉ nhận model đã đánh dấu gọi tool ổn định. */
  needsTools?: boolean;
  /** Việc có ảnh: chỉ nhận model nhìn được ảnh. */
  needsVision?: boolean;
}

export interface ChainEntry {
  ref: ModelRef;
  provider: ProviderInfo;
  model: ModelInfo;
  /** Người dùng chọn (true) hay NSA tự thêm (false). */
  chosen: boolean;
}

/**
 * Danh sách model nên thử cho một loại việc, theo thứ tự.
 * `usable(providerId)` cho biết hãng đã sẵn sàng (có key, hoặc máy cục bộ đã bật).
 */
export function resolveTaskChain(
  task: TaskKind,
  settings: ProviderSettings,
  providers: ProviderInfo[],
  usable: (providerId: string) => boolean,
  options: ChainOptions = {},
): ChainEntry[] {
  const needsVision = options.needsVision ?? task === 'vision';
  const fits = (model: ModelInfo): boolean => {
    if (task === 'embedding' ? model.kind !== 'embedding' : model.kind !== 'chat') return false;
    if (options.needsTools && model.toolCalling !== 'stable') return false;
    if (needsVision && model.vision !== true) return false;
    return true;
  };

  const out: ChainEntry[] = [];
  const add = (ref: ModelRef, chosen: boolean): void => {
    if (out.some((e) => e.ref === ref)) return;
    const found = findModel(providers, ref);
    if (!found || !usable(found.provider.id) || !fits(found.model)) return;
    out.push({ ref, ...found, chosen });
  };

  const setting = settings.tasks[task];
  if (setting?.primary) add(setting.primary, true);
  for (const ref of setting?.fallbacks ?? []) add(ref, true);

  // NSA tự thêm phần còn lại làm dự phòng: model hợp loại việc, rẻ trước.
  const auto = providers
    .filter((p) => usable(p.id))
    .flatMap((p) => p.models.filter((m) => m.tasks.includes(task)).map((m) => ({ p, m })))
    .sort((a, b) => priceRank(a.m) - priceRank(b.m));
  for (const { p, m } of auto) add(modelRef(p.id, m.id), false);
  return out;
}
