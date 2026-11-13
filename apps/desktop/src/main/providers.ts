/**
 * Nối nhà cung cấp model qua API key vào app (ADR-0009). Không import `electron` ở đây để
 * test quét key chạy được bằng Vitest: bộ mã hoá của hệ điều hành (`safeStorage`) được truyền vào.
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '@nsa/adapter-sdk';
import {
  ModelTaskRunner,
  composePolicies,
  withModelPolicy,
  type AuditEntry,
  type AuditLog,
  type ChatEvent,
  type ConversationStore,
  type IdentityProvider,
  type IpcArgs,
  type IpcEventChannel,
  type IpcEventContract,
  type IpcResult,
  type Policy,
  type ProvidersIpcContract,
} from '@nsa/core';
import {
  ProviderHub,
  apiAgentId,
  createEncryptedFileSecretStore,
  createFileApiSessionStore,
  createFileSettingsStore,
  createFileUsageLedger,
  parseModelRef,
  pickCatalog,
  type OsCipher,
} from '@nsa/providers';

export interface ProvidersSetupOptions {
  userData: string;
  cipher: OsCipher;
  identity: IdentityProvider;
  audit: AuditLog;
  /** Chính sách gốc (bản Cá nhân / bản Doanh nghiệp). */
  basePolicy: Policy;
  /** Danh sách agent đổi (thêm / xoá key, bật cặp CLI) → cập nhật ChatService. */
  onAgentsChanged: (adapters: AgentAdapter[]) => void;
  broadcast: <E extends IpcEventChannel>(channel: E, payload: IpcEventContract[E]) => void;
  /** Lệnh CLI thay thế (test). */
  cliCommands?: ConstructorParameters<typeof ProviderHub>[0]['cliCommands'];
}

type ProvidersHandlers = {
  [C in keyof ProvidersIpcContract]: (...args: IpcArgs<C>) => IpcResult<C> | Promise<IpcResult<C>>;
};

export interface ProvidersSetup {
  hub: ProviderHub;
  runner: ModelTaskRunner;
  /** Chính sách đã ghép: hỏi thêm `model.use` + chặn khi vượt hạn mức (nếu người dùng bật). */
  policy: Policy;
  /** Nhật ký đã bọc: che mọi key đang lưu trước khi ghi. */
  audit: AuditLog;
  /** Bọc nơi lưu cuộc trò chuyện: che key trước khi ghi ra đĩa. */
  wrapStore(store: ConversationStore): ConversationStore;
  agents(): AgentAdapter[];
  /** Gọi cho mọi sự kiện chat (ghi token / chi phí). */
  onChatEvent(event: ChatEvent): void;
  handlers: ProvidersHandlers;
}

type AuditBody = AuditEntry extends infer E
  ? E extends AuditEntry
    ? Omit<E, 'at' | 'actor'>
    : never
  : never;

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

export function setupProviders(options: ProvidersSetupOptions): ProvidersSetup {
  const { userData } = options;
  // File dữ liệu hãng: bản tải về (nếu mới hơn và hợp lệ) hoặc bản đóng gói kèm app.
  const picked = pickCatalog(readJson(join(userData, 'provider-catalog.json')));
  const hub = new ProviderHub({
    catalog: picked.catalog,
    settings: createFileSettingsStore(join(userData, 'providers.json')),
    secrets: createEncryptedFileSecretStore(join(userData, 'secrets.json'), options.cipher),
    ledger: createFileUsageLedger(join(userData, 'usage')),
    sessions: createFileApiSessionStore(join(userData, 'api-sessions.json')),
    dataDir: userData,
    ...(picked.ignored ? { catalogNote: `Bỏ qua file dữ liệu tải về: ${picked.ignored}` } : {}),
    ...(options.cliCommands ? { cliCommands: options.cliCommands } : {}),
  });

  const redactValue = <T>(value: T): T => {
    const json = JSON.stringify(value);
    const clean = hub.redact(json);
    return clean === json ? value : (JSON.parse(clean) as T);
  };

  const audit: AuditLog = {
    record: (entry: AuditEntry) => options.audit.record(redactValue(entry)),
  };
  const log = (body: AuditBody): void => {
    const actor = options.identity.current();
    audit.record({
      ...body,
      at: new Date().toISOString(),
      actor: { id: actor.id, displayName: actor.displayName },
    } as AuditEntry);
  };

  const lookup = (agentId: string) => {
    const m = hub.agentModel(agentId);
    return m ? { providerId: m.providerId, model: m.model, paid: hub.isPaid(m.ref) } : undefined;
  };

  // Vượt hạn mức tự đặt và người dùng chọn "dừng khi vượt": chặn model trả phí.
  const budgetPolicy: Policy = {
    check({ action }) {
      if (action.kind !== 'model.use' || !action.paid) return { decision: 'allow' };
      const settings = hub.settings.budget;
      const status = hub.budget();
      if (settings.stopAtLimit && status.level === 'over') {
        return {
          decision: 'deny',
          reason: `Đã vượt hạn mức chi phí tháng (${status.spentUsd.toFixed(2)} / ${String(status.limitUsd)} USD). Tăng hạn mức hoặc tắt "dừng khi vượt" trong Nhà cung cấp.`,
        };
      }
      return { decision: 'allow' };
    },
  };
  const policy = withModelPolicy(composePolicies(options.basePolicy, budgetPolicy), lookup);

  const recordUsage = (
    ref: string,
    usage: { inputTokens: number; outputTokens: number; costUsd?: number },
  ): void => {
    const { before, after } = hub.recordUsage(ref, usage);
    if (after.limitUsd !== null && after.level !== before.level) {
      if (after.level === 'warn' || after.level === 'over') {
        const alert = { level: after.level, spentUsd: after.spentUsd, limitUsd: after.limitUsd };
        log({
          agentId: `provider:${parseModelRef(ref)?.providerId ?? ref}`,
          type: 'budget',
          ...alert,
        });
        options.broadcast('providers:budget', alert);
      }
    }
  };

  const runner = new ModelTaskRunner({
    identity: options.identity,
    policy,
    audit,
    defaultCwd: () => tmpdir(),
    candidates: (task) =>
      hub.taskChain(task as Parameters<ProviderHub['taskChain']>[0]).flatMap((e) => {
        const adapter = hub.apiAdapter(e.ref);
        return adapter
          ? [
              {
                agentId: apiAgentId(e.ref),
                providerId: e.provider.id,
                model: e.model.id,
                label: `${e.model.name} (${e.provider.name})`,
                paid: hub.isPaid(e.ref),
                adapter,
              },
            ]
          : [];
      }),
    onUsage: (c, usage) => recordUsage(`${c.providerId}/${c.model}`, usage),
    onNotice: (message) => options.broadcast('providers:notice', message),
  });

  const lastUsage = new Map<
    string,
    { agentId: string; usage: { inputTokens: number; outputTokens: number; costUsd?: number } }
  >();

  const changed = () => {
    options.onAgentsChanged(hub.agents());
    const view = hub.view();
    options.broadcast('providers:changed', view);
    return view;
  };

  const handlers: ProvidersHandlers = {
    'providers:view': () => hub.view(),
    'providers:setKey': (providerId, key) => {
      if (typeof key !== 'string') throw new Error('Key phải là chuỗi');
      hub.setKey(String(providerId), key);
      log({
        agentId: `provider:${String(providerId)}`,
        type: 'provider_key',
        action: 'set',
        providerId: String(providerId),
        hint: hub.view().providers.find((p) => p.id === providerId)?.keyHint ?? '',
      });
      return changed();
    },
    'providers:deleteKey': (providerId) => {
      hub.deleteKey(String(providerId));
      log({
        agentId: `provider:${String(providerId)}`,
        type: 'provider_key',
        action: 'delete',
        providerId: String(providerId),
      });
      return changed();
    },
    'providers:check': async (providerId) => {
      const result = await hub.check(String(providerId));
      changed();
      return result;
    },
    'providers:update': (patch) => {
      hub.update(patch);
      return changed();
    },
    'providers:tryTask': async (task, prompt) => {
      try {
        const out = await runner.runText(task, String(prompt).slice(0, 4_000));
        return {
          ok: true,
          model: out.candidate.label,
          text: hub.redact(out.value),
          notices: out.notices,
        };
      } catch (err) {
        return {
          ok: false,
          notices: [],
          error: hub.redact(err instanceof Error ? err.message : String(err)),
        };
      }
    },
  };

  return {
    hub,
    runner,
    policy,
    audit,
    wrapStore: (store) => ({
      load: () => store.load(),
      save: (conversations) => store.save(redactValue(conversations)),
    }),
    agents: () => hub.agents(),
    onChatEvent(event) {
      // Một số CLI phát `usage` cộng dồn nhiều lần trong lượt: chỉ ghi số cuối, khi lượt xong
      // hoặc khi NSA đổi agent giữa lượt.
      const key = event.turnId;
      const last = lastUsage.get(key);
      if (last && (event.agentId !== last.agentId || event.event.type === 'done')) {
        lastUsage.delete(key);
        const model = hub.agentModel(last.agentId);
        if (model) recordUsage(model.ref, last.usage);
      }
      if (event.event.type === 'usage' && hub.agentModel(event.agentId)) {
        lastUsage.set(key, { agentId: event.agentId, usage: event.event });
      }
    },
    handlers,
  };
}
