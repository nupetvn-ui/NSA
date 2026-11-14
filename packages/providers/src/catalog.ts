/**
 * File dữ liệu nhà cung cấp (hãng + model + giá + thông tin dữ liệu).
 *
 * Bản gốc đóng gói kèm app (`catalog.json`). Bản mới hơn có thể đặt ở thư mục dữ liệu của app
 * (tải về như adapter) — NSA dùng bản có `version` mới hơn nếu nó hợp lệ, nên cập nhật danh sách
 * hãng không cần ra bản app mới.
 */
import bundled from './catalog.json' with { type: 'json' };

import type {
  ApiStandard,
  TaskKind,
  ModelInfo,
  ProviderInfo,
  Catalog,
  ModelRef,
  CustomProvider,
} from '@nsa/core';
export type {
  ApiStandard,
  TaskKind,
  ToolCalling,
  CliId,
  CliPairStatus,
  CliPair,
  ModelInfo,
  ProviderField,
  ProviderData,
  ProviderInfo,
  Catalog,
  ModelRef,
  CustomProvider,
} from '@nsa/core';
export const TASK_KINDS: TaskKind[] = ['main', 'background', 'vision', 'embedding', 'channel'];

export function modelRef(providerId: string, modelId: string): ModelRef {
  return `${providerId}/${modelId}`;
}

export function parseModelRef(ref: ModelRef): { providerId: string; modelId: string } | null {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { providerId: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

export const CUSTOM_PREFIX = 'custom-';

/**
 * Đoán năng lực của model người dùng tự gõ tên (Ollama, LM Studio, địa chỉ tự khai báo) theo tên:
 * `*embed*` → embedding; `llava`, `*vision*`, `*-vl`, `pixtral`… → nhìn được ảnh. Đoán sai thì người
 * dùng chỉnh được ở màn hình Nhà cung cấp (model chính / dự phòng theo việc).
 */
export function guessLocalModel(id: string): Pick<ModelInfo, 'kind' | 'tasks' | 'vision'> {
  if (/embed/i.test(id)) return { kind: 'embedding', tasks: ['embedding'], vision: null };
  const vision =
    /llava|vision|(^|[-_:.])vl([-_:.d]|$)|pixtral|minicpm-v|moondream|gemma3|internvl|qwen2.5vl/i.test(
      id,
    );
  return {
    kind: 'chat',
    tasks: vision ? ['main', 'background', 'channel', 'vision'] : ['main', 'background', 'channel'],
    vision: vision ? true : null,
  };
}

export function customToProvider(custom: CustomProvider): ProviderInfo {
  return {
    id: custom.id,
    name: custom.name,
    group: 'custom',
    keyRequired: false,
    standard: custom.standard,
    endpoints: { [custom.standard]: custom.baseUrl },
    data: {
      serverLocation: null,
      training: null,
      tier: 'paid',
      warning: 'Nhà cung cấp tự khai báo — NSA không biết dữ liệu được gửi đi đâu.',
      sources: [],
    },
    cli: {},
    models: custom.models.map((id) => ({
      id,
      name: id,
      ...guessLocalModel(id),
      inputUsdPer1M: null,
      outputUsdPer1M: null,
      freeTier: null,
      toolCalling: custom.toolCallingStable ? ('stable' as const) : ('documented' as const),
    })),
  };
}

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** Kiểm cấu trúc file dữ liệu; trả về danh sách lỗi (rỗng = hợp lệ). */
export function validateCatalog(value: unknown): string[] {
  const errors: string[] = [];
  const c = value as Partial<Catalog> | null;
  if (!c || typeof c !== 'object') return ['không phải object'];
  if (c.schema !== 1) errors.push(`schema ${String(c.schema)} không hỗ trợ`);
  if (typeof c.version !== 'string') errors.push('thiếu version');
  if (!Array.isArray(c.providers)) return [...errors, 'thiếu providers'];
  const seen = new Set<string>();
  for (const p of c.providers) {
    const where = `nhà cung cấp ${String(p?.id)}`;
    if (!p || typeof p.id !== 'string' || !ID.test(p.id)) {
      errors.push(`${where}: id không hợp lệ`);
      continue;
    }
    if (seen.has(p.id)) errors.push(`${where}: trùng id`);
    seen.add(p.id);
    if (p.standard !== 'openai' && p.standard !== 'anthropic')
      errors.push(`${where}: standard sai`);
    const url = p.endpoints?.[p.standard];
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      errors.push(`${where}: thiếu địa chỉ cho chuẩn ${p.standard}`);
    } else if (url.startsWith('http://') && p.group !== 'local') {
      errors.push(`${where}: địa chỉ không mã hoá (http) chỉ cho phép với máy cục bộ`);
    }
    if (!p.data || !Array.isArray(p.data.sources)) errors.push(`${where}: thiếu thông tin dữ liệu`);
    if (!Array.isArray(p.models)) errors.push(`${where}: thiếu models`);
    for (const m of p.models ?? []) {
      if (typeof m.id !== 'string' || !m.id) errors.push(`${where}: model thiếu id`);
      for (const price of [m.inputUsdPer1M, m.outputUsdPer1M]) {
        if (price !== null && (typeof price !== 'number' || price < 0)) {
          errors.push(`${where}/${m.id}: giá không hợp lệ`);
        }
      }
    }
  }
  return errors;
}

export function bundledCatalog(): Catalog {
  return bundled as Catalog;
}

/** So phiên bản dạng `2026.11.12` (từng phần là số). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Chọn file dữ liệu: bản cập nhật (tải về) nếu hợp lệ và mới hơn bản đóng gói, không thì bản gốc.
 * Trả về kèm lý do nếu bản cập nhật bị bỏ qua.
 */
export function pickCatalog(update: unknown): { catalog: Catalog; ignored?: string } {
  const base = bundledCatalog();
  if (update === undefined || update === null) return { catalog: base };
  const errors = validateCatalog(update);
  if (errors.length) return { catalog: base, ignored: errors.slice(0, 3).join('; ') };
  const candidate = update as Catalog;
  if (compareVersions(candidate.version, base.version) <= 0) {
    return { catalog: base, ignored: `bản ${candidate.version} không mới hơn ${base.version}` };
  }
  return { catalog: candidate };
}

/** Thay `{field}` trong địa chỉ bằng giá trị người dùng nhập; thiếu thì trả null. */
export function resolveEndpoint(
  provider: ProviderInfo,
  standard: ApiStandard,
  fields: Record<string, string> = {},
): string | null {
  const template = provider.endpoints[standard];
  if (!template) return null;
  let missing = false;
  const url = template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const value = fields[name]?.trim();
    if (!value || !/^[\w.-]+$/.test(value)) {
      missing = true;
      return '';
    }
    return value;
  });
  return missing ? null : url.replace(/\/+$/, '');
}

export function findModel(
  providers: ProviderInfo[],
  ref: ModelRef,
): { provider: ProviderInfo; model: ModelInfo } | null {
  const parsed = parseModelRef(ref);
  if (!parsed) return null;
  const provider = providers.find((p) => p.id === parsed.providerId);
  if (!provider) return null;
  const model = provider.models.find((m) => m.id === parsed.modelId);
  if (model) return { provider, model };
  // Model lấy từ máy chủ (Ollama…) hoặc người dùng gõ tên: chưa biết năng lực, chưa biết giá.
  if (provider.modelsFromServer || provider.group === 'custom') {
    return {
      provider,
      model: {
        id: parsed.modelId,
        name: parsed.modelId,
        ...guessLocalModel(parsed.modelId),
        inputUsdPer1M: provider.group === 'local' ? 0 : null,
        outputUsdPer1M: provider.group === 'local' ? 0 : null,
        freeTier: null,
        toolCalling: 'documented',
      },
    };
  }
  return null;
}
