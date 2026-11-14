/**
 * ProviderHub: nối file dữ liệu hãng, kho khoá, cài đặt, adapter `api`, CLI được cấp key và
 * sổ chi phí. Chạy trong tiến trình main; giao diện chỉ nhận `ProvidersView` (không có key).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AgentAdapter, AgentEvent, Capabilities } from '@nsa/adapter-sdk';
import {
  createApiAdapter,
  createApiClient,
  createStreamRedactor,
  type ApiSessionStore,
  type ChatMessage,
  type FetchLike,
} from '@nsa/adapter-api';
import {
  CUSTOM_PREFIX,
  TASK_KINDS,
  customToProvider,
  findModel,
  modelRef,
  parseModelRef,
  resolveEndpoint,
  type Catalog,
  type CliId,
  type CustomProvider,
  type ModelInfo,
  type ModelRef,
  type ProviderInfo,
  type TaskKind,
} from './catalog.js';
import { buildPairingLaunch, pairingAllowed, pairingStatus } from './cli-env.js';
import { budgetStatus, estimateCostUsd, type BudgetStatus, type UsageLedger } from './cost.js';
import { providerSecretName, redactSecrets, type SecretStore } from './secrets.js';
import type { ProviderSettings, SettingsStore } from './settings.js';
import { TASK_LABELS, resolveTaskChain, type ChainOptions } from './tasks.js';
import type { UsageRow, ProvidersView, ProviderSettingsPatch, CheckResult } from '@nsa/core';
export type {
  ModelView,
  ProviderView,
  TaskView,
  UsageRow,
  ProvidersView,
  ProviderSettingsPatch,
  CheckResult,
} from '@nsa/core';

export const API_AGENT_PREFIX = 'api:';
export const CLI_NAMES: Record<CliId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** Mã agent của một model gọi thẳng qua API. */
export function apiAgentId(ref: ModelRef): string {
  return `${API_AGENT_PREFIX}${ref}`;
}
/** Mã agent của một CLI chạy bằng key của hãng. */
export function pairedAgentId(cli: CliId, ref: ModelRef): string {
  return `${cli}+${ref}`;
}

// ---------------------------------------------------------------- dữ liệu cho giao diện

// ---------------------------------------------------------------- lịch sử phiên API

/** Lưu lịch sử hội thoại của adapter `api` ra file (giống conversations.json — không có key). */
export function createFileApiSessionStore(file: string, limit = 200): ApiSessionStore {
  let cache: Record<string, ChatMessage[]> | null = null;
  const load = (): Record<string, ChatMessage[]> => {
    if (cache) return cache;
    try {
      cache =
        (JSON.parse(readFileSync(file, 'utf8')) as { sessions?: Record<string, ChatMessage[]> })
          .sessions ?? {};
    } catch {
      cache = {};
    }
    return cache;
  };
  return {
    get: (id) => load()[id],
    set(id, messages) {
      const all = load();
      delete all[id];
      all[id] = messages;
      const ids = Object.keys(all);
      for (const old of ids.slice(0, Math.max(0, ids.length - limit))) delete all[old];
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, sessions: all }), 'utf8');
        renameSync(`${file}.tmp`, file);
      } catch (err) {
        console.error('[api-sessions] không lưu được:', err);
      }
    },
  };
}

// ---------------------------------------------------------------- hub

/** Tham số hub truyền khi nhờ lắp ráp một adapter CLI (lệnh thay thế trong test, model của cặp). */
export interface CliAdapterParams {
  command?: string;
  prefixArgs?: string[];
  model?: string;
}

/**
 * Hub không import adapter của từng CLI (ADR-0015): nơi lắp ghép (`apps/desktop`) đăng ký hàm
 * tạo adapter cho từng CLI — nhờ vậy đổi / cập nhật adapter không đụng gói này.
 */
export type CliAdapterFactories = Record<CliId, (params: CliAdapterParams) => AgentAdapter>;

export interface ProviderHubOptions {
  /** Hàm tạo adapter cho các CLI có thể ghép với key của hãng. */
  cliAdapters: CliAdapterFactories;
  catalog: Catalog;
  settings: SettingsStore;
  secrets: SecretStore;
  ledger: UsageLedger;
  /** Thư mục dữ liệu của NSA (thư mục cấu hình riêng cho CLI được cấp key nằm trong đây). */
  dataDir: string;
  sessions?: ApiSessionStore;
  fetch?: FetchLike;
  /** Lệnh CLI thay thế (test). */
  cliCommands?: Partial<Record<CliId, { command: string; prefixArgs?: string[] }>>;
  catalogNote?: string;
}

export class ProviderHub {
  readonly #o: ProviderHubOptions;
  #settings: ProviderSettings;
  #adapterCache = new Map<string, AgentAdapter>();

  constructor(options: ProviderHubOptions) {
    this.#o = options;
    this.#settings = options.settings.load();
  }

  get settings(): ProviderSettings {
    return structuredClone(this.#settings);
  }

  providers(): ProviderInfo[] {
    return [...this.#o.catalog.providers, ...this.#settings.custom.map(customToProvider)];
  }

  provider(id: string): ProviderInfo | undefined {
    return this.providers().find((p) => p.id === id);
  }

  #key(providerId: string): string | undefined {
    return this.#o.secrets.get(providerSecretName(providerId));
  }

  /** Hãng dùng được: có key; hoặc không cần key và người dùng đã bật (máy cục bộ / tự khai báo). */
  usable(providerId: string): boolean {
    const provider = this.provider(providerId);
    if (!provider) return false;
    if (provider.keyRequired)
      return this.#key(providerId) !== undefined && this.#baseUrl(provider) !== null;
    if (provider.group === 'custom') return this.#baseUrl(provider) !== null;
    return this.#settings.providers[providerId]?.enabled === true;
  }

  #baseUrl(provider: ProviderInfo, standard = provider.standard): string | null {
    return resolveEndpoint(provider, standard, this.#settings.providers[provider.id]?.fields);
  }

  #models(provider: ProviderInfo): ModelInfo[] {
    const extra = this.#settings.providers[provider.id]?.extraModels ?? [];
    const known = new Set(provider.models.map((m) => m.id));
    const added = extra
      .filter((id) => !known.has(id))
      .map((id) => findModel([provider], modelRef(provider.id, id))?.model)
      .filter((m): m is ModelInfo => m !== undefined);
    return [...provider.models, ...added];
  }

  /** Danh sách hãng kèm model (gồm model thêm tay) — dùng cho định tuyến. */
  #providersWithModels(): ProviderInfo[] {
    return this.providers().map((p) => ({ ...p, models: this.#models(p) }));
  }

  // ---- key

  setKey(providerId: string, key: string): void {
    const provider = this.provider(providerId);
    if (!provider) throw new Error(`Không có nhà cung cấp "${providerId}"`);
    this.#o.secrets.set(providerSecretName(providerId), key);
    this.#adapterCache.clear();
  }

  deleteKey(providerId: string): void {
    this.#o.secrets.delete(providerSecretName(providerId));
    this.#adapterCache.clear();
  }

  /** Mọi key đang lưu — để che khỏi văn bản trước khi ghi ra (nhật ký, lỗi). */
  secretValues(): string[] {
    return this.#o.secrets.values();
  }

  redact(text: string): string {
    return redactSecrets(text, this.secretValues());
  }

  // ---- cài đặt

  update(patch: ProviderSettingsPatch): void {
    const s = this.#settings;
    const state = (id: string) => (s.providers[id] ??= {});
    switch (patch.kind) {
      case 'fields':
        state(patch.providerId).fields = patch.fields;
        break;
      case 'enabled':
        state(patch.providerId).enabled = patch.enabled;
        break;
      case 'extraModels':
        state(patch.providerId).extraModels = [
          ...new Set(patch.models.map((m) => m.trim()).filter((m) => /^[\w.:/@-]{1,128}$/.test(m))),
        ];
        break;
      case 'task':
        s.tasks[patch.task] = {
          ...(patch.setting.primary ? { primary: patch.setting.primary } : {}),
          fallbacks: patch.setting.fallbacks.filter((r) => parseModelRef(r) !== null),
        };
        break;
      case 'budget':
        s.budget = {
          monthlyUsd: patch.monthlyUsd !== null && patch.monthlyUsd > 0 ? patch.monthlyUsd : null,
          warnAt: patch.warnAt ?? s.budget.warnAt,
          stopAtLimit: patch.stopAtLimit ?? s.budget.stopAtLimit,
        };
        break;
      case 'pairing': {
        const found = findModel(this.#providersWithModels(), patch.model);
        if (patch.on) {
          if (!found || !pairingAllowed(found.provider, patch.cli)) {
            throw new Error('Cặp CLI + hãng này chưa được tài liệu chính thức xác nhận');
          }
          if (!s.pairings.some((p) => p.cli === patch.cli && p.model === patch.model)) {
            s.pairings.push({ cli: patch.cli, model: patch.model });
          }
        } else {
          s.pairings = s.pairings.filter((p) => !(p.cli === patch.cli && p.model === patch.model));
        }
        break;
      }
      case 'custom': {
        const c = patch.provider;
        if (!/^https?:\/\/[^\s]+$/.test(c.baseUrl)) throw new Error('Địa chỉ không hợp lệ');
        if (
          c.baseUrl.startsWith('http://') &&
          !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(c.baseUrl)
        ) {
          throw new Error('Địa chỉ http (không mã hoá) chỉ cho phép với máy này; hãy dùng https');
        }
        const id = c.id.startsWith(CUSTOM_PREFIX) ? c.id : `${CUSTOM_PREFIX}${slug(c.name) || 'x'}`;
        const clean: CustomProvider = {
          id,
          name: c.name.trim() || id,
          standard: c.standard === 'anthropic' ? 'anthropic' : 'openai',
          baseUrl: c.baseUrl.trim().replace(/\/+$/, ''),
          models: [...new Set(c.models.map((m) => m.trim()).filter(Boolean))],
          ...(c.toolCallingStable ? { toolCallingStable: true } : {}),
        };
        if (!clean.models.length) throw new Error('Cần ít nhất một tên model');
        s.custom = [...s.custom.filter((x) => x.id !== id), clean];
        break;
      }
      case 'removeCustom':
        s.custom = s.custom.filter((x) => x.id !== patch.providerId);
        s.pairings = s.pairings.filter(
          (p) => parseModelRef(p.model)?.providerId !== patch.providerId,
        );
        this.deleteKey(patch.providerId);
        break;
    }
    this.#adapterCache.clear();
    this.#o.settings.save(s);
  }

  // ---- kiểm tra

  /** Nút "Kiểm tra": gọi `GET /models`, không được thì gửi một câu ngắn cho model rẻ nhất. */
  async check(providerId: string): Promise<CheckResult> {
    const provider = this.provider(providerId);
    if (!provider) return { ok: false, message: 'Không có nhà cung cấp này' };
    const key = this.#key(providerId);
    if (provider.keyRequired && !key) return { ok: false, message: 'Chưa có key' };
    const baseUrl = this.#baseUrl(provider);
    if (!baseUrl) return { ok: false, message: 'Thiếu thông tin địa chỉ (ví dụ Workspace ID)' };
    const client = createApiClient(
      {
        standard: provider.standard,
        baseUrl,
        label: provider.name,
        ...(key ? { apiKey: key } : {}),
      },
      this.#o.fetch,
    );
    const signal = AbortSignal.timeout(20_000);
    let result: CheckResult;
    try {
      const models = await client.listModels(signal);
      result = {
        ok: true,
        message: `Kết nối được — hãng trả về ${models.length} model.`,
        models: models.slice(0, 200),
      };
      if (provider.modelsFromServer && models.length) {
        const state = (this.#settings.providers[providerId] ??= {});
        state.extraModels = [...new Set([...(state.extraModels ?? []), ...models.slice(0, 50)])];
      }
    } catch (listError) {
      const model = this.#models(provider)
        .filter((m) => m.kind === 'chat')
        .sort((a, b) => (a.inputUsdPer1M ?? 99) - (b.inputUsdPer1M ?? 99))[0];
      if (!model) {
        result = {
          ok: false,
          message: this.redact(String((listError as Error).message ?? listError)),
        };
      } else {
        try {
          await client.chat({
            model: model.id,
            messages: [{ role: 'user', content: 'Reply with OK.' }],
            maxTokens: 5,
            signal,
          });
          result = {
            ok: true,
            message: `Kết nối được (đã gửi thử một câu ngắn cho ${model.name}).`,
          };
        } catch (err) {
          result = {
            ok: false,
            message: this.redact(err instanceof Error ? err.message : String(err)),
          };
        }
      }
    }
    const state = (this.#settings.providers[providerId] ??= {});
    state.lastCheck = { at: new Date().toISOString(), ok: result.ok, message: result.message };
    this.#o.settings.save(this.#settings);
    return result;
  }

  // ---- định tuyến theo việc

  taskChain(task: TaskKind, options: ChainOptions = {}) {
    return resolveTaskChain(
      task,
      this.#settings,
      this.#providersWithModels(),
      (id) => this.usable(id),
      options,
    );
  }

  /** Model API hiện trong danh sách agent của chat. */
  chatModels(): ModelRef[] {
    if (this.#settings.chatModels) return this.#settings.chatModels;
    const refs: ModelRef[] = [];
    for (const task of ['main', 'background'] as TaskKind[]) {
      const primary = this.#settings.tasks[task]?.primary;
      if (primary) refs.push(primary);
    }
    for (const provider of this.#providersWithModels()) {
      if (!this.usable(provider.id)) continue;
      // Mọi model hợp việc chính; hãng chỉ có model thêm tay (Ollama…) thì lấy hết model chat.
      const chat = provider.models.filter((m) => m.kind === 'chat');
      const main = chat.filter((m) => m.tasks.includes('main'));
      for (const m of main.length ? main : chat) refs.push(modelRef(provider.id, m.id));
    }
    return [...new Set(refs)].filter((ref) => {
      const found = findModel(this.#providersWithModels(), ref);
      return found !== null && found.model.kind === 'chat' && this.usable(found.provider.id);
    });
  }

  /** Hàm tính embedding cho một model embedding (chuẩn OpenAI `/embeddings`). */
  embedClient(
    ref: ModelRef,
  ): ((texts: string[], signal?: AbortSignal) => Promise<number[][]>) | undefined {
    const found = findModel(this.#providersWithModels(), ref);
    if (!found || found.model.kind !== 'embedding') return undefined;
    const { provider, model } = found;
    const baseUrl = this.#baseUrl(provider);
    if (!baseUrl) return undefined;
    return (texts, signal) => {
      const key = this.#key(provider.id);
      const client = createApiClient(
        {
          standard: provider.standard,
          baseUrl,
          label: provider.name,
          ...(key ? { apiKey: key } : {}),
        },
        this.#o.fetch,
      );
      return client.embed(model.id, texts, signal);
    };
  }

  /** Adapter `api` cho một model (dùng lại giữa các lượt). */
  apiAdapter(ref: ModelRef): AgentAdapter | undefined {
    const id = apiAgentId(ref);
    const cached = this.#adapterCache.get(id);
    if (cached) return cached;
    const found = findModel(this.#providersWithModels(), ref);
    if (!found) return undefined;
    const { provider, model } = found;
    const baseUrl = this.#baseUrl(provider);
    if (!baseUrl) return undefined;
    const adapter = createApiAdapter({
      id,
      displayName: `${model.name} · ${shortName(provider)}`,
      standard: provider.standard,
      baseUrl,
      model: model.id,
      getKey: () => this.#key(provider.id),
      keyRequired: provider.keyRequired,
      providerName: provider.name,
      pricing: { inputUsdPer1M: model.inputUsdPer1M, outputUsdPer1M: model.outputUsdPer1M },
      vision: model.vision === true,
      toolCallingStable: model.toolCalling === 'stable',
      ...(this.#o.sessions ? { sessions: this.#o.sessions } : {}),
      ...(this.#o.fetch ? { fetch: this.#o.fetch } : {}),
    });
    this.#adapterCache.set(id, adapter);
    return adapter;
  }

  /** CLI sẵn có chạy bằng key của hãng (theo cặp người dùng đã bật). */
  pairedAdapter(cli: CliId, ref: ModelRef): AgentAdapter | undefined {
    const id = pairedAgentId(cli, ref);
    const cached = this.#adapterCache.get(id);
    if (cached) return cached;
    const found = findModel(this.#providersWithModels(), ref);
    if (!found || !pairingAllowed(found.provider, cli)) return undefined;
    const { provider, model } = found;
    const launch = (): ReturnType<typeof buildPairingLaunch> =>
      buildPairingLaunch(cli, {
        provider,
        model: model.id,
        key: this.#key(provider.id),
        ...(this.#settings.providers[provider.id]?.fields
          ? { fields: this.#settings.providers[provider.id]?.fields as Record<string, string> }
          : {}),
        homeDir: join(this.#o.dataDir, 'cli-homes'),
        ...(process.env['OPENCODE_CONFIG_CONTENT']
          ? { existingOpenCodeConfig: process.env['OPENCODE_CONFIG_CONTENT'] }
          : {}),
      });
    const probe = launch();
    const cmd = this.#o.cliCommands?.[cli];
    const cliOptions = cmd
      ? { command: cmd.command, ...(cmd.prefixArgs ? { prefixArgs: cmd.prefixArgs } : {}) }
      : {};
    const base = this.#o.cliAdapters[cli]({
      ...cliOptions,
      ...(cli !== 'claude' && probe?.cliModel ? { model: probe.cliModel } : {}),
    });
    const toolsStable = model.toolCalling === 'stable';
    const adapter = withProviderKey(base, {
      id,
      displayName: `${CLI_NAMES[cli]} · ${model.name}`,
      launch: () => launch()?.env,
      toolsStable,
      redact: (t) => this.redact(t),
      secrets: () => this.secretValues(),
      providerName: provider.name,
    });
    this.#adapterCache.set(id, adapter);
    return adapter;
  }

  /** Mọi agent do nhà cung cấp tạo ra: model API trong chat + CLI được cấp key. */
  agents(): AgentAdapter[] {
    const out: AgentAdapter[] = [];
    for (const ref of this.chatModels()) {
      const a = this.apiAdapter(ref);
      if (a) out.push(a);
    }
    for (const p of this.#settings.pairings) {
      const found = findModel(this.#providersWithModels(), p.model);
      if (!found || !this.usable(found.provider.id)) continue;
      const a = this.pairedAdapter(p.cli, p.model);
      if (a) out.push(a);
    }
    return out;
  }

  /** Agent này dùng hãng/model nào (để kiểm chính sách, ghi chi phí). */
  agentModel(agentId: string): { ref: ModelRef; providerId: string; model: string } | undefined {
    const ref = agentId.startsWith(API_AGENT_PREFIX)
      ? agentId.slice(API_AGENT_PREFIX.length)
      : /^(claude|codex|opencode)\+/.test(agentId)
        ? agentId.slice(agentId.indexOf('+') + 1)
        : undefined;
    const parsed = ref ? parseModelRef(ref) : null;
    return ref && parsed
      ? { ref, providerId: parsed.providerId, model: parsed.modelId }
      : undefined;
  }

  /** Agent dự phòng cho một agent API khi hãng lỗi: chuỗi model của việc chính. */
  fallbackAgents(agentId: string): string[] {
    const own = this.agentModel(agentId);
    if (!own) return [];
    return this.taskChain('main')
      .map((e) => apiAgentId(e.ref))
      .filter((id) => id !== agentId);
  }

  // ---- chi phí

  /** Ghi token của một lượt; trả về mức hạn mức trước và sau khi ghi. */
  recordUsage(
    ref: ModelRef,
    usage: { inputTokens: number; outputTokens: number; costUsd?: number },
  ) {
    const before = this.budget();
    const found = findModel(this.#providersWithModels(), ref);
    const cost = found ? estimateCostUsd(found.model, usage) : (usage.costUsd ?? null);
    this.#o.ledger.record(ref, usage, cost);
    const after = this.budget();
    return { before, after, costUsd: cost };
  }

  budget(): BudgetStatus {
    return budgetStatus(this.#o.ledger.month(), this.#settings.budget);
  }

  /** Model trả phí (giá > 0 hoặc chưa biết giá) — dùng để chặn khi vượt hạn mức. */
  isPaid(ref: ModelRef): boolean {
    const found = findModel(this.#providersWithModels(), ref);
    if (!found) return true;
    if (found.provider.group === 'local') return false;
    return found.model.inputUsdPer1M !== 0 || found.model.outputUsdPer1M !== 0;
  }

  // ---- giao diện

  view(): ProvidersView {
    const providers = this.#providersWithModels();
    const month = this.#o.ledger.month();
    const usage: UsageRow[] = Object.entries(month.models).map(([ref, u]) => {
      const found = findModel(providers, ref);
      return {
        ref,
        providerName: found?.provider.name ?? parseModelRef(ref)?.providerId ?? ref,
        modelName: found?.model.name ?? parseModelRef(ref)?.modelId ?? ref,
        ...u,
      };
    });
    return {
      catalogVersion: this.#o.catalog.version,
      catalogCheckedAt: this.#o.catalog.checkedAt,
      ...(this.#o.catalogNote ? { catalogNote: this.#o.catalogNote } : {}),
      keystore: this.#o.secrets.available(),
      providers: providers.map((p) => {
        const state = this.#settings.providers[p.id] ?? {};
        return {
          id: p.id,
          name: p.name,
          group: p.group,
          keyRequired: p.keyRequired,
          ...(p.keyUrl ? { keyUrl: p.keyUrl } : {}),
          standard: p.standard,
          endpoints: p.endpoints,
          fields: p.fields ?? [],
          fieldValues: state.fields ?? {},
          data: p.data,
          keyHint: this.#o.secrets.hint(providerSecretName(p.id)) ?? null,
          usable: this.usable(p.id),
          enabled: state.enabled === true,
          ...(state.lastCheck ? { lastCheck: state.lastCheck } : {}),
          models: p.models.map((m) => ({ ...m, ref: modelRef(p.id, m.id) })),
          cli: (['claude', 'opencode', 'codex'] as CliId[]).map((cli) => ({
            cli,
            status: pairingStatus(p, cli),
            allowed: pairingAllowed(p, cli),
            ...(p.cli[cli]?.note ? { note: p.cli[cli]?.note as string } : {}),
          })),
          ...(p.group === 'custom'
            ? { custom: this.#settings.custom.find((c) => c.id === p.id) as CustomProvider }
            : {}),
        };
      }),
      tasks: TASK_KINDS.map((task) => ({
        task,
        label: TASK_LABELS[task],
        setting: this.#settings.tasks[task] ?? { fallbacks: [] },
        chain: this.taskChain(task).map((e) => ({
          ref: e.ref,
          name: e.model.name,
          providerName: e.provider.name,
          chosen: e.chosen,
        })),
      })),
      pairings: this.#settings.pairings.map((p) => ({
        ...p,
        agentId: pairedAgentId(p.cli, p.model),
      })),
      budget: {
        ...this.budget(),
        warnAt: this.#settings.budget.warnAt,
        stopAtLimit: this.#settings.budget.stopAtLimit,
      },
      usage,
    };
  }
}

/** "Hãng mới" → "hang-moi" (bỏ dấu tiếng Việt). */
function slug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30);
}

function shortName(provider: ProviderInfo): string {
  return provider.name.replace(/\s*\(.*\)\s*$/, '');
}

/**
 * Bọc adapter CLI để chạy bằng key của hãng: thêm biến môi trường theo lượt, đổi mã/tên,
 * che key trong mọi sự kiện, và chỉ cho sửa file khi model gọi tool ổn định.
 * Không có tầng dự phòng PTY: tầng đó không nhận biến môi trường của lượt.
 */
export function withProviderKey(
  base: AgentAdapter,
  options: {
    id: string;
    displayName: string;
    launch: () => Record<string, string> | undefined;
    toolsStable: boolean;
    redact: (text: string) => string;
    /** Các key cần che (cho bộ che theo luồng). */
    secrets: () => string[];
    providerName: string;
  },
): AgentAdapter {
  const clean = (event: AgentEvent): AgentEvent => {
    switch (event.type) {
      case 'error':
      case 'notice':
        return { ...event, message: options.redact(event.message) };
      case 'tool_call':
        return { ...event, input: options.redact(event.input) };
      case 'tool_result':
        return { ...event, output: options.redact(event.output) };
      default:
        return event;
    }
  };
  return {
    id: options.id,
    displayName: options.displayName,
    async detect() {
      const d = await base.detect();
      if (!d.installed) return d;
      if (!options.launch()) {
        return {
          ...d,
          ready: false,
          installed: false,
          note: `Chưa có key ${options.providerName}`,
        };
      }
      // Có key của hãng thì không cần đăng nhập gói thuê bao của CLI.
      const rest = { ...d };
      delete rest.note;
      return { ...rest, ready: true };
    },
    capabilities(): Capabilities {
      const caps = base.capabilities();
      return {
        ...caps,
        tools: caps.tools && options.toolsStable,
        editFiles: caps.editFiles && options.toolsStable,
      };
    },
    run(runOptions, onEvent) {
      const env = options.launch();
      if (!env) {
        onEvent({ type: 'error', code: 'auth', message: `Chưa có key ${options.providerName}` });
        onEvent({ type: 'done', cancelled: false });
        return { cancel: () => undefined, finished: Promise.resolve() };
      }
      // Model chưa gọi tool ổn định: luôn chạy chỉ đọc, kể cả khi cuộc trò chuyện cho sửa file.
      const permission = options.toolsStable ? runOptions.permission : 'read-only';
      // Văn bản stream từng mẩu: che theo luồng (key có thể bị cắt qua nhiều mẩu).
      const streams = new Map<string, ReturnType<typeof createStreamRedactor>>();
      const secrets = options.secrets();
      return base.run({ ...runOptions, permission, env: { ...runOptions.env, ...env } }, (e) => {
        if (e.type === 'text') {
          let r = streams.get(e.id);
          if (!r) streams.set(e.id, (r = createStreamRedactor(secrets)));
          const text = r.push(e.text);
          if (text) onEvent({ ...e, text });
          return;
        }
        if (e.type === 'done') {
          for (const [id, r] of streams) {
            const text = r.flush();
            if (text) onEvent({ type: 'text', id, text });
          }
          streams.clear();
        }
        onEvent(clean(e));
      });
    },
  };
}
