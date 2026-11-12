import type {
  AgentAdapter,
  AgentEvent,
  AgentRun,
  DetectResult,
  PermissionLevel,
} from '@nsa/adapter-sdk';
import {
  applyEvent,
  buildHandoffContext,
  titleFromPrompt,
  turnReply,
  type Conversation,
  type Turn,
} from './chat.js';
import {
  personalPolicy,
  type AuditEntry,
  type AuditLog,
  type IdentityProvider,
  type Policy,
  type PolicyAction,
} from './sockets.js';

export interface AgentInfo extends DetectResult {
  id: string;
  name: string;
}

export interface SendRequest {
  /** Bỏ trống để mở cuộc trò chuyện mới. */
  conversationId?: string;
  agentId: string;
  prompt: string;
  /** Bắt buộc khi mở cuộc trò chuyện mới; bỏ qua với cuộc trò chuyện đã có. */
  cwd?: string;
  permission?: PermissionLevel;
  /** Người dùng đã đồng ý sau khi chính sách trả lời "hỏi". */
  confirmed?: boolean;
}

export type SendResult =
  | { status: 'started'; conversationId: string; turnId: string }
  /** Chính sách cần người dùng xác nhận; gửi lại với `confirmed: true` nếu họ đồng ý. */
  | { status: 'needs_confirmation'; reason: string }
  /** Chính sách chặn — không có lệnh nào được chạy. */
  | { status: 'denied'; reason: string };

export interface ChatEvent {
  conversationId: string;
  turnId: string;
  event: AgentEvent;
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
  store?: ConversationStore;
  onEvent?: (event: ChatEvent) => void;
  now?: () => Date;
  newId?: () => string;
}

type AuditBody = AuditEntry extends infer E
  ? E extends AuditEntry
    ? Omit<E, 'at' | 'actor'>
    : never
  : never;

/** Điều phối các lượt chat giữa người dùng và nhiều agent CLI. */
export class ChatService {
  readonly #adapters: Map<string, AgentAdapter>;
  readonly #identity: IdentityProvider;
  readonly #policy: Policy;
  readonly #audit: AuditLog | undefined;
  readonly #store: ConversationStore | undefined;
  readonly #onEvent: (event: ChatEvent) => void;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #conversations = new Map<string, Conversation>();
  readonly #running = new Map<string, { conversationId: string; run: AgentRun }>();
  /** Cuộc trò chuyện đang chờ chính sách trả lời — chặn gửi chồng. */
  readonly #pending = new Set<string>();

  constructor(options: ChatServiceOptions) {
    this.#adapters = new Map(options.adapters.map((a) => [a.id, a]));
    this.#identity = options.identity;
    this.#policy = options.policy ?? personalPolicy();
    this.#audit = options.audit;
    this.#store = options.store;
    this.#onEvent = options.onEvent ?? (() => undefined);
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => crypto.randomUUID());

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
        try {
          return { id: adapter.id, name: adapter.displayName, ...(await adapter.detect()) };
        } catch (err) {
          return {
            id: adapter.id,
            name: adapter.displayName,
            installed: false,
            ready: false,
            note: String(err),
          };
        }
      }),
    );
  }

  listConversations(): Conversation[] {
    return [...this.#conversations.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async send(request: SendRequest): Promise<SendResult> {
    const adapter = this.#adapters.get(request.agentId);
    if (!adapter) throw new Error(`Không có agent "${request.agentId}"`);
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
    const action: PolicyAction = {
      kind: 'agent.run',
      agentId: adapter.id,
      cwd,
      permission,
      prompt,
      ...(existing ? { conversationId: existing.id } : {}),
    };
    // Đã xác nhận cho phép sửa file trong cuộc trò chuyện này thì không hỏi lại.
    const confirmed =
      request.confirmed === true || (permission === 'edit' && existing?.editConfirmed === true);

    const base = { agentId: adapter.id, ...(existing ? { conversationId: existing.id } : {}) };
    this.#log({ ...base, type: 'request', prompt, cwd, permission });

    // ---- Ổ cắm chính sách: không qua thì không có lệnh nào được chạy. ----
    if (existing) this.#pending.add(existing.id);
    let verdict;
    try {
      verdict = await this.#policy.check({ actor: this.#identity.current(), action, confirmed });
    } catch (err) {
      verdict = { decision: 'deny' as const, reason: `Lỗi khi kiểm chính sách: ${String(err)}` };
    } finally {
      if (existing) this.#pending.delete(existing.id);
    }
    this.#log({
      ...base,
      type: 'policy',
      decision: verdict.decision,
      confirmed,
      ...(verdict.decision === 'allow' ? {} : { reason: verdict.reason }),
    });
    if (verdict.decision === 'deny') return { status: 'denied', reason: verdict.reason };
    if (verdict.decision === 'ask') return { status: 'needs_confirmation', reason: verdict.reason };

    // Trong lúc chờ chính sách, cuộc trò chuyện có thể đã bị xoá.
    if (existing && !this.#conversations.has(existing.id)) {
      throw new Error('Không tìm thấy cuộc trò chuyện');
    }

    return this.#start(adapter, prompt, cwd, permission, confirmed, existing);
  }

  #start(
    adapter: AgentAdapter,
    prompt: string,
    cwd: string,
    permission: PermissionLevel,
    confirmed: boolean,
    existing: Conversation | undefined,
  ): SendResult {
    const now = this.#now().toISOString();
    let conversation: Conversation = existing
      ? { ...(this.#conversations.get(existing.id) ?? existing), permission }
      : {
          id: this.#newId(),
          title: titleFromPrompt(prompt),
          cwd,
          permission,
          createdAt: now,
          updatedAt: now,
          sessions: {},
          turns: [],
        };
    if (permission === 'edit' && confirmed) conversation = { ...conversation, editConfirmed: true };

    const names = Object.fromEntries(
      [...this.#adapters.values()].map((a) => [a.id, a.displayName]),
    );
    const handoff = buildHandoffContext(conversation, adapter.id, names);
    const fullPrompt = handoff ? `${handoff}\n\nYêu cầu mới của người dùng:\n${prompt}` : prompt;

    const turn: Turn = {
      id: this.#newId(),
      agentId: adapter.id,
      prompt,
      startedAt: now,
      status: 'running',
      parts: [],
      errors: [],
      ...(handoff ? { handoff: true } : {}),
    };
    conversation = { ...conversation, updatedAt: now, turns: [...conversation.turns, turn] };
    this.#conversations.set(conversation.id, conversation);
    this.#persist();

    const conversationId = conversation.id;
    const sessionId = conversation.sessions[adapter.id];
    const run = adapter.run(
      {
        prompt: fullPrompt,
        cwd: conversation.cwd,
        permission: conversation.permission,
        ...(sessionId ? { sessionId } : {}),
      },
      (event) => this.#handle(conversationId, turn.id, adapter.id, event),
    );
    this.#running.set(turn.id, { conversationId, run });
    void run.finished.then(() => this.#running.delete(turn.id));

    return { status: 'started', conversationId, turnId: turn.id };
  }

  cancel(turnId: string): void {
    this.#running.get(turnId)?.run.cancel();
  }

  deleteConversation(conversationId: string): void {
    for (const [turnId, entry] of this.#running) {
      if (entry.conversationId === conversationId) {
        entry.run.cancel();
        this.#running.delete(turnId);
      }
    }
    this.#conversations.delete(conversationId);
    this.#persist();
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
    if (event.type === 'session' || event.type === 'done') this.#persist();
    this.#onEvent({ conversationId, turnId, event });
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
