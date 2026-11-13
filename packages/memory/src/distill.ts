/**
 * Tự chắt lọc: khi đạt ngưỡng (kết thúc cuộc trò chuyện, đủ số lượt, người dùng sửa lỗi agent,
 * người dùng dặn nhớ) thì giao một agent — qua adapter sẵn có — đọc đoạn chat và sinh đề xuất
 * ghi nhớ vào hộp duyệt.
 */
import type {
  Conversation,
  DistillSettings,
  MemoryBranch,
  MemoryDraft,
  MemoryEntry,
  MemoryKind,
  MemorySource,
} from '@nsa/core';
import { turnReply } from '@nsa/core';

/** Một đoạn hội thoại cần chắt lọc (từ NSA hoặc nhập từ CLI khác). */
export interface Transcript {
  title: string;
  /** Tham chiếu nguồn, ví dụ `nsa:<mã>` hoặc `claude:<mã phiên>`. */
  ref: string;
  messages: { role: 'user' | 'assistant'; text: string }[];
}

/** Người dùng sửa lỗi agent. */
export const CORRECTION =
  /(^|[\s,.!?])(sai rồi|sai roi|không phải|khong phai|không đúng|khong dung|nhầm rồi|nham roi|bạn nhầm|sửa lại|sua lai|không phải vậy|that'?s wrong|that is wrong|incorrect|not what i|you'?re wrong|no,? that'?s)/i;

/** Người dùng dặn nhớ. */
export const TEACH =
  /(hãy nhớ|hay nho|nhớ giúp|nho giup|ghi nhớ|ghi nho|nhớ rằng|nho rang|nhớ là|nho la|từ nay|tu nay|lần sau|lan sau|luôn luôn|đừng bao giờ|dung bao gio|remember|from now on|always |never )/i;

const TRANSCRIPT_LIMIT = 24_000;

export function conversationTranscript(conversation: Conversation, fromTurn = 0): Transcript {
  const messages: Transcript['messages'] = [];
  for (const turn of conversation.turns.slice(fromTurn)) {
    if (turn.status === 'running') continue;
    messages.push({ role: 'user', text: turn.prompt });
    const reply = turnReply(turn);
    if (reply) messages.push({ role: 'assistant', text: reply });
  }
  return { title: conversation.title, ref: `nsa:${conversation.id}`, messages };
}

/** Prompt giao cho agent chắt lọc. */
export function buildDistillPrompt(
  transcript: Transcript,
  branches: MemoryBranch[],
  known: MemoryEntry[],
): string {
  const blocks: string[] = [];
  let used = 0;
  // Giữ phần cuối nếu quá dài (điều mới nói thường quan trọng hơn).
  for (let i = transcript.messages.length - 1; i >= 0; i--) {
    const m = transcript.messages[i] as Transcript['messages'][number];
    const text = m.text.length > 4000 ? `${m.text.slice(0, 4000)}…` : m.text;
    const block = `${m.role === 'user' ? 'NGƯỜI DÙNG' : 'AGENT'}: ${text}`;
    if (used + block.length > TRANSCRIPT_LIMIT && blocks.length > 0) break;
    blocks.unshift(block);
    used += block.length;
  }
  const knownLines = known
    .slice(0, 40)
    .map((e) => `- [${e.branch}] ${e.title}: ${e.body.replace(/\s+/g, ' ').slice(0, 200)}`);
  return [
    'Bạn là bộ chắt lọc trí nhớ của NSA. Đọc đoạn hội thoại dưới đây giữa người dùng và một agent AI,',
    'rồi rút ra những điều ĐÁNG NHỚ LÂU DÀI về người dùng để mọi agent khác dùng lại sau này:',
    'sở thích, thông tin cá nhân người dùng tự nói, quy ước / quyết định của dự án, điều người dùng',
    'dặn nhớ, và chỗ người dùng sửa lỗi agent (rút thành quy tắc).',
    '',
    'KHÔNG ghi: chi tiết chỉ dùng một lần, nội dung tạm thời, điều agent tự suy đoán mà người dùng',
    'không xác nhận, và điều đã có trong "Bộ nhớ hiện có" (trừ khi người dùng vừa nói điều khác — khi',
    'đó vẫn ghi điều mới, dùng cùng "subject" với mục cũ).',
    'Không làm gì khác, không gọi công cụ nào, không sửa file nào.',
    '',
    'Nhánh có sẵn:',
    ...branches.filter((b) => !b.hidden).map((b) => `- ${b.path}: ${b.title} — ${b.description}`),
    '',
    'Bộ nhớ hiện có:',
    ...(knownLines.length ? knownLines : ['(trống)']),
    '',
    'Trả lời DUY NHẤT một khối JSON đúng dạng sau, không thêm chữ nào khác:',
    '{"memories":[{"branch":"nguoi-dung","title":"tiêu đề ngắn","body":"một câu đầy đủ, tự hiểu được",' +
      '"kind":"fact|preference|rule","subject":"khoa-chu-de-ngan","confidence":0.9,"sensitive":false}]}',
    'kind "rule" = quy tắc agent phải làm / không được làm. confidence: 0.9+ khi người dùng nói rõ;',
    '0.5–0.7 khi chỉ suy ra. sensitive = true nếu có mật khẩu, số tài khoản, giấy tờ, số điện thoại.',
    'Không có gì đáng nhớ thì trả {"memories":[]}.',
    '',
    `=== Hội thoại: ${transcript.title} ===`,
    ...blocks,
    '=== Hết hội thoại ===',
  ].join('\n');
}

/** Đọc JSON đề xuất từ câu trả lời của agent (chịu được khối ```json và chữ thừa). */
export function parseDistillOutput(
  text: string,
  source: MemorySource,
  defaultBranch = 'nguoi-dung',
): MemoryDraft[] {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/g;
  for (const m of text.matchAll(fenced)) if (m[1]) candidates.push(m[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    let data: unknown;
    try {
      data = JSON.parse(candidate);
    } catch {
      continue;
    }
    const list = Array.isArray(data)
      ? data
      : Array.isArray((data as { memories?: unknown }).memories)
        ? (data as { memories: unknown[] }).memories
        : null;
    if (!list) continue;
    return list.flatMap((raw): MemoryDraft[] => {
      if (typeof raw !== 'object' || raw === null) return [];
      const r = raw as Record<string, unknown>;
      const body = typeof r['body'] === 'string' ? r['body'].trim() : '';
      const title = typeof r['title'] === 'string' ? r['title'].trim() : '';
      if (!body && !title) return [];
      const kind: MemoryKind = ['fact', 'preference', 'rule'].includes(String(r['kind']))
        ? (String(r['kind']) as MemoryKind)
        : 'fact';
      const branch =
        typeof r['branch'] === 'string' && /^[a-z0-9][a-z0-9/-]*$/.test(r['branch'])
          ? r['branch']
          : defaultBranch;
      const confidence = Number(r['confidence']);
      return [
        {
          branch,
          title,
          body,
          kind,
          ...(typeof r['subject'] === 'string' && r['subject'] ? { subject: r['subject'] } : {}),
          confidence: Number.isFinite(confidence) ? confidence : 0.6,
          sensitive: r['sensitive'] === true,
          source,
        },
      ];
    });
  }
  throw new Error('Agent chắt lọc không trả về JSON đúng dạng');
}

/** Vì sao một cuộc trò chuyện cần chắt lọc. */
export type DistillReason = 'correction' | 'teach' | 'turns' | 'idle' | 'manual';

/**
 * Theo dõi ngưỡng chắt lọc cho từng cuộc trò chuyện. Không tự chạy agent — gọi `onTrigger`.
 * `progress` (lượt đã chắt lọc tới đâu) được lưu bên ngoài để không chắt lọc lại.
 */
export class DistillScheduler {
  readonly #settings: () => DistillSettings;
  readonly #onTrigger: (conversationId: string, reason: DistillReason) => void;
  readonly #progress: () => Record<string, number>;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: {
    settings: () => DistillSettings;
    progress: () => Record<string, number>;
    onTrigger: (conversationId: string, reason: DistillReason) => void;
  }) {
    this.#settings = options.settings;
    this.#progress = options.progress;
    this.#onTrigger = options.onTrigger;
  }

  /** Gọi khi một lượt kết thúc. */
  turnFinished(conversation: Conversation): void {
    const settings = this.#settings();
    this.#clear(conversation.id);
    if (!settings.enabled) return;
    const done = conversation.turns.filter((t) => t.status !== 'running');
    const from = this.#progress()[conversation.id] ?? 0;
    const fresh = done.slice(from);
    if (fresh.length === 0) return;
    const last = fresh.at(-1);
    const prompt = last?.prompt ?? '';
    if (settings.onCorrection && CORRECTION.test(prompt)) {
      return this.#onTrigger(conversation.id, 'correction');
    }
    if (settings.onTeach && TEACH.test(prompt)) return this.#onTrigger(conversation.id, 'teach');
    if (settings.everyTurns > 0 && fresh.length >= settings.everyTurns) {
      return this.#onTrigger(conversation.id, 'turns');
    }
    if (settings.idleMinutes > 0) {
      const timer = setTimeout(() => {
        this.#timers.delete(conversation.id);
        this.#onTrigger(conversation.id, 'idle');
      }, settings.idleMinutes * 60_000);
      timer.unref?.();
      this.#timers.set(conversation.id, timer);
    }
  }

  /** Người dùng gửi lượt mới — cuộc trò chuyện chưa kết thúc. */
  turnStarted(conversationId: string): void {
    this.#clear(conversationId);
  }

  #clear(conversationId: string): void {
    const timer = this.#timers.get(conversationId);
    if (timer) clearTimeout(timer);
    this.#timers.delete(conversationId);
  }

  dispose(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }
}
