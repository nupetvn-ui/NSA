/**
 * Adapter `api`: gọi thẳng một model qua API key, theo đúng hợp đồng adapter của NSA
 * (cùng luồng sự kiện chuẩn, nên đi qua ổ cắm chính sách + nhật ký như mọi adapter CLI).
 *
 * Dùng cho việc không cần agent đầy đủ: chat thường, chắt lọc bộ nhớ, mô tả ảnh, kênh chat.
 * Không đọc/sửa file: `editFiles` luôn false. Tool chỉ có khi được cấp `ToolExecutor`
 * (giai đoạn 3: cổng MCP của NSA) VÀ model được đánh dấu gọi tool ổn định.
 */
import { randomUUID } from 'node:crypto';
import type {
  AgentAdapter,
  AgentEvent,
  AgentRun,
  Capabilities,
  DetectResult,
} from '@nsa/adapter-sdk';
import { createApiClient, type FetchLike } from './client.js';
import {
  ApiError,
  type ApiStandard,
  type ChatMessage,
  type ToolExecutor,
  type Usage,
} from './types.js';

/** Nơi giữ lịch sử hội thoại theo mã phiên (API không tự nhớ). */
export interface ApiSessionStore {
  get(sessionId: string): ChatMessage[] | undefined;
  set(sessionId: string, messages: ChatMessage[]): void;
}

export function memorySessionStore(): ApiSessionStore {
  const map = new Map<string, ChatMessage[]>();
  return { get: (id) => map.get(id), set: (id, m) => void map.set(id, m) };
}

export interface ApiAdapterOptions {
  /** Mã agent, ví dụ `api:deepseek/deepseek-flash`. */
  id: string;
  displayName: string;
  standard: ApiStandard;
  baseUrl: string;
  model: string;
  /** Lấy key ngay lúc chạy (từ kho khoá) — adapter không giữ key lâu hơn một lượt. */
  getKey: () => string | undefined;
  keyRequired: boolean;
  /** Tên hãng trong thông báo. */
  providerName: string;
  /** Giá (USD / 1 triệu token) để ước tính chi phí; null = chưa biết. */
  pricing?: { inputUsdPer1M: number | null; outputUsdPer1M: number | null };
  vision?: boolean;
  /** Model đã được đánh dấu gọi tool ổn định. */
  toolCallingStable?: boolean;
  /** Vòng lặp gọi tool (giai đoạn 3 nối MCP gateway). */
  tools?: ToolExecutor;
  sessions?: ApiSessionStore;
  systemPrompt?: string;
  maxTokens?: number;
  /** Số vòng gọi tool tối đa trong một lượt. */
  maxToolRounds?: number;
  fetch?: FetchLike;
}

const SESSION_ID = /^[A-Za-z0-9][\w-]{7,63}$/;
/** Giữ lịch sử vừa phải để không gửi quá nhiều token mỗi lượt. */
const HISTORY_CHAR_LIMIT = 120_000;

/** Che key trong văn bản (thông báo lỗi của hãng đôi khi in lại key). */
export function redactKey(text: string, key: string | undefined): string {
  if (!key || key.length < 6) return text;
  const tail = key.slice(-4);
  let out = text;
  for (const form of [key, encodeURIComponent(key), Buffer.from(key).toString('base64')]) {
    out = out.split(form).join(`••••${tail}`);
  }
  return out;
}

/**
 * Che key trong văn bản đến từng mẩu (stream): một key có thể bị cắt qua nhiều mẩu, nên giữ lại
 * phần đuôi có thể là đầu của key cho tới khi chắc chắn. `flush` khi mẩu cuối đã đến.
 */
export function createStreamRedactor(secrets: readonly string[]): {
  push(delta: string): string;
  flush(): string;
} {
  const forms = secrets
    .filter((s) => s.length >= 6)
    .flatMap((s) => [s, encodeURIComponent(s), Buffer.from(s).toString('base64')]);
  let pending = '';
  const redact = (text: string): string => secrets.reduce((out, s) => redactKey(out, s), text);
  return {
    push(delta) {
      pending = redact(pending + delta);
      // Đuôi dài nhất của `pending` trùng với phần đầu của một dạng key → giữ lại.
      let keep = 0;
      for (const form of forms) {
        for (let n = Math.min(form.length - 1, pending.length); n > keep; n--) {
          if (pending.endsWith(form.slice(0, n))) {
            keep = n;
            break;
          }
        }
      }
      const out = pending.slice(0, pending.length - keep);
      pending = pending.slice(pending.length - keep);
      return out;
    },
    flush() {
      const out = redact(pending);
      pending = '';
      return out;
    },
  };
}

function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  let total = 0;
  let start = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as ChatMessage;
    total += m.content.length;
    if (total > HISTORY_CHAR_LIMIT) break;
    start = i;
  }
  // Không bắt đầu bằng kết quả tool mồ côi.
  while (start < messages.length && messages[start]?.role !== 'user') start++;
  return messages.slice(start);
}

function costOf(pricing: ApiAdapterOptions['pricing'], usage: Usage): number | undefined {
  if (!pricing || pricing.inputUsdPer1M === null || pricing.outputUsdPer1M === null)
    return undefined;
  return (
    (usage.inputTokens * pricing.inputUsdPer1M + usage.outputTokens * pricing.outputUsdPer1M) /
    1_000_000
  );
}

export function createApiAdapter(options: ApiAdapterOptions): AgentAdapter {
  const sessions = options.sessions ?? memorySessionStore();
  const maxRounds = options.maxToolRounds ?? 8;

  const capabilities = (): Capabilities => ({
    streaming: true,
    resume: true,
    tools: options.tools !== undefined && options.toolCallingStable === true,
    editFiles: false,
    images: options.vision === true,
    mcp: false,
    subagents: false,
    toolGate: false,
    tier: 'protocol',
  });

  return {
    id: options.id,
    displayName: options.displayName,

    async detect(): Promise<DetectResult> {
      const key = options.getKey();
      if (options.keyRequired && !key) {
        return {
          installed: false,
          ready: false,
          note: `Chưa có key ${options.providerName} — mở Nhà cung cấp để dán key.`,
        };
      }
      return { installed: true, ready: true, version: options.model };
    },

    capabilities,

    run(runOptions, onEvent): AgentRun {
      const controller = new AbortController();
      let finished = false;
      let cancelled = false;
      const key = options.getKey();
      const emit = (event: AgentEvent): void => {
        if (finished) return;
        // Không để key lọt vào bất cứ sự kiện nào (nhật ký, lịch sử chat, giao diện).
        if (event.type === 'error' || event.type === 'notice') {
          onEvent({ ...event, message: redactKey(event.message, key) });
        } else if (event.type === 'text') {
          onEvent({ ...event, text: redactKey(event.text, key) });
        } else {
          onEvent(event);
        }
      };

      const work = async (): Promise<void> => {
        if (options.keyRequired && !key) {
          emit({
            type: 'error',
            code: 'auth',
            message: `Chưa có key ${options.providerName}. Mở Nhà cung cấp để dán key.`,
          });
          return;
        }
        const client = createApiClient(
          {
            standard: options.standard,
            baseUrl: options.baseUrl,
            label: options.providerName,
            ...(key ? { apiKey: key } : {}),
          },
          options.fetch,
        );

        const resumeId =
          runOptions.sessionId && SESSION_ID.test(runOptions.sessionId)
            ? runOptions.sessionId
            : undefined;
        const history = resumeId ? (sessions.get(resumeId) ?? []) : [];
        const sessionId = resumeId ?? `api-${randomUUID()}`;
        emit({ type: 'session', sessionId });

        const conversation: ChatMessage[] = [
          ...history,
          { role: 'user', content: runOptions.prompt },
        ];
        const system: ChatMessage[] = options.systemPrompt
          ? [{ role: 'system', content: options.systemPrompt }]
          : [];
        const tools =
          options.tools && capabilities().tools ? await options.tools.list() : undefined;
        const usage: Usage = { inputTokens: 0, outputTokens: 0 };

        try {
          for (let round = 0; round <= maxRounds; round++) {
            const textId = `${sessionId}-${conversation.length}`;
            const redactor = createStreamRedactor(key ? [key] : []);
            const emitText = (text: string): void => {
              if (text) emit({ type: 'text', id: textId, text });
            };
            let result;
            try {
              result = await client.chat({
                model: options.model,
                messages: [...system, ...conversation],
                ...(tools?.length && round < maxRounds ? { tools } : {}),
                ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
                signal: controller.signal,
                onText: (delta) => emitText(redactor.push(delta)),
              });
            } finally {
              emitText(redactor.flush());
            }
            usage.inputTokens += result.usage.inputTokens;
            usage.outputTokens += result.usage.outputTokens;
            conversation.push({
              role: 'assistant',
              content: redactKey(result.text, key),
              ...(result.toolCalls.length ? { toolCalls: result.toolCalls } : {}),
            });
            if (!result.toolCalls.length || !options.tools || !tools?.length) break;

            for (const call of result.toolCalls) {
              emit({ type: 'tool_call', id: call.id, name: call.name, input: call.arguments });
              let output: { output: string; isError: boolean };
              try {
                let input: unknown = {};
                try {
                  input = call.arguments ? (JSON.parse(call.arguments) as unknown) : {};
                } catch {
                  throw new Error('Tham số tool không phải JSON hợp lệ');
                }
                output = await options.tools.call(call.name, input, controller.signal);
              } catch (err) {
                output = {
                  output: String(err instanceof Error ? err.message : err),
                  isError: true,
                };
              }
              emit({ type: 'tool_result', id: call.id, ...output });
              conversation.push({
                role: 'tool',
                toolCallId: call.id,
                name: call.name,
                content: redactKey(output.output, key),
                isError: output.isError,
              });
            }
          }
        } finally {
          // Lưu lịch sử kể cả khi lỗi giữa chừng — lượt sau vẫn tiếp tục được.
          if (!cancelled) sessions.set(sessionId, trimHistory(conversation));
          if (usage.inputTokens || usage.outputTokens) {
            const costUsd = costOf(options.pricing, usage);
            emit({ type: 'usage', ...usage, ...(costUsd !== undefined ? { costUsd } : {}) });
          }
        }
      };

      const finishedPromise = work()
        .catch((err: unknown) => {
          if (cancelled) return;
          const kind = err instanceof ApiError ? err.kind : 'network';
          const message = err instanceof Error ? err.message : String(err);
          emit({
            type: 'error',
            // `auth` → bộ định tuyến đổi model; các lỗi khác (`cli`) cũng đổi khi chưa có trả lời.
            code: kind === 'auth' ? 'auth' : kind === 'protocol' ? 'protocol' : 'cli',
            message,
          });
        })
        .finally(() => {
          emit({ type: 'done', cancelled });
          finished = true;
        });

      return {
        cancel() {
          if (finished || cancelled) return;
          cancelled = true;
          controller.abort();
        },
        finished: finishedPromise,
      };
    },
  };
}
