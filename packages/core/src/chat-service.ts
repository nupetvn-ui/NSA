import type {
  AgentAdapter,
  AgentErrorCode,
  AgentEvent,
  AgentRun,
  Capabilities,
  DetectResult,
  McpServerSpec,
  PermissionLevel,
  ToolCallRequest,
  ToolGateServer,
  ToolGateVerdict,
} from '@nsa/adapter-sdk';
import {
  applyEvent,
  buildHandoffContext,
  titleFromPrompt,
  turnReply,
  type Conversation,
  type Turn,
} from './chat.js';
import type { MemoryContext } from './memory.js';
import { needsFor, planRoute } from './router.js';
import {
  personalPolicy,
  type AuditEntry,
  type AuditLog,
  type IdentityProvider,
  type Policy,
  type PolicyAction,
  type PolicyDecision,
} from './sockets.js';

export interface AgentInfo extends DetectResult {
  id: string;
  name: string;
  capabilities: Capabilities;
  /** Có tầng dự phòng (PTY / văn bản thô) khi tầng chính hỏng. */
  hasFallback: boolean;
}

/** Chọn agent tự động theo năng lực. */
export const AUTO_AGENT = 'auto';

export interface SendRequest {
  /** Bỏ trống để mở cuộc trò chuyện mới. */
  conversationId?: string;
  /** Mã agent, hoặc `auto` để NSA tự chọn theo năng lực. */
  agentId: string;
  prompt: string;
  /** Bắt buộc khi mở cuộc trò chuyện mới; bỏ qua với cuộc trò chuyện đã có. */
  cwd?: string;
  permission?: PermissionLevel;
  /** Người dùng đã đồng ý sau khi chính sách trả lời "hỏi". */
  confirmed?: boolean;
  /** Agent hỏng hoặc chưa cài thì tự đổi sang agent khác (mặc định: có). */
  autoSwitch?: boolean;
}

export type SendResult =
  | { status: 'started'; conversationId: string; turnId: string; agentId: string }
  /** Chính sách cần người dùng xác nhận; gửi lại với `confirmed: true` nếu họ đồng ý. */
  | { status: 'needs_confirmation'; reason: string }
  /** Chính sách chặn — không có lệnh nào được chạy. */
  | { status: 'denied'; reason: string };

export interface ChatEvent {
  conversationId: string;
  turnId: string;
  event: AgentEvent;
  /** Agent đang trả lời lượt này (đổi khi NSA tự đổi agent giữa lượt). */
  agentId: string;
}

/**
 * Phần mở rộng cắm vào từng lượt (NSA Mem dùng): chèn ngữ cảnh, gắn server MCP, được báo khi
 * lượt bắt đầu / kết thúc. Lỗi của phần mở rộng không bao giờ làm hỏng lượt.
 */
export interface ChatExtension {
  /** Ngữ cảnh chèn trước yêu cầu của người dùng (một lần mỗi lượt, mọi agent đều nhận). */
  contextFor?(input: {
    prompt: string;
    agentId: string;
    conversationId?: string;
    cwd: string;
    /** Agent nhận lượt này gắn được MCP (để báo nó có tool của NSA). */
    mcp: boolean;
  }): MemoryContext | null | Promise<MemoryContext | null>;
  /** Server MCP gắn cho một lần chạy (chỉ với agent có năng lực `mcp`). */
  mcpFor?(input: {
    agentId: string;
    conversationId: string;
    turnId: string;
  }): { server: McpServerSpec; dispose: () => void } | null;
  turnStarted?(conversation: Conversation, turn: Turn): void;
  turnFinished?(conversation: Conversation, turn: Turn): void;
}

/** Một việc nền giao cho agent (chắt lọc bộ nhớ…) — không tạo cuộc trò chuyện. */
export interface TaskRequest {
  /** Mã agent hoặc `auto`. */
  agentId: string;
  prompt: string;
  cwd: string;
  /** Mô tả việc, ghi vào nhật ký. */
  purpose: string;
}

export interface TaskResult {
  agentId: string;
  text: string;
}

/** Nơi lưu cuộc trò chuyện (desktop dùng file JSON; test dùng bộ nhớ). */
export interface ConversationStore {
  load(): Conversation[];
  save(conversations: Conversation[]): void;
}

export interface ChatServiceOptions {
  adapters: AgentAdapter[];
  /** Ổ cắm danh tính — ai đang ra lệnh. */
  identity: IdentityProvider;
  /** Ổ cắm chính sách — mặc định là chính sách bản Cá nhân. */
  policy?: Policy;
  /** Ổ cắm nhật ký — bỏ trống thì không ghi. */
  audit?: AuditLog;
  /** Cổng chính sách từng lệnh; có thì agent khai báo `toolGate` bị kiểm từng lệnh. */
  gate?: ToolGateServer;
  store?: ConversationStore;
  extensions?: ChatExtension[];
  onEvent?: (event: ChatEvent) => void;
  now?: () => Date;
  newId?: () => string;
  /** Thời gian chờ người dùng trả lời một yêu cầu cho phép lệnh (mặc định 4 phút). */
  permissionTimeoutMs?: number;
  /**
   * Agent nên thử tiếp khi `agentId` hỏng, theo thứ tự (ví dụ chuỗi model dự phòng của việc
   * chính khi hãng API lỗi / hết hạn mức — ADR-0009). Agent không đủ năng lực vẫn bị loại.
   */
  fallbackOrder?: (agentId: string) => string[];
}

type AuditBody = AuditEntry extends infer E
  ? E extends AuditEntry
    ? Omit<E, 'at' | 'actor'>
    : never
  : never;

/** Một lượt đang chạy — có thể qua nhiều lần thử (lùi tầng, đổi agent). */
interface TurnRun {
  conversationId: string;
  turnId: string;
  run: AgentRun | null;
  cancelled: boolean;
  /** Agent đã thử trong lượt này. */
  tried: string[];
  confirmed: boolean;
  autoSwitch: boolean;
  disposeGate?: () => void;
  disposeMcp?: () => void;
  /** Ngữ cảnh bộ nhớ của lượt (tính một lần, dùng lại khi lùi tầng / đổi agent). */
  memory: MemoryContext | null;
}

const MAX_ATTEMPTS = 4;

/** Điều phối các lượt chat giữa người dùng và nhiều agent CLI. */
export class ChatService {
  #adapters: Map<string, AgentAdapter>;
  readonly #fallbackOrder: ((agentId: string) => string[]) | undefined;
  readonly #identity: IdentityProvider;
  readonly #policy: Policy;
  readonly #audit: AuditLog | undefined;
  readonly #gate: ToolGateServer | undefined;
  readonly #store: ConversationStore | undefined;
  readonly #extensions: ChatExtension[];
  readonly #onEvent: (event: ChatEvent) => void;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #permissionTimeoutMs: number;
  readonly #conversations = new Map<string, Conversation>();
  readonly #running = new Map<string, TurnRun>();
  /** Kết quả dò gần nhất của từng agent — bộ định tuyến dùng. */
  readonly #status = new Map<string, DetectResult>();
  /** Yêu cầu cho phép lệnh đang chờ người dùng trả lời. */
  readonly #pendingPermissions = new Map<
    string,
    { turnId: string; resolve: (allowed: boolean) => void }
  >();
  /** Cuộc trò chuyện đang chờ chính sách trả lời — chặn gửi chồng. */
  readonly #pending = new Set<string>();

  constructor(options: ChatServiceOptions) {
    this.#adapters = new Map(options.adapters.map((a) => [a.id, a]));
    this.#fallbackOrder = options.fallbackOrder;
    this.#identity = options.identity;
    this.#policy = options.policy ?? personalPolicy();
    this.#audit = options.audit;
    this.#gate = options.gate;
    this.#store = options.store;
    this.#extensions = options.extensions ?? [];
    this.#onEvent = options.onEvent ?? (() => undefined);
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => crypto.randomUUID());
    // Dưới 5 phút: fetch của script móc tự hết giờ sau 5 phút (khi đó lệnh cũng bị chặn).
    this.#permissionTimeoutMs = options.permissionTimeoutMs ?? 4 * 60_000;

    for (const conversation of this.#store?.load() ?? []) {
      // Lượt đang chạy khi app tắt thì coi như đã bị huỷ.
      const turns = conversation.turns.map((t) =>
        t.status === 'running' ? { ...t, status: 'cancelled' as const } : t,
      );
      this.#conversations.set(conversation.id, { ...conversation, turns });
    }
  }

  async listAgents(): Promise<AgentInfo[]> {
    return Promise.all(
      [...this.#adapters.values()].map(async (adapter) => {
        let status: DetectResult;
        try {
          status = await adapter.detect();
        } catch (err) {
          status = { installed: false, ready: false, note: String(err) };
        }
        this.#status.set(adapter.id, status);
        return {
          id: adapter.id,
          name: adapter.displayName,
          capabilities: adapter.capabilities(),
          hasFallback: adapter.fallback !== undefined,
          ...status,
        };
      }),
    );
  }

  /**
   * Thay danh sách agent (người dùng thêm / xoá key của một hãng). Lượt đang chạy giữ adapter cũ.
   */
  setAdapters(adapters: AgentAdapter[]): void {
    this.#adapters = new Map(adapters.map((a) => [a.id, a]));
    for (const id of [...this.#status.keys()]) if (!this.#adapters.has(id)) this.#status.delete(id);
  }

  listConversations(): Conversation[] {
    return [...this.#conversations.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Thứ tự agent theo năng lực cho một lượt (dùng cho "Tự chọn" và khi phải đổi agent). */
  #route(preferred: string | undefined, permission: PermissionLevel, exclude: string[]) {
    return planRoute(
      [...this.#adapters.values()].map((a) => {
        const status = this.#status.get(a.id);
        return { id: a.id, capabilities: a.capabilities(), ...(status ? { status } : {}) };
      }),
      {
        ...(preferred ? { preferred } : {}),
        needs: needsFor(permission),
        exclude,
        order: [...this.#adapters.keys()],
      },
    );
  }

  async send(request: SendRequest): Promise<SendResult> {
    const prompt = request.prompt.trim();
    if (!prompt) throw new Error('Nội dung trống');

    const existing = request.conversationId
      ? this.#conversations.get(request.conversationId)
      : undefined;
    if (request.conversationId && !existing) throw new Error('Không tìm thấy cuộc trò chuyện');
    if (!existing && !request.cwd) throw new Error('Chưa chọn thư mục làm việc');
    if (
      existing &&
      (existing.turns.some((t) => t.status === 'running') || this.#pending.has(existing.id))
    ) {
      throw new Error('Agent đang trả lời, hãy đợi hoặc bấm Dừng');
    }

    const cwd = existing?.cwd ?? request.cwd ?? '';
    const permission = request.permission ?? existing?.permission ?? 'read-only';

    let adapter: AgentAdapter | undefined;
    if (request.agentId === AUTO_AGENT) {
      if (this.#status.size === 0) await this.listAgents();
      const [first] = this.#route(undefined, permission, []).candidates;
      adapter = first ? this.#adapters.get(first) : undefined;
      if (!adapter) throw new Error('Không có agent nào đủ năng lực cho việc này');
    } else {
      adapter = this.#adapters.get(request.agentId);
      if (!adapter) throw new Error(`Không có agent "${request.agentId}"`);
    }

    // Đã xác nhận cho phép sửa file trong cuộc trò chuyện này thì không hỏi lại.
    const confirmed =
      request.confirmed === true || (permission === 'edit' && existing?.editConfirmed === true);

    // Cấp sẵn mã lượt (và mã cuộc trò chuyện mới) để dòng `request` / `policy` nối được với
    // phần còn lại của lượt trong Traces (ADR-0018).
    const conversationId = existing?.id ?? this.#newId();
    const turnId = this.#newId();
    const ids = { conversationId, turnId };
    this.#log({ agentId: adapter.id, ...ids, type: 'request', prompt, cwd, permission });

    // ---- Ổ cắm chính sách: không qua thì không có lệnh nào được chạy. ----
    if (existing) this.#pending.add(existing.id);
    let verdict: PolicyDecision;
    try {
      verdict = await this.#checkRun(
        adapter.id,
        cwd,
        permission,
        prompt,
        existing?.id,
        confirmed,
        ids,
      );
    } finally {
      if (existing) this.#pending.delete(existing.id);
    }
    if (verdict.decision === 'deny') return { status: 'denied', reason: verdict.reason };
    if (verdict.decision === 'ask') return { status: 'needs_confirmation', reason: verdict.reason };

    // Trong lúc chờ chính sách, cuộc trò chuyện có thể đã bị xoá.
    if (existing && !this.#conversations.has(existing.id)) {
      throw new Error('Không tìm thấy cuộc trò chuyện');
    }

    const memory = await this.#gatherContext(
      prompt,
      adapter.id,
      existing?.id,
      cwd,
      adapter.capabilities().mcp,
    );
    if (existing && !this.#conversations.has(existing.id)) {
      throw new Error('Không tìm thấy cuộc trò chuyện');
    }
    return this.#start(
      adapter,
      prompt,
      cwd,
      permission,
      confirmed,
      existing,
      request.autoSwitch,
      memory,
      ids,
    );
  }

  /** Hỏi các phần mở rộng ngữ cảnh cần chèn (bộ nhớ). Lỗi thì bỏ qua. */
  async #gatherContext(
    prompt: string,
    agentId: string,
    conversationId: string | undefined,
    cwd: string,
    mcp: boolean,
  ): Promise<MemoryContext | null> {
    const parts: MemoryContext[] = [];
    for (const ext of this.#extensions) {
      if (!ext.contextFor) continue;
      try {
        const ctx = await ext.contextFor({
          prompt,
          agentId,
          cwd,
          mcp,
          ...(conversationId ? { conversationId } : {}),
        });
        if (ctx) parts.push(ctx);
      } catch (err) {
        console.error('[chat] phần mở rộng lỗi khi lấy ngữ cảnh:', err);
      }
    }
    if (parts.length === 0) return null;
    return {
      text: parts.map((p) => p.text).join('\n\n'),
      entries: parts.flatMap((p) => p.entries),
    };
  }

  #notifyExtensions(
    kind: 'turnStarted' | 'turnFinished',
    conversationId: string,
    turnId: string,
  ): void {
    const conversation = this.#conversations.get(conversationId);
    const turn = conversation?.turns.find((t) => t.id === turnId);
    if (!conversation || !turn) return;
    for (const ext of this.#extensions) {
      try {
        ext[kind]?.(conversation, turn);
      } catch (err) {
        console.error(`[chat] phần mở rộng lỗi (${kind}):`, err);
      }
    }
  }

  /**
   * Giao một việc nền cho agent (ví dụ chắt lọc bộ nhớ): luôn chỉ đọc, hỏi `Policy` trước,
   * ghi `AuditLog`, không lưu thành cuộc trò chuyện. Agent hỏng thì thử agent kế tiếp.
   */
  async runTask(request: TaskRequest): Promise<TaskResult> {
    if (this.#status.size === 0) await this.listAgents();
    const permission: PermissionLevel = 'read-only';
    const candidates =
      request.agentId === AUTO_AGENT
        ? this.#route(undefined, permission, []).candidates
        : [request.agentId, ...this.#route(undefined, permission, [request.agentId]).candidates];
    const errors: string[] = [];
    for (const id of candidates.slice(0, MAX_ATTEMPTS)) {
      const adapter = this.#adapters.get(id);
      if (!adapter) continue;
      // Mỗi lần thử của việc nền là một "lượt" riêng trong Traces (không có cuộc trò chuyện).
      const turnId = this.#newId();
      this.#log({
        agentId: id,
        turnId,
        type: 'request',
        prompt: `[${request.purpose}]`,
        cwd: request.cwd,
        permission,
      });
      const verdict = await this.#checkRun(
        id,
        request.cwd,
        permission,
        request.prompt,
        undefined,
        false,
        { turnId },
      );
      if (verdict.decision !== 'allow') {
        errors.push(`${adapter.displayName}: ${verdict.reason}`);
        continue;
      }
      let text = '';
      const runErrors: string[] = [];
      try {
        const run = adapter.run(
          { prompt: request.prompt, cwd: request.cwd, permission },
          (event) => {
            if (event.type === 'text') text += event.text;
            else {
              if (event.type === 'error') runErrors.push(event.message);
              this.#log({ agentId: id, turnId, type: 'agent_event', event });
            }
          },
        );
        await run.finished;
      } catch (err) {
        runErrors.push(String(err));
      }
      if (text.trim()) {
        this.#log({ agentId: id, turnId, type: 'reply', text });
        return { agentId: id, text };
      }
      errors.push(`${adapter.displayName}: ${runErrors.join('; ') || 'không trả lời'}`);
    }
    throw new Error(
      `Không agent nào làm được việc "${request.purpose}": ${errors.join(' | ') || 'không có agent sẵn sàng'}`,
    );
  }

  /** Hỏi chính sách cho một lượt chạy và ghi nhật ký. Chính sách lỗi = chặn. */
  async #checkRun(
    agentId: string,
    cwd: string,
    permission: PermissionLevel,
    prompt: string,
    conversationId: string | undefined,
    confirmed: boolean,
    ids: { conversationId?: string; turnId?: string } = {},
  ): Promise<PolicyDecision> {
    const logConversationId = ids.conversationId ?? conversationId;
    const action: PolicyAction = {
      kind: 'agent.run',
      agentId,
      cwd,
      permission,
      prompt,
      ...(conversationId ? { conversationId } : {}),
    };
    let verdict: PolicyDecision;
    try {
      verdict = await this.#policy.check({ actor: this.#identity.current(), action, confirmed });
    } catch (err) {
      verdict = { decision: 'deny', reason: `Lỗi khi kiểm chính sách: ${String(err)}` };
    }
    this.#log({
      agentId,
      ...(logConversationId ? { conversationId: logConversationId } : {}),
      ...(ids.turnId ? { turnId: ids.turnId } : {}),
      type: 'policy',
      decision: verdict.decision,
      confirmed,
      ...(verdict.decision === 'allow' ? {} : { reason: verdict.reason }),
    });
    return verdict;
  }

  #start(
    adapter: AgentAdapter,
    prompt: string,
    cwd: string,
    permission: PermissionLevel,
    confirmed: boolean,
    existing: Conversation | undefined,
    autoSwitch = true,
    memory: MemoryContext | null = null,
    ids: { conversationId?: string; turnId?: string } = {},
  ): SendResult {
    const now = this.#now().toISOString();
    let conversation: Conversation = existing
      ? { ...(this.#conversations.get(existing.id) ?? existing), permission }
      : {
          id: ids.conversationId ?? this.#newId(),
          title: titleFromPrompt(prompt),
          cwd,
          permission,
          createdAt: now,
          updatedAt: now,
          sessions: {},
          turns: [],
        };
    if (permission === 'edit' && confirmed) conversation = { ...conversation, editConfirmed: true };

    const turn: Turn = {
      id: ids.turnId ?? this.#newId(),
      agentId: adapter.id,
      prompt,
      startedAt: now,
      status: 'running',
      parts: [],
      errors: [],
      ...(memory?.entries.length ? { memory: memory.entries } : {}),
    };
    conversation = { ...conversation, updatedAt: now, turns: [...conversation.turns, turn] };
    this.#conversations.set(conversation.id, conversation);
    this.#persist();

    const state: TurnRun = {
      conversationId: conversation.id,
      turnId: turn.id,
      run: null,
      cancelled: false,
      tried: [],
      confirmed,
      autoSwitch,
      memory,
    };
    this.#running.set(turn.id, state);
    this.#notifyExtensions('turnStarted', conversation.id, turn.id);
    this.#attempt(state, adapter, adapter);
    return {
      status: 'started',
      conversationId: conversation.id,
      turnId: turn.id,
      agentId: adapter.id,
    };
  }

  /**
   * Một lần thử: chạy `runner` (adapter chính hoặc tầng dự phòng của `agent`).
   * Lỗi và `done` được giữ lại cho tới khi biết có lùi tầng / đổi agent hay không.
   */
  #attempt(state: TurnRun, agent: AgentAdapter, runner: AgentAdapter): void {
    const conversation = this.#conversations.get(state.conversationId);
    if (!conversation) return;
    const isFallbackTier = runner !== agent;
    state.tried.push(agent.id);
    this.#setTurnAgent(state, agent.id);

    // Tầng dự phòng không tiếp tục được phiên: chuyển toàn bộ ngữ cảnh. Tầng chính: chỉ phần
    // agent này chưa thấy (các lượt của agent khác), và tiếp tục phiên cũ nếu có.
    const names = Object.fromEntries(
      [...this.#adapters.values()].map((a) => [a.id, a.displayName]),
    );
    const previous = { turns: conversation.turns.filter((t) => t.id !== state.turnId) };
    const handoff = buildHandoffContext(previous, isFallbackTier ? '\u0000' : agent.id, names);
    const turn = conversation.turns.find((t) => t.id === state.turnId);
    const prompt = turn?.prompt ?? '';
    const preamble = [state.memory?.text, handoff].filter(Boolean).join('\n\n');
    const fullPrompt = preamble ? `${preamble}\n\nYêu cầu mới của người dùng:\n${prompt}` : prompt;
    if (handoff) this.#patchTurn(state, (t) => ({ ...t, handoff: true }));
    const sessionId = isFallbackTier ? undefined : conversation.sessions[agent.id];

    // Cổng chặn từng lệnh — chỉ với agent khai báo hỗ trợ.
    state.disposeGate?.();
    delete state.disposeGate;
    let gate: { url: string; token: string } | undefined;
    if (this.#gate && runner.capabilities().toolGate) {
      const registration = this.#gate.register((request) =>
        this.#checkTool(state, agent.id, conversation.cwd, conversation.permission, request),
      );
      gate = registration.endpoint;
      state.disposeGate = registration.dispose;
    }

    // Server MCP của NSA (bộ nhớ) — chỉ với agent gắn được MCP.
    state.disposeMcp?.();
    delete state.disposeMcp;
    const mcpServers: McpServerSpec[] = [];
    if (runner.capabilities().mcp) {
      const disposers: (() => void)[] = [];
      for (const ext of this.#extensions) {
        try {
          const attached = ext.mcpFor?.({
            agentId: agent.id,
            conversationId: state.conversationId,
            turnId: state.turnId,
          });
          if (attached) {
            mcpServers.push(attached.server);
            disposers.push(attached.dispose);
          }
        } catch (err) {
          console.error('[chat] phần mở rộng lỗi khi gắn MCP:', err);
        }
      }
      if (disposers.length) state.disposeMcp = () => disposers.forEach((d) => d());
    }

    const errors: Extract<AgentEvent, { type: 'error' }>[] = [];
    let meaningful = false;
    let ended = false;
    const onEvent = (event: AgentEvent): void => {
      if (ended) return;
      if (event.type === 'error') {
        errors.push(event);
        return;
      }
      if (event.type === 'done') {
        ended = true;
        this.#afterAttempt(state, agent, runner, errors, meaningful, event.cancelled);
        return;
      }
      if (event.type === 'text' || event.type === 'tool_call') meaningful = true;
      this.#handle(state.conversationId, state.turnId, agent.id, event);
    };

    try {
      state.run = runner.run(
        {
          prompt: fullPrompt,
          cwd: conversation.cwd,
          permission: conversation.permission,
          ...(sessionId ? { sessionId } : {}),
          ...(gate ? { gate } : {}),
          ...(mcpServers.length ? { mcpServers } : {}),
        },
        onEvent,
      );
    } catch (err) {
      onEvent({ type: 'error', code: 'cli', message: String(err) });
      onEvent({ type: 'done', cancelled: false });
    }
  }

  /** Quyết định sau một lần thử: xong, lùi tầng, đổi agent, hay báo lỗi. */
  #afterAttempt(
    state: TurnRun,
    agent: AgentAdapter,
    runner: AgentAdapter,
    errors: Extract<AgentEvent, { type: 'error' }>[],
    meaningful: boolean,
    cancelled: boolean,
  ): void {
    const finish = (): void => {
      for (const error of errors) this.#handle(state.conversationId, state.turnId, agent.id, error);
      state.disposeGate?.();
      state.disposeMcp?.();
      this.#denyPendingPermissions(state.turnId);
      this.#running.delete(state.turnId);
      this.#handle(state.conversationId, state.turnId, agent.id, { type: 'done', cancelled });
      this.#notifyExtensions('turnFinished', state.conversationId, state.turnId);
    };

    // Thành công, bị huỷ, hoặc đã trả lời được một phần (thử lại sẽ làm lại việc) → kết thúc.
    if (cancelled || state.cancelled || errors.length === 0 || meaningful) return finish();
    if (state.tried.length >= MAX_ATTEMPTS) return finish();

    const codes = new Set<AgentErrorCode>(errors.map((e) => e.code ?? 'cli'));
    const reason = errors.map((e) => e.message.split('\n')[0]).join('; ');

    // 1. Tầng chính không nói đúng giao thức → lùi xuống tầng PTY của cùng CLI.
    if (codes.has('protocol') && runner === agent && agent.fallback) {
      this.#notice(
        state,
        agent.id,
        `${agent.displayName}: tầng chính hỏng (${reason}). Lùi xuống tầng văn bản thô / PTY.`,
      );
      this.#log({
        conversationId: state.conversationId,
        turnId: state.turnId,
        agentId: agent.id,
        type: 'fallback',
        kind: 'tier',
        from: `${agent.id}:${agent.capabilities().tier}`,
        to: `${agent.id}:pty`,
        reason,
      });
      state.tried.pop(); // cùng agent, chưa tính là đổi agent
      return this.#attempt(state, agent, agent.fallback);
    }

    // 2. Agent hỏng / chưa cài / chưa đăng nhập → đổi sang agent khác đủ năng lực.
    if (!state.autoSwitch) return finish();
    const conversation = this.#conversations.get(state.conversationId);
    if (!conversation) return finish();
    const routed = this.#route(undefined, conversation.permission, state.tried).candidates;
    const next =
      (this.#fallbackOrder?.(agent.id) ?? []).find((id) => routed.includes(id)) ?? routed[0];
    const nextAdapter = next ? this.#adapters.get(next) : undefined;
    if (!nextAdapter) return finish();

    const turn = conversation.turns.find((t) => t.id === state.turnId);
    void this.#checkRun(
      nextAdapter.id,
      conversation.cwd,
      conversation.permission,
      turn?.prompt ?? '',
      conversation.id,
      state.confirmed || conversation.editConfirmed === true,
      { turnId: state.turnId },
    ).then((verdict) => {
      if (state.cancelled) return finish();
      if (verdict.decision !== 'allow') {
        this.#notice(
          state,
          agent.id,
          `Không đổi được sang ${nextAdapter.displayName}: ${verdict.reason}`,
        );
        return finish();
      }
      // Lỗi của agent cũ thành thông báo — lượt vẫn có thể thành công với agent mới.
      this.#notice(
        state,
        agent.id,
        `${agent.displayName} không chạy được (${reason}). Chuyển sang ${nextAdapter.displayName}.`,
      );
      this.#log({
        conversationId: state.conversationId,
        turnId: state.turnId,
        agentId: agent.id,
        type: 'fallback',
        kind: 'agent',
        from: agent.id,
        to: nextAdapter.id,
        reason,
      });
      this.#attempt(state, nextAdapter, nextAdapter);
    });
  }

  /** Cổng chính sách cho một lệnh bên trong lượt. */
  async #checkTool(
    state: TurnRun,
    agentId: string,
    cwd: string,
    permission: PermissionLevel,
    request: ToolCallRequest,
  ): Promise<ToolGateVerdict> {
    if (state.cancelled) return { allow: false, reason: 'NSA: lượt đã bị dừng' };
    const input = describeToolInput(request.input);
    const action: PolicyAction = {
      kind: 'agent.tool',
      agentId,
      cwd,
      permission,
      conversationId: state.conversationId,
      turnId: state.turnId,
      tool: request.tool,
      input,
    };
    const tool = { name: request.tool, input };
    const base = {
      conversationId: state.conversationId,
      turnId: state.turnId,
      agentId,
      type: 'policy' as const,
      tool,
    };
    let verdict: PolicyDecision;
    try {
      verdict = await this.#policy.check({
        actor: this.#identity.current(),
        action,
        confirmed: false,
      });
    } catch (err) {
      verdict = { decision: 'deny', reason: `Lỗi khi kiểm chính sách: ${String(err)}` };
    }
    this.#log({
      ...base,
      decision: verdict.decision,
      confirmed: false,
      ...(verdict.decision === 'allow' ? {} : { reason: verdict.reason }),
    });
    if (verdict.decision === 'allow') return { allow: true };
    if (verdict.decision === 'deny') return { allow: false, reason: `NSA chặn: ${verdict.reason}` };

    // "Hỏi": hiện yêu cầu trong lượt, chờ người dùng bấm.
    const allowed = await this.#askUser(state, agentId, verdict.reason);
    this.#log({ ...base, decision: allowed ? 'allow' : 'deny', confirmed: allowed });
    return allowed
      ? { allow: true }
      : { allow: false, reason: 'NSA: người dùng không cho phép lệnh này' };
  }

  /**
   * Hỏi người dùng giữa lượt (hộp Cho phép / Từ chối). Dùng cho cổng chính sách từng lệnh và
   * cho cổng MCP (tool nhạy cảm của plugin). Lượt không còn chạy, hết giờ hoặc bị dừng → false.
   */
  askUser(turnId: string, agentId: string, description: string): Promise<boolean> {
    const state = this.#running.get(turnId);
    if (!state || state.cancelled) return Promise.resolve(false);
    return this.#askUser(state, agentId, description);
  }

  async #askUser(state: TurnRun, agentId: string, description: string): Promise<boolean> {
    const id = this.#newId();
    const allowed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingPermissions.delete(id);
        resolve(false);
      }, this.#permissionTimeoutMs);
      this.#pendingPermissions.set(id, {
        turnId: state.turnId,
        resolve: (value) => {
          clearTimeout(timer);
          this.#pendingPermissions.delete(id);
          resolve(value);
        },
      });
      this.#handle(state.conversationId, state.turnId, agentId, {
        type: 'ask_permission',
        id,
        description,
      });
    });
    this.#handle(state.conversationId, state.turnId, agentId, {
      type: 'permission_result',
      id,
      allowed,
      ...(allowed ? {} : { reason: 'Người dùng không cho phép' }),
    });
    return allowed;
  }

  /** Người dùng trả lời một yêu cầu cho phép lệnh. */
  answerPermission(permissionId: string, allowed: boolean): void {
    this.#pendingPermissions.get(permissionId)?.resolve(allowed);
  }

  #denyPendingPermissions(turnId: string): void {
    for (const pending of [...this.#pendingPermissions.values()]) {
      if (pending.turnId === turnId) pending.resolve(false);
    }
  }

  cancel(turnId: string): void {
    const state = this.#running.get(turnId);
    if (!state) return;
    state.cancelled = true;
    this.#denyPendingPermissions(turnId);
    state.run?.cancel();
  }

  deleteConversation(conversationId: string): void {
    for (const [turnId, state] of this.#running) {
      if (state.conversationId === conversationId) {
        state.cancelled = true;
        this.#denyPendingPermissions(turnId);
        state.run?.cancel();
        state.disposeGate?.();
        state.disposeMcp?.();
        this.#running.delete(turnId);
      }
    }
    this.#conversations.delete(conversationId);
    this.#persist();
  }

  #notice(state: TurnRun, agentId: string, message: string): void {
    this.#handle(state.conversationId, state.turnId, agentId, { type: 'notice', message });
  }

  #patchTurn(state: TurnRun, patch: (turn: Turn) => Turn): void {
    const conversation = this.#conversations.get(state.conversationId);
    if (!conversation) return;
    this.#conversations.set(state.conversationId, {
      ...conversation,
      turns: conversation.turns.map((t) => (t.id === state.turnId ? patch(t) : t)),
    });
  }

  #setTurnAgent(state: TurnRun, agentId: string): void {
    this.#patchTurn(state, (t) => (t.agentId === agentId ? t : { ...t, agentId }));
  }

  #handle(conversationId: string, turnId: string, agentId: string, event: AgentEvent): void {
    const conversation = this.#conversations.get(conversationId);
    if (!conversation) return;
    const updated: Conversation = {
      ...conversation,
      updatedAt: this.#now().toISOString(),
      sessions:
        event.type === 'session'
          ? { ...conversation.sessions, [agentId]: event.sessionId }
          : conversation.sessions,
      turns: conversation.turns.map((t) => (t.id === turnId ? applyEvent(t, event) : t)),
    };
    this.#conversations.set(conversationId, updated);

    // ---- Ổ cắm nhật ký: ghi mọi việc agent làm (văn bản ghi gộp khi xong lượt). ----
    if (event.type !== 'text') {
      if (event.type === 'done') {
        const turn = updated.turns.find((t) => t.id === turnId);
        const reply = turn ? turnReply(turn) : '';
        if (reply) this.#log({ conversationId, turnId, agentId, type: 'reply', text: reply });
      }
      this.#log({ conversationId, turnId, agentId, type: 'agent_event', event });
    }

    // Ghi đĩa ở các mốc quan trọng, không ghi theo từng mẩu văn bản.
    if (event.type === 'session' || event.type === 'done' || event.type === 'notice') {
      this.#persist();
    }
    this.#onEvent({ conversationId, turnId, event, agentId });
  }

  #log(body: AuditBody): void {
    if (!this.#audit) return;
    const actor = this.#identity.current();
    try {
      this.#audit.record({
        ...body,
        at: this.#now().toISOString(),
        actor: { id: actor.id, displayName: actor.displayName },
      } as AuditEntry);
    } catch (err) {
      console.error('[audit] không ghi được nhật ký:', err);
    }
  }

  #persist(): void {
    this.#store?.save(this.listConversations());
  }
}

/** Tham số công cụ thành một dòng dễ đọc (lệnh shell, đường dẫn file…) để kiểm và hiển thị. */
export function describeToolInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (typeof input !== 'object' || input === null) return '';
  const record = input as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'file_path', 'filePath', 'path', 'url', 'pattern']) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
    if (Array.isArray(value)) return value.map(String).join(' ');
  }
  return JSON.stringify(input);
}
