/**
 * Gọi hãng theo chuẩn OpenAI (chat completions) hoặc chuẩn Anthropic (messages), có stream.
 * Không dùng SDK của hãng: chỉ `fetch` + đọc SSE, để một mã chạy được với mọi hãng "tương thích".
 */
import {
  ApiError,
  type ChatMessage,
  type ChatResult,
  type Endpoint,
  type ToolCall,
  type ToolSpec,
  type Usage,
} from './types.js';

export type FetchLike = typeof fetch;

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** Nhận từng mẩu văn bản khi model đang viết. */
  onText?: (delta: string) => void;
}

/** Phiên bản API Anthropic gửi kèm header `anthropic-version`. */
export const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 8192;
const ERROR_BODY_LIMIT = 600;

export interface ApiClient {
  chat(request: ChatRequest): Promise<ChatResult>;
  /** Embedding (chỉ chuẩn OpenAI: `POST /embeddings`). */
  embed(model: string, input: string[], signal?: AbortSignal): Promise<number[][]>;
  /** Danh sách model hãng trả về (`GET /models`). */
  listModels(signal?: AbortSignal): Promise<string[]>;
}

export function createApiClient(endpoint: Endpoint, fetchImpl: FetchLike = fetch): ApiClient {
  const base = endpoint.baseUrl.replace(/\/+$/, '');
  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (endpoint.standard === 'anthropic') {
      h['anthropic-version'] = ANTHROPIC_VERSION;
      if (endpoint.apiKey) h['x-api-key'] = endpoint.apiKey;
    } else if (endpoint.apiKey) {
      h['authorization'] = `Bearer ${endpoint.apiKey}`;
    }
    return h;
  };

  const request = async (
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal | undefined },
  ): Promise<Response> => {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: init.method,
        headers: headers(),
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
      });
    } catch (err) {
      if (init.signal?.aborted) throw err;
      throw new ApiError(
        'network',
        `Không kết nối được ${endpoint.label} (${base}): ${errorText(err)}`,
      );
    }
    if (!response.ok) throw await httpError(endpoint.label, response);
    return response;
  };

  const v1 = endpoint.standard === 'anthropic' ? '/v1' : '';

  return {
    async chat(req) {
      if (endpoint.standard === 'anthropic') {
        const response = await request(`${v1}/messages`, {
          method: 'POST',
          body: anthropicBody(req),
          signal: req.signal,
        });
        return readAnthropicStream(response, req.onText);
      }
      const body = openAiBody(req, true);
      let response: Response;
      try {
        response = await request('/chat/completions', {
          method: 'POST',
          body,
          signal: req.signal,
        });
      } catch (err) {
        // Một số máy chủ "tương thích OpenAI" không nhận stream_options: thử lại không có nó.
        if (
          err instanceof ApiError &&
          err.kind === 'request' &&
          /stream_options/i.test(err.message)
        ) {
          response = await request('/chat/completions', {
            method: 'POST',
            body: openAiBody(req, false),
            signal: req.signal,
          });
        } else {
          throw err;
        }
      }
      return readOpenAiStream(response, req.onText);
    },

    async embed(model, input, signal) {
      if (endpoint.standard !== 'openai') {
        throw new ApiError('request', `${endpoint.label}: embedding chỉ hỗ trợ chuẩn OpenAI`);
      }
      const response = await request('/embeddings', {
        method: 'POST',
        body: { model, input },
        signal,
      });
      const json = (await response.json()) as { data?: { embedding?: number[]; index?: number }[] };
      if (!Array.isArray(json.data))
        throw new ApiError('protocol', 'Trả lời embedding không có data');
      return [...json.data]
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((d) => (Array.isArray(d.embedding) ? d.embedding : []));
    },

    async listModels(signal) {
      const response = await request(`${v1}/models`, { method: 'GET', signal });
      const json = (await response.json()) as { data?: { id?: unknown }[] };
      return (json.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string');
    },
  };
}

// ---------------------------------------------------------------- lỗi HTTP

async function httpError(label: string, response: Response): Promise<ApiError> {
  let detail = '';
  try {
    detail = (await response.text()).slice(0, ERROR_BODY_LIMIT);
  } catch {
    // bỏ qua
  }
  try {
    const json = JSON.parse(detail) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    const msg =
      typeof json.error === 'string'
        ? json.error
        : typeof json.error?.message === 'string'
          ? json.error.message
          : typeof json.message === 'string'
            ? json.message
            : null;
    if (msg) detail = msg;
  } catch {
    // không phải JSON
  }
  const s = response.status;
  const kind =
    s === 401 || s === 403
      ? 'auth'
      : s === 402 || s === 429
        ? 'quota'
        : s >= 500
          ? 'server'
          : 'request';
  const what: Record<typeof kind, string> = {
    auth: 'key không hợp lệ, hết hạn hoặc không có quyền',
    quota: 'hết hạn mức / quá giới hạn tốc độ / hết tiền trong tài khoản',
    server: 'máy chủ của hãng đang lỗi',
    request: 'yêu cầu bị từ chối',
  };
  return new ApiError(
    kind,
    `${label}: ${what[kind]} (HTTP ${s})${detail ? ` — ${detail}` : ''}`,
    s,
  );
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
    return cause?.code ?? cause?.message ?? err.message;
  }
  return String(err);
}

// ---------------------------------------------------------------- SSE

/** Đọc luồng Server-Sent Events: trả về từng cặp (event, data). */
export async function* readSse(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<{ event: string; data: string }> {
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      let nl: number;
      while ((nl = buffer.search(/\r?\n/)) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(buffer[nl] === '\r' ? nl + 2 : nl + 1);
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = '';
          data = [];
        } else if (line.startsWith(':')) {
          // chú thích / giữ kết nối
        } else {
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const val = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = val;
          else if (field === 'data') data.push(val);
        }
      }
      if (done) break;
    }
    if (data.length) yield { event, data: data.join('\n') };
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------- chuẩn OpenAI

function openAiMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    switch (m.role) {
      case 'system':
        return { role: 'system', content: m.content };
      case 'user':
        return m.images?.length
          ? {
              role: 'user',
              content: [
                { type: 'text', text: m.content },
                ...m.images.map((img) => ({
                  type: 'image_url',
                  image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
                })),
              ],
            }
          : { role: 'user', content: m.content };
      case 'assistant':
        return {
          role: 'assistant',
          content: m.content || null,
          ...(m.toolCalls?.length
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: c.arguments },
                })),
              }
            : {}),
        };
      case 'tool':
        return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
    }
  });
}

function openAiBody(req: ChatRequest, streamOptions: boolean): Record<string, unknown> {
  return {
    model: req.model,
    messages: openAiMessages(req.messages),
    stream: true,
    ...(streamOptions ? { stream_options: { include_usage: true } } : {}),
    ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
    ...(req.tools?.length
      ? {
          tools: req.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
        }
      : {}),
  };
}

interface OpenAiChunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string };
}

export async function readOpenAiStream(
  response: Response,
  onText?: (delta: string) => void,
): Promise<ChatResult> {
  let text = '';
  const calls = new Map<number, ToolCall>();
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: string | null = null;
  let chunks = 0;
  for await (const { data } of readSse(response.body)) {
    if (data.trim() === '[DONE]') break;
    let chunk: OpenAiChunk;
    try {
      chunk = JSON.parse(data) as OpenAiChunk;
    } catch {
      continue;
    }
    chunks++;
    if (chunk.error) throw new ApiError('server', chunk.error.message ?? 'Hãng báo lỗi giữa chừng');
    if (chunk.usage) {
      usage.inputTokens = chunk.usage.prompt_tokens ?? usage.inputTokens;
      usage.outputTokens = chunk.usage.completion_tokens ?? usage.outputTokens;
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      if (delta?.content) {
        text += delta.content;
        onText?.(delta.content);
      }
      for (const tc of delta?.tool_calls ?? []) {
        const index = tc.index ?? 0;
        const call = calls.get(index) ?? { id: '', name: '', arguments: '' };
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name += tc.function.name;
        if (tc.function?.arguments) call.arguments += tc.function.arguments;
        calls.set(index, call);
      }
      if (choice.finish_reason) stopReason = choice.finish_reason;
    }
  }
  if (chunks === 0) throw new ApiError('protocol', 'Hãng không trả về dữ liệu stream nào');
  const toolCalls = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([i, c]) => ({ ...c, id: c.id || `call_${i}` }));
  return { text, toolCalls, usage, stopReason };
}

// ---------------------------------------------------------------- chuẩn Anthropic

function safeJson(text: string): unknown {
  try {
    return text ? (JSON.parse(text) as unknown) : {};
  } catch {
    return {};
  }
}

function anthropicMessages(messages: ChatMessage[]): { system: string; messages: unknown[] } {
  const system = messages
    .filter((m): m is Extract<ChatMessage, { role: 'system' }> => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const out: { role: 'user' | 'assistant'; content: unknown[] }[] = [];
  const push = (role: 'user' | 'assistant', block: unknown): void => {
    const last = out.at(-1);
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') {
      for (const img of m.images ?? []) {
        push('user', {
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
        });
      }
      push('user', { type: 'text', text: m.content });
    } else if (m.role === 'assistant') {
      if (m.content) push('assistant', { type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) {
        push('assistant', {
          type: 'tool_use',
          id: c.id,
          name: c.name,
          input: safeJson(c.arguments),
        });
      }
    } else {
      push('user', {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
        ...(m.isError ? { is_error: true } : {}),
      });
    }
  }
  return { system, messages: out };
}

function anthropicBody(req: ChatRequest): Record<string, unknown> {
  const { system, messages } = anthropicMessages(req.messages);
  return {
    model: req.model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
    ...(system ? { system } : {}),
    messages,
    ...(req.tools?.length
      ? {
          tools: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.inputSchema,
          })),
        }
      : {}),
  };
}

interface AnthropicEvent {
  type?: string;
  index?: number;
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  content_block?: { type?: string; id?: string; name?: string; text?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

export async function readAnthropicStream(
  response: Response,
  onText?: (delta: string) => void,
): Promise<ChatResult> {
  let text = '';
  const calls = new Map<number, ToolCall>();
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: string | null = null;
  let events = 0;
  for await (const { data } of readSse(response.body)) {
    let e: AnthropicEvent;
    try {
      e = JSON.parse(data) as AnthropicEvent;
    } catch {
      continue;
    }
    events++;
    switch (e.type) {
      case 'message_start':
        usage.inputTokens = e.message?.usage?.input_tokens ?? 0;
        usage.outputTokens = e.message?.usage?.output_tokens ?? 0;
        break;
      case 'content_block_start':
        if (e.content_block?.type === 'tool_use') {
          calls.set(e.index ?? 0, {
            id: e.content_block.id ?? `toolu_${e.index ?? 0}`,
            name: e.content_block.name ?? '',
            arguments: '',
          });
        } else if (e.content_block?.type === 'text' && e.content_block.text) {
          text += e.content_block.text;
          onText?.(e.content_block.text);
        }
        break;
      case 'content_block_delta':
        if (e.delta?.type === 'text_delta' && e.delta.text) {
          text += e.delta.text;
          onText?.(e.delta.text);
        } else if (e.delta?.type === 'input_json_delta') {
          const call = calls.get(e.index ?? 0);
          if (call) call.arguments += e.delta.partial_json ?? '';
        }
        break;
      case 'message_delta':
        // Số token trong message_delta là số cộng dồn (tài liệu streaming của Anthropic).
        if (e.usage?.output_tokens !== undefined) usage.outputTokens = e.usage.output_tokens;
        if (e.usage?.input_tokens !== undefined) usage.inputTokens = e.usage.input_tokens;
        if (e.delta?.stop_reason) stopReason = e.delta.stop_reason;
        break;
      case 'error': {
        const overloaded =
          e.error?.type === 'overloaded_error' || e.error?.type === 'rate_limit_error';
        throw new ApiError(
          overloaded ? 'quota' : 'server',
          e.error?.message ?? 'Hãng báo lỗi giữa chừng',
        );
      }
    }
  }
  if (events === 0) throw new ApiError('protocol', 'Hãng không trả về dữ liệu stream nào');
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
  return { text, toolCalls, usage, stopReason };
}
