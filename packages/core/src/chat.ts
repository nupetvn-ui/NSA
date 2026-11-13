import type { AgentEvent, PermissionLevel } from '@nsa/adapter-sdk';

/** Một phần trong câu trả lời của agent: đoạn văn hoặc một lần gọi công cụ. */
export type TurnPart =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tool'; id: string; name: string; input: string; output?: string; isError?: boolean }
  /** NSA báo cho người dùng (lùi tầng, đổi agent…). */
  | { kind: 'notice'; id: string; text: string }
  /** Một lệnh trong lượt chờ / đã được người dùng cho phép hoặc từ chối. */
  | {
      kind: 'permission';
      id: string;
      description: string;
      state: 'pending' | 'allowed' | 'denied';
      reason?: string;
    };

export type TurnStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface Turn {
  id: string;
  agentId: string;
  prompt: string;
  startedAt: string;
  status: TurnStatus;
  parts: TurnPart[];
  errors: string[];
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
  /** Lượt này có được kèm ngữ cảnh chuyển giao từ agent khác không. */
  handoff?: boolean;
  /** Mục nhớ NSA Mem đã chèn vào đầu lượt. */
  memory?: { id: string; title: string }[];
}

export interface Conversation {
  id: string;
  title: string;
  cwd: string;
  permission: PermissionLevel;
  createdAt: string;
  updatedAt: string;
  /** Người dùng đã đồng ý cho agent sửa file trong cuộc trò chuyện này. */
  editConfirmed?: boolean;
  /** Mã phiên CLI theo từng agent, để lượt sau tiếp tục đúng phiên. */
  sessions: Record<string, string>;
  turns: Turn[];
}

/** Áp một sự kiện chuẩn vào lượt (hàm thuần — dùng ở cả lõi lẫn giao diện). */
export function applyEvent(turn: Turn, event: AgentEvent): Turn {
  switch (event.type) {
    case 'text': {
      const index = turn.parts.findIndex((p) => p.kind === 'text' && p.id === event.id);
      if (index === -1) {
        return {
          ...turn,
          parts: [...turn.parts, { kind: 'text', id: event.id, text: event.text }],
        };
      }
      const parts = turn.parts.slice();
      const part = parts[index] as Extract<TurnPart, { kind: 'text' }>;
      parts[index] = { ...part, text: part.text + event.text };
      return { ...turn, parts };
    }
    case 'tool_call': {
      if (turn.parts.some((p) => p.kind === 'tool' && p.id === event.id)) return turn;
      const part: TurnPart = { kind: 'tool', id: event.id, name: event.name, input: event.input };
      return { ...turn, parts: [...turn.parts, part] };
    }
    case 'tool_result':
      return {
        ...turn,
        parts: turn.parts.map((p) =>
          p.kind === 'tool' && p.id === event.id
            ? { ...p, output: event.output, isError: event.isError }
            : p,
        ),
      };
    case 'usage':
      return {
        ...turn,
        usage: {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
        },
      };
    case 'error':
      return { ...turn, errors: [...turn.errors, event.message] };
    case 'notice':
      return {
        ...turn,
        parts: [
          ...turn.parts,
          { kind: 'notice', id: `n${turn.parts.length}`, text: event.message },
        ],
      };
    case 'ask_permission':
      if (turn.parts.some((p) => p.kind === 'permission' && p.id === event.id)) return turn;
      return {
        ...turn,
        parts: [
          ...turn.parts,
          { kind: 'permission', id: event.id, description: event.description, state: 'pending' },
        ],
      };
    case 'permission_result':
      return {
        ...turn,
        parts: turn.parts.map((p) =>
          p.kind === 'permission' && p.id === event.id
            ? {
                ...p,
                state: event.allowed ? 'allowed' : 'denied',
                ...(event.reason ? { reason: event.reason } : {}),
              }
            : p,
        ),
      };
    case 'done':
      return {
        ...turn,
        status: event.cancelled ? 'cancelled' : turn.errors.length > 0 ? 'error' : 'done',
        // Lệnh còn chờ trả lời khi lượt đã xong thì coi như bị từ chối.
        parts: turn.parts.map((p) =>
          p.kind === 'permission' && p.state === 'pending' ? { ...p, state: 'denied' as const } : p,
        ),
      };
    case 'session':
      return turn;
  }
}

/** Toàn bộ văn bản agent trả lời trong một lượt. */
export function turnReply(turn: Turn): string {
  return turn.parts
    .filter((p): p is Extract<TurnPart, { kind: 'text' }> => p.kind === 'text')
    .map((p) => p.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

const HANDOFF_LIMIT = 12_000;

/**
 * Dựng phần ngữ cảnh chuyển giao cho `agentId`: các lượt mà agent này chưa thấy
 * (do agent khác làm, sau lượt gần nhất của chính nó). Trả về null nếu không có gì.
 */
export function buildHandoffContext(
  conversation: Pick<Conversation, 'turns'>,
  agentId: string,
  agentNames: Record<string, string> = {},
): string | null {
  const turns = conversation.turns.filter((t) => t.status !== 'running');
  let lastOwn = -1;
  turns.forEach((t, i) => {
    if (t.agentId === agentId) lastOwn = i;
  });
  const unseen = turns.slice(lastOwn + 1).filter((t) => t.agentId !== agentId);
  if (unseen.length === 0) return null;

  const blocks: string[] = [];
  let used = 0;
  // Lấy từ lượt mới nhất ngược về, dừng khi quá giới hạn.
  for (let i = unseen.length - 1; i >= 0; i--) {
    const t = unseen[i] as Turn;
    const reply =
      turnReply(t) || (t.errors.length ? `(lỗi: ${t.errors.join('; ')})` : '(không có trả lời)');
    const block = `--- ${agentNames[t.agentId] ?? t.agentId} ---\nNgười dùng: ${t.prompt}\nAgent: ${reply}`;
    if (used + block.length > HANDOFF_LIMIT && blocks.length > 0) break;
    blocks.unshift(block.length > HANDOFF_LIMIT ? `${block.slice(0, HANDOFF_LIMIT)}…` : block);
    used += block.length;
  }

  return [
    '[Ngữ cảnh do NSA chuyển giao] Trước lượt này, cuộc trò chuyện được agent khác xử lý.',
    'Đọc để nắm bối cảnh, KHÔNG cần trả lời lại các lượt cũ:',
    ...blocks,
    '[Hết ngữ cảnh]',
  ].join('\n\n');
}

/** Tiêu đề ngắn cho cuộc trò chuyện, lấy từ câu hỏi đầu tiên. */
export function titleFromPrompt(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine || 'Cuộc trò chuyện mới';
}
