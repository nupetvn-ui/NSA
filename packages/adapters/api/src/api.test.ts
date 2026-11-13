import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runContract, type AgentEvent, type AgentAdapter } from '@nsa/adapter-sdk';
import {
  createApiAdapter,
  createApiClient,
  startFakeApiServer,
  type ApiStandard,
  type FakeServer,
  type ToolExecutor,
} from './index.js';

const KEY = 'sk-test-0123456789abcdefSECRET';
let server: FakeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function adapterFor(
  standard: ApiStandard,
  s: FakeServer,
  extra: Partial<Parameters<typeof createApiAdapter>[0]> = {},
): AgentAdapter {
  return createApiAdapter({
    id: `api:fake-${standard}`,
    displayName: `Fake ${standard}`,
    standard,
    baseUrl: standard === 'openai' ? s.openaiUrl : s.anthropicUrl,
    model: 'fake-model',
    getKey: () => KEY,
    keyRequired: true,
    providerName: 'Hãng giả',
    pricing: { inputUsdPer1M: 1, outputUsdPer1M: 2 },
    ...extra,
  });
}

function runOnce(adapter: AgentAdapter, prompt: string, sessionId?: string) {
  const events: AgentEvent[] = [];
  const run = adapter.run(
    { prompt, cwd: process.cwd(), permission: 'read-only', ...(sessionId ? { sessionId } : {}) },
    (e) => events.push(e),
  );
  return run.finished.then(() => events);
}

describe.each(['openai', 'anthropic'] as const)('adapter api — chuẩn %s', (standard) => {
  it('qua bộ test hợp đồng (máy chủ giả): gửi, prompt nguyên văn, resume, huỷ', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nsa-api-'));
    const fakeLog = join(dir, 'log.jsonl');
    writeFileSync(fakeLog, '');
    server = await startFakeApiServer({ fakeLog, expectKey: KEY });
    const results = await runContract(adapterFor(standard, server), {
      mode: 'fake',
      cwd: process.cwd(),
      fakeLog,
      transport: 'http',
    });
    expect(results.filter((r) => r.status === 'failed')).toEqual([]);
    expect(results.find((r) => r.step === 'gate')?.status).toBe('skipped');
  });

  it('stream văn bản, đếm token, ước tính chi phí, gửi key đúng header', async () => {
    server = await startFakeApiServer({
      reply: () => ({ kind: 'text', text: 'Xin chào bạn', inputTokens: 1000, outputTokens: 500 }),
    });
    const events = await runOnce(adapterFor(standard, server), 'chào');
    const text = events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');
    expect(text).toBe('Xin chào bạn');
    expect(events.filter((e) => e.type === 'text').length).toBeGreaterThan(1);
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toEqual({
      type: 'usage',
      inputTokens: 1000,
      outputTokens: 500,
      costUsd: (1000 * 1 + 500 * 2) / 1_000_000,
    });
    const headers = server.requests[0]?.headers ?? {};
    if (standard === 'openai') {
      expect(headers['authorization']).toBe(`Bearer ${KEY}`);
      expect(server.requests[0]?.body['stream_options']).toEqual({ include_usage: true });
    } else {
      expect(headers['x-api-key']).toBe(KEY);
      expect(headers['anthropic-version']).toBeTruthy();
      expect(server.requests[0]?.body['max_tokens']).toBeGreaterThan(0);
    }
  });

  it('lỗi 401 → mã auth, key bị che trong thông báo', async () => {
    server = await startFakeApiServer({
      reply: () => ({
        kind: 'error',
        status: 401,
        body: JSON.stringify({ error: { message: `Invalid key ${KEY}` } }),
      }),
    });
    const events = await runOnce(adapterFor(standard, server), 'chào');
    const error = events.find((e) => e.type === 'error');
    expect(error).toMatchObject({ type: 'error', code: 'auth' });
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(JSON.stringify(events)).toContain('••••CRET');
  });

  it('lỗi 429 (hết hạn mức) → lỗi cli kèm lời giải thích', async () => {
    server = await startFakeApiServer({
      reply: () => ({ kind: 'error', status: 429, body: '{"error":{"message":"quota"}}' }),
    });
    const events = await runOnce(adapterFor(standard, server), 'chào');
    const error = events.find((e) => e.type === 'error');
    expect(error).toMatchObject({ code: 'cli' });
    expect(error?.type === 'error' && error.message).toMatch(/hết hạn mức/);
    expect(events.at(-1)).toEqual({ type: 'done', cancelled: false });
  });

  it('vòng lặp gọi tool: gọi executor, gửi kết quả lại cho model', async () => {
    server = await startFakeApiServer({
      reply: (_r, i) =>
        i === 0
          ? { kind: 'tool', name: 'mem_search', arguments: '{"query":"wifi"}', id: 'call_1' }
          : { kind: 'text', text: 'Tìm thấy rồi' },
    });
    const calls: unknown[] = [];
    const tools: ToolExecutor = {
      list: () => [
        { name: 'mem_search', description: 'Tìm trong bộ nhớ', inputSchema: { type: 'object' } },
      ],
      call: (name, input) => {
        calls.push({ name, input });
        return Promise.resolve({ output: 'mật khẩu wifi: abc', isError: false });
      },
    };
    const adapter = adapterFor(standard, server, { tools, toolCallingStable: true });
    expect(adapter.capabilities().tools).toBe(true);
    expect(adapter.capabilities().editFiles).toBe(false);
    const events = await runOnce(adapter, 'tìm mật khẩu wifi');
    expect(calls).toEqual([{ name: 'mem_search', input: { query: 'wifi' } }]);
    expect(events.filter((e) => e.type === 'tool_call' || e.type === 'tool_result')).toEqual([
      { type: 'tool_call', id: 'call_1', name: 'mem_search', input: '{"query":"wifi"}' },
      { type: 'tool_result', id: 'call_1', output: 'mật khẩu wifi: abc', isError: false },
    ]);
    // Lần gọi thứ hai phải mang kết quả tool.
    expect(server.requests[1]?.raw).toContain('mật khẩu wifi: abc');
    expect(server.requests[1]?.raw).toContain('call_1');
  });

  it('model chưa đánh dấu gọi tool ổn định thì không nhận tool', async () => {
    server = await startFakeApiServer();
    const tools: ToolExecutor = {
      list: () => [{ name: 't', description: 'd', inputSchema: {} }],
      call: () => Promise.resolve({ output: '', isError: false }),
    };
    const adapter = adapterFor(standard, server, { tools });
    expect(adapter.capabilities().tools).toBe(false);
    await runOnce(adapter, 'x');
    expect(server.requests[0]?.body['tools']).toBeUndefined();
  });
});

describe('adapter api — chung', () => {
  it('chưa có key: không gọi mạng, báo lỗi auth', async () => {
    server = await startFakeApiServer();
    const adapter = adapterFor('openai', server, { getKey: () => undefined });
    expect((await adapter.detect()).installed).toBe(false);
    const events = await runOnce(adapter, 'x');
    expect(events[0]).toMatchObject({ type: 'error', code: 'auth' });
    expect(server.requests).toHaveLength(0);
  });

  it('không kết nối được → lỗi cli, vẫn kết thúc bằng done', async () => {
    const adapter = createApiAdapter({
      id: 'api:x',
      displayName: 'x',
      standard: 'openai',
      baseUrl: 'http://127.0.0.1:1',
      model: 'm',
      getKey: () => undefined,
      keyRequired: false,
      providerName: 'Máy cục bộ',
    });
    const events = await runOnce(adapter, 'x');
    expect(events[events.length - 2]).toMatchObject({ type: 'error', code: 'cli' });
    expect(events.at(-1)).toEqual({ type: 'done', cancelled: false });
  });

  it('máy chủ không nhận stream_options → tự thử lại không có nó', async () => {
    server = await startFakeApiServer({
      reply: (r) =>
        r.body['stream_options']
          ? {
              kind: 'error',
              status: 400,
              body: '{"error":{"message":"unknown field stream_options"}}',
            }
          : { kind: 'text', text: 'ok' },
    });
    const events = await runOnce(adapterFor('openai', server), 'x');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(server.requests).toHaveLength(2);
  });

  it('client: embedding và danh sách model', async () => {
    server = await startFakeApiServer({ models: ['a', 'b'] });
    const client = createApiClient({ standard: 'openai', baseUrl: server.openaiUrl, label: 'x' });
    expect(await client.listModels()).toEqual(['a', 'b']);
    expect(await client.embed('e', ['x', 'y'])).toEqual([
      [0, 0.5, 1],
      [1, 0.5, 1],
    ]);
  });
});

describe('che key theo luồng', () => {
  it('key bị cắt qua nhiều mẩu vẫn bị che; văn bản khác giữ nguyên', async () => {
    const { createStreamRedactor } = await import('./index.js');
    const text = `trước ${KEY} sau, sk-te giữa`;
    for (const size of [1, 2, 3, 7]) {
      const r = createStreamRedactor([KEY]);
      let out = '';
      for (let i = 0; i < text.length; i += size) out += r.push(text.slice(i, i + size));
      out += r.flush();
      expect(out).toBe('trước ••••CRET sau, sk-te giữa');
    }
  });
});
