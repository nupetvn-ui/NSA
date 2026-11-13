/**
 * Máy chủ giả nói đúng chuẩn OpenAI (chat completions, SSE) và chuẩn Anthropic (messages, SSE).
 * Dùng trong `pnpm test` để thử adapter `api` và CLI thật mà không cần key hay mạng.
 * Định dạng sự kiện theo tài liệu chính thức của hai chuẩn (xem ADR-0009).
 */
import { appendFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type FakeReply =
  | { kind: 'text'; text: string; inputTokens?: number; outputTokens?: number }
  | { kind: 'tool'; name: string; arguments: string; id?: string }
  | { kind: 'error'; status: number; body: string }
  /** Gửi một mẩu rồi treo (để thử huỷ). */
  | { kind: 'hang' };

export interface FakeRequest {
  standard: 'openai' | 'anthropic';
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
  raw: string;
}

export interface FakeServerOptions {
  /** Quyết định trả lời gì cho mỗi yêu cầu chat (mặc định: chữ "NSA-OK", "NSA_SLOW" thì treo). */
  reply?: (request: FakeRequest, index: number) => FakeReply;
  /** File nhật ký theo định dạng CLI giả của `runContract` (argv rỗng, stdin = thân yêu cầu). */
  fakeLog?: string;
  /** Key hợp lệ; có thì yêu cầu sai key bị 401. */
  expectKey?: string;
  models?: string[];
}

export interface FakeServer {
  /** Địa chỉ gốc chuẩn OpenAI, ví dụ http://127.0.0.1:1234/v1 */
  openaiUrl: string;
  /** Địa chỉ gốc chuẩn Anthropic, ví dụ http://127.0.0.1:1234/anthropic */
  anthropicUrl: string;
  requests: FakeRequest[];
  close(): Promise<void>;
}

export function defaultFakeReply(request: FakeRequest): FakeReply {
  if (request.raw.includes('NSA_SLOW')) return { kind: 'hang' };
  return { kind: 'text', text: 'NSA-OK', inputTokens: 12, outputTokens: 3 };
}

function sse(res: ServerResponse, data: unknown, event?: string): void {
  res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
}

function keyOf(req: IncomingMessage): string | undefined {
  const x = req.headers['x-api-key'];
  if (typeof x === 'string') return x;
  const auth = req.headers['authorization'];
  return typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '') : undefined;
}

export async function startFakeApiServer(options: FakeServerOptions = {}): Promise<FakeServer> {
  const requests: FakeRequest[] = [];
  const open = new Set<ServerResponse>();
  let chatIndex = 0;

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => {
      const url = (req.url ?? '').split('?')[0] ?? '';
      const standard = url.startsWith('/anthropic') ? 'anthropic' : 'openai';
      const path = url.replace(/^\/anthropic/, '').replace(/^\/v1/, '');
      let body: Record<string, unknown>;
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        res.writeHead(400).end('{"error":{"message":"bad json"}}');
        return;
      }
      const request: FakeRequest = { standard, path, headers: req.headers, body, raw };
      requests.push(request);
      if (options.fakeLog && req.method === 'POST') {
        appendFileSync(
          options.fakeLog,
          `${JSON.stringify({ argv: [], stdin: raw, gateUrl: null })}\n`,
        );
      }
      if (options.expectKey !== undefined && keyOf(req) !== options.expectKey) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
        return;
      }
      if (req.method === 'GET' && /\/models$/.test(path)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: (options.models ?? ['fake-model']).map((id) => ({ id })) }));
        return;
      }
      if (req.method === 'POST' && path === '/embeddings') {
        const input = Array.isArray(body['input']) ? (body['input'] as unknown[]) : [body['input']];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: input.map((_v, index) => ({ index, embedding: [index, 0.5, 1] })),
            usage: { prompt_tokens: input.length * 3 },
          }),
        );
        return;
      }
      const isChat =
        req.method === 'POST' &&
        (standard === 'anthropic' ? path === '/messages' : path === '/chat/completions');
      if (!isChat) {
        res.writeHead(404).end();
        return;
      }

      const reply = (options.reply ?? defaultFakeReply)(request, chatIndex++);
      if (reply.kind === 'error') {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.body);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      open.add(res);
      res.on('close', () => open.delete(res));
      if (standard === 'openai') writeOpenAi(res, reply, body);
      else writeAnthropic(res, reply, body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    openaiUrl: `http://127.0.0.1:${port}/v1`,
    anthropicUrl: `http://127.0.0.1:${port}/anthropic`,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const res of open) res.destroy();
        server.close(() => resolve());
      }),
  };
}

function writeOpenAi(res: ServerResponse, reply: FakeReply, body: Record<string, unknown>): void {
  const id = 'chatcmpl-fake';
  const model = String(body['model'] ?? 'fake');
  const base = { id, object: 'chat.completion.chunk', created: 1794452647, model };
  if (reply.kind === 'hang') {
    sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '1' } }] });
    return;
  }
  if (reply.kind === 'tool') {
    sse(res, {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: reply.id ?? 'call_fake',
                type: 'function',
                function: { name: reply.name, arguments: '' },
              },
            ],
          },
        },
      ],
    });
    const half = Math.ceil(reply.arguments.length / 2);
    for (const part of [reply.arguments.slice(0, half), reply.arguments.slice(half)]) {
      sse(res, {
        ...base,
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: part } }] } },
        ],
      });
    }
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else if (reply.kind === 'text') {
    sse(res, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
    for (const piece of reply.text.match(/.{1,3}/gs) ?? []) {
      sse(res, { ...base, choices: [{ index: 0, delta: { content: piece } }] });
    }
    sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  const streamOptions = body['stream_options'] as { include_usage?: boolean } | undefined;
  if (streamOptions?.include_usage) {
    const usage =
      reply.kind === 'text'
        ? { prompt_tokens: reply.inputTokens ?? 10, completion_tokens: reply.outputTokens ?? 2 }
        : { prompt_tokens: 20, completion_tokens: 5 };
    sse(res, {
      ...base,
      choices: [],
      usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
    });
  }
  res.end('data: [DONE]\n\n');
}

function writeAnthropic(
  res: ServerResponse,
  reply: FakeReply,
  body: Record<string, unknown>,
): void {
  const model = String(body['model'] ?? 'fake');
  const inputTokens = reply.kind === 'text' ? (reply.inputTokens ?? 10) : 20;
  const outputTokens = reply.kind === 'text' ? (reply.outputTokens ?? 2) : 5;
  sse(
    res,
    {
      type: 'message_start',
      message: {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        usage: { input_tokens: inputTokens, output_tokens: 1 },
      },
    },
    'message_start',
  );
  if (reply.kind === 'hang') {
    sse(
      res,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      'content_block_start',
    );
    sse(
      res,
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '1' } },
      'content_block_delta',
    );
    return;
  }
  if (reply.kind === 'tool') {
    sse(
      res,
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: reply.id ?? 'toolu_fake',
          name: reply.name,
          input: {},
        },
      },
      'content_block_start',
    );
    sse(
      res,
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: reply.arguments },
      },
      'content_block_delta',
    );
  } else if (reply.kind === 'text') {
    sse(
      res,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      'content_block_start',
    );
    for (const piece of reply.text.match(/.{1,3}/gs) ?? []) {
      sse(
        res,
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } },
        'content_block_delta',
      );
    }
  }
  sse(res, { type: 'content_block_stop', index: 0 }, 'content_block_stop');
  sse(
    res,
    {
      type: 'message_delta',
      delta: { stop_reason: reply.kind === 'tool' ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputTokens },
    },
    'message_delta',
  );
  sse(res, { type: 'message_stop' }, 'message_stop');
  res.end();
}
