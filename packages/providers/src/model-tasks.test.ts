import { afterEach, describe, expect, it } from 'vitest';
import { createApiAdapter, startFakeApiServer, type FakeServer } from '@nsa/adapter-api';
import type { AgentAdapter } from '@nsa/adapter-sdk';
import {
  ChatService,
  ModelTaskError,
  ModelTaskRunner,
  composePolicies,
  localIdentity,
  memoryAuditLog,
  personalPolicy,
  withModelPolicy,
  type ChatEvent,
  type ModelCandidate,
  type Policy,
} from '@nsa/core';

let servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function provider(reply: 'ok' | 'quota' | 'auth', text = 'NSA-OK') {
  const server = await startFakeApiServer({
    reply: () =>
      reply === 'ok'
        ? { kind: 'text', text, inputTokens: 100, outputTokens: 10 }
        : reply === 'quota'
          ? { kind: 'error', status: 429, body: '{"error":{"message":"Insufficient balance"}}' }
          : { kind: 'error', status: 401, body: '{"error":{"message":"bad key"}}' },
  });
  servers.push(server);
  return server;
}

function apiAgent(id: string, server: FakeServer): AgentAdapter {
  return createApiAdapter({
    id: `api:${id}`,
    displayName: id,
    standard: 'openai',
    baseUrl: server.openaiUrl,
    model: id.split('/')[1] ?? id,
    getKey: () => 'sk-test-key-000000',
    keyRequired: true,
    providerName: id.split('/')[0] ?? id,
  });
}

const identity = localIdentity('tester');
const candidate = (
  id: string,
  adapter: AgentAdapter,
): ModelCandidate & { adapter: AgentAdapter } => ({
  agentId: `api:${id}`,
  providerId: id.split('/')[0] ?? id,
  model: id.split('/')[1] ?? id,
  label: id,
  paid: true,
  adapter,
});

describe('ModelTaskRunner — việc nền chạy theo chuỗi model', () => {
  it('hãng hết hạn mức → tự chuyển model dự phòng, báo người dùng, ghi nhật ký, ghi chi phí', async () => {
    const broken = await provider('quota');
    const cheap = await provider('ok', 'tóm tắt xong');
    const audit = memoryAuditLog();
    const notices: string[] = [];
    const usage: string[] = [];
    const runner = new ModelTaskRunner({
      identity,
      policy: personalPolicy(),
      audit,
      candidates: () => [
        candidate('deepseek/deepseek-flash', apiAgent('deepseek/deepseek-flash', broken)),
        candidate('google/gemini-3.5-flash-lite', apiAgent('google/gemini-3.5-flash-lite', cheap)),
      ],
      onNotice: (m) => notices.push(m),
      onUsage: (c, u) => usage.push(`${c.agentId}:${u.inputTokens}`),
    });
    const out = await runner.runText('background', 'Tóm tắt cuộc trò chuyện');
    expect(out.value).toBe('tóm tắt xong');
    expect(out.candidate.agentId).toBe('api:google/gemini-3.5-flash-lite');
    expect(notices[0]).toMatch(/deepseek-flash không dùng được .*hết hạn mức.*Chuyển sang google/);
    expect(usage).toEqual(['api:google/gemini-3.5-flash-lite:100']);
    expect(audit.entries).toContainEqual(
      expect.objectContaining({
        type: 'fallback',
        kind: 'model',
        from: 'api:deepseek/deepseek-flash',
        to: 'api:google/gemini-3.5-flash-lite',
      }),
    );
    // Mọi lần chọn hãng đều qua ổ cắm chính sách.
    expect(audit.entries.filter((e) => e.type === 'policy')).toHaveLength(2);
  });

  it('chính sách chặn hãng (bản Doanh nghiệp) → không gửi gì cho hãng đó', async () => {
    const blocked = await provider('ok');
    const allowed = await provider('ok', 'từ hãng được phép');
    const policy: Policy = {
      check: ({ action }) =>
        action.kind === 'model.use' && action.providerId === 'deepseek'
          ? { decision: 'deny', reason: 'hãng không nằm trong danh sách được phép' }
          : { decision: 'allow' },
    };
    const runner = new ModelTaskRunner({
      identity,
      policy,
      candidates: () => [
        candidate('deepseek/deepseek-flash', apiAgent('deepseek/deepseek-flash', blocked)),
        candidate('openai/gpt-6-luna', apiAgent('openai/gpt-6-luna', allowed)),
      ],
    });
    const out = await runner.runText('channel', 'xin chào');
    expect(out.value).toBe('từ hãng được phép');
    expect(blocked.requests).toHaveLength(0);
  });

  it('không model nào chạy được → lỗi rõ ràng', async () => {
    const a = await provider('auth');
    const runner = new ModelTaskRunner({
      identity,
      policy: personalPolicy(),
      candidates: () => [candidate('x/y', apiAgent('x/y', a))],
    });
    await expect(runner.runText('background', 'x')).rejects.toBeInstanceOf(ModelTaskError);
    await expect(
      new ModelTaskRunner({ identity, policy: personalPolicy(), candidates: () => [] }).runText(
        'background',
        'x',
      ),
    ).rejects.toThrow(/Nhà cung cấp/);
  });
});

describe('ChatService với agent API', () => {
  it('hãng lỗi giữa lượt chat → chuyển sang model dự phòng của việc chính, ghi fallback', async () => {
    const broken = await provider('quota');
    const backup = await provider('ok', 'Trả lời từ model dự phòng');
    const audit = memoryAuditLog();
    const events: ChatEvent[] = [];
    const a = apiAgent('deepseek/deepseek-flash', broken);
    const b = apiAgent('google/gemini-3.8-flash', backup);
    // Một CLI giả đứng trước trong thứ tự đăng ký: bộ định tuyến vẫn phải theo chuỗi dự phòng.
    const cli: AgentAdapter = {
      ...apiAgent('cli/none', backup),
      id: 'claude',
      displayName: 'Claude Code',
    };
    const chat = new ChatService({
      adapters: [cli, a, b],
      identity,
      audit,
      fallbackOrder: (id) => (id === a.id ? [b.id] : []),
      onEvent: (e) => events.push(e),
    });
    const sent = await chat.send({ agentId: a.id, prompt: 'chào', cwd: process.cwd() });
    expect(sent.status).toBe('started');
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (events.some((e) => e.event.type === 'done')) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });
    const turn = chat.listConversations()[0]?.turns[0];
    expect(turn?.agentId).toBe(b.id);
    expect(turn?.status).toBe('done');
    expect(turn?.parts.some((p) => p.kind === 'notice')).toBe(true);
    expect(audit.entries).toContainEqual(
      expect.objectContaining({ type: 'fallback', kind: 'agent', from: a.id, to: b.id }),
    );
  });

  it('withModelPolicy: lượt chat với agent API hỏi thêm model.use; chặn thì không gọi hãng', async () => {
    const server = await provider('ok');
    const a = apiAgent('deepseek/deepseek-flash', server);
    const seen: string[] = [];
    const base: Policy = {
      check: ({ action }) => {
        seen.push(action.kind);
        return action.kind === 'model.use'
          ? { decision: 'deny', reason: 'chặn DeepSeek' }
          : { decision: 'allow' };
      },
    };
    const chat = new ChatService({
      adapters: [a],
      identity,
      policy: withModelPolicy(composePolicies(personalPolicy(), base), (id) =>
        id === a.id ? { providerId: 'deepseek', model: 'deepseek-flash', paid: true } : undefined,
      ),
    });
    const sent = await chat.send({ agentId: a.id, prompt: 'chào', cwd: process.cwd() });
    expect(sent).toEqual({ status: 'denied', reason: 'chặn DeepSeek' });
    expect(seen).toContain('model.use');
    expect(server.requests).toHaveLength(0);
  });
});
