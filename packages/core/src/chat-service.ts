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
  type Conversation,
  type Turn,
} from './chat.js';

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
}

export interface SendResult {
  conversationId: string;
  turnId: string;
}

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
  store?: ConversationStore;
  onEvent?: (event: ChatEvent) => void;
  now?: () => Date;
  newId?: () => string;
}

/** Điều phối các lượt chat giữa người dùng và nhiều agent CLI. */
export class ChatService {
  readonly #adapters: Map<string, AgentAdapter>;
  readonly #store: ConversationStore | undefined;
  readonly #onEvent: (event: ChatEvent) => void;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #conversations = new Map<string, Conversation>();
  readonly #running = new Map<string, { conversationId: string; run: AgentRun }>();

  constructor(options: ChatServiceOptions) {
    this.#adapters = new Map(options.adapters.map((a) => [a.id, a]));
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

  send(request: SendRequest): SendResult {
    const adapter = this.#adapters.get(request.agentId);
    if (!adapter) throw new Error(`Không có agent "${request.agentId}"`);
    const prompt = request.prompt.trim();
    if (!prompt) throw new Error('Nội dung trống');

    const now = this.#now().toISOString();
    let conversation: Conversation;
    if (request.conversationId) {
      const existing = this.#conversations.get(request.conversationId);
      if (!existing) throw new Error('Không tìm thấy cuộc trò chuyện');
      if (existing.turns.some((t) => t.status === 'running')) {
        throw new Error('Agent đang trả lời, hãy đợi hoặc bấm Dừng');
      }
      conversation = existing;
    } else {
      if (!request.cwd) throw new Error('Chưa chọn thư mục làm việc');
      conversation = {
        id: this.#newId(),
        title: titleFromPrompt(prompt),
        cwd: request.cwd,
        permission: request.permission ?? 'read-only',
        createdAt: now,
        updatedAt: now,
        sessions: {},
        turns: [],
      };
    }
    if (request.permission) conversation = { ...conversation, permission: request.permission };

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

    return { conversationId, turnId: turn.id };
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
    // Ghi đĩa ở các mốc quan trọng, không ghi theo từng mẩu văn bản.
    if (event.type === 'session' || event.type === 'done') this.#persist();
    this.#onEvent({ conversationId, turnId, event });
  }

  #persist(): void {
    this.#store?.save(this.listConversations());
  }
}
