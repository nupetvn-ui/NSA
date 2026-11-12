import { describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentEvent, RunOptions } from '@nsa/adapter-sdk';
import {
  ChatService,
  applyEvent,
  buildHandoffContext,
  localIdentity,
  memoryAuditLog,
  type ChatEvent,
  type ChatServiceOptions,
  type Conversation,
  type Policy,
  type SendResult,
  type Turn,
} from './index.js';

function emptyTurn(agentId = 'a'): Turn {
  return { id: 't', agentId, prompt: 'p', startedAt: '', status: 'running', parts: [], errors: [] };
}

describe('applyEvent', () => {
  it('nối văn bản cùng id, ghép kết quả công cụ, đặt trạng thái khi xong', () => {
    const events: AgentEvent[] = [
      { type: 'text', id: 'm1', text: 'Xin ' },
      { type: 'text', id: 'm1', text: 'chào' },
      { type: 'tool_call', id: 'c1', name: 'shell', input: 'ls' },
      { type: 'tool_result', id: 'c1', output: 'a.txt', isError: false },
      { type: 'done', cancelled: false },
    ];
    const turn = events.reduce(applyEvent, emptyTurn());
    expect(turn.status).toBe('done');
    expect(turn.parts).toEqual([
      { kind: 'text', id: 'm1', text: 'Xin chào' },
      { kind: 'tool', id: 'c1', name: 'shell', input: 'ls', output: 'a.txt', isError: false },
    ]);
  });

  it('có lỗi thì trạng thái là error; huỷ thì cancelled', () => {
    const withError = [
      { type: 'error', message: 'hỏng' },
      { type: 'done', cancelled: false },
    ] as AgentEvent[];
    expect(withError.reduce(applyEvent, emptyTurn()).status).toBe('error');
    expect(applyEvent(emptyTurn(), { type: 'done', cancelled: true }).status).toBe('cancelled');
  });
});

describe('buildHandoffContext', () => {
  const done = (agentId: string, prompt: string, reply: string): Turn => ({
    ...emptyTurn(agentId),
    prompt,
    status: 'done',
    parts: [{ kind: 'text', id: 'x', text: reply }],
  });

  it('agent chưa từng tham gia nhận toàn bộ các lượt trước', () => {
    const ctx = buildHandoffContext({ turns: [done('codex', 'Câu 1', 'Đáp 1')] }, 'claude', {
      codex: 'Codex',
    });
    expect(ctx).toContain('--- Codex ---');
    expect(ctx).toContain('Người dùng: Câu 1');
    expect(ctx).toContain('Agent: Đáp 1');
  });

  it('chỉ chuyển các lượt agent chưa thấy; không có gì thì trả null', () => {
    const turns = [done('claude', 'C1', 'R1'), done('codex', 'C2', 'R2')];
    const ctx = buildHandoffContext({ turns }, 'claude');
    expect(ctx).toContain('C2');
    expect(ctx).not.toContain('C1');
    expect(buildHandoffContext({ turns }, 'codex')).toBeNull();
  });
});

/** Adapter giả: ghi lại tham số nhận được và phát sẵn một chuỗi sự kiện. */
function fakeAdapter(id: string, reply: string, calls: RunOptions[]): AgentAdapter {
  return {
    id,
    displayName: id.toUpperCase(),
    detect: () => Promise.resolve({ installed: true, ready: true, version: '1.0' }),
    capabilities: () => ({
      streaming: false,
      resume: true,
      tools: true,
      editFiles: true,
      images: false,
      mcp: false,
      subagents: false,
      toolGate: false,
      tier: 'headless' as const,
    }),
    run(options, onEvent) {
      calls.push(options);
      onEvent({ type: 'session', sessionId: `${id}-session` });
      onEvent({ type: 'text', id: 'm', text: reply });
      onEvent({ type: 'done', cancelled: false });
      return { cancel: () => undefined, finished: Promise.resolve() };
    },
  };
}

const identity = localIdentity('tester');
const allowAll: Policy = { check: () => ({ decision: 'allow' }) };

function service(options: Partial<ChatServiceOptions> & Pick<ChatServiceOptions, 'adapters'>) {
  return new ChatService({ identity, policy: allowAll, ...options });
}

function started(result: SendResult) {
  if (result.status !== 'started') throw new Error(`mong đợi started, nhận ${result.status}`);
  return result;
}

describe('ChatService', () => {
  it('giữ phiên theo agent và chuyển ngữ cảnh khi đổi agent', async () => {
    const claudeCalls: RunOptions[] = [];
    const codexCalls: RunOptions[] = [];
    const events: ChatEvent[] = [];
    let saved: Conversation[] = [];
    let n = 0;
    const chat = service({
      adapters: [
        fakeAdapter('claude', 'Kế hoạch: A, B', claudeCalls),
        fakeAdapter('codex', 'Đã làm A', codexCalls),
      ],
      store: { load: () => [], save: (c) => (saved = c) },
      onEvent: (e) => events.push(e),
      newId: () => `id${++n}`,
    });

    const first = started(
      await chat.send({ agentId: 'claude', prompt: 'Lập kế hoạch', cwd: 'D:/proj' }),
    );
    const id = first.conversationId;
    await chat.send({ conversationId: id, agentId: 'codex', prompt: 'Làm bước A' });
    await chat.send({ conversationId: id, agentId: 'claude', prompt: 'Kiểm lại' });

    // Codex chưa có phiên → nhận ngữ cảnh chuyển giao chứa câu trả lời của Claude.
    expect(codexCalls[0]?.sessionId).toBeUndefined();
    expect(codexCalls[0]?.prompt).toContain('Kế hoạch: A, B');
    expect(codexCalls[0]?.prompt).toContain('Làm bước A');
    // Claude quay lại: tiếp tục phiên cũ và chỉ nhận phần Codex đã làm.
    expect(claudeCalls[1]?.sessionId).toBe('claude-session');
    expect(claudeCalls[1]?.prompt).toContain('Đã làm A');
    expect(claudeCalls[1]?.prompt).not.toContain('Lập kế hoạch');

    const [conversation] = chat.listConversations();
    expect(conversation?.turns.map((t) => [t.agentId, t.status, t.handoff ?? false])).toEqual([
      ['claude', 'done', false],
      ['codex', 'done', true],
      ['claude', 'done', true],
    ]);
    expect(conversation?.cwd).toBe('D:/proj');
    expect(saved).toHaveLength(1);
    expect(events.filter((e) => e.event.type === 'done')).toHaveLength(3);
  });

  it('báo lỗi khi thiếu thư mục hoặc agent không tồn tại', async () => {
    const chat = service({ adapters: [fakeAdapter('claude', 'x', [])] });
    await expect(chat.send({ agentId: 'claude', prompt: 'hi' })).rejects.toThrow(/thư mục/);
    await expect(chat.send({ agentId: 'gpt', prompt: 'hi', cwd: '.' })).rejects.toThrow(/agent/);
  });

  it('lượt đang chạy khi app tắt được đánh dấu đã huỷ khi mở lại', () => {
    const stored: Conversation = {
      id: 'c',
      title: 't',
      cwd: '.',
      permission: 'read-only',
      createdAt: '',
      updatedAt: '',
      sessions: {},
      turns: [emptyTurn()],
    };
    const chat = service({ adapters: [], store: { load: () => [stored], save: () => undefined } });
    expect(chat.listConversations()[0]?.turns[0]?.status).toBe('cancelled');
  });
});

describe('ChatService + ổ cắm chính sách', () => {
  it('chính sách trả "chặn" thì KHÔNG lệnh nào chạy, kể cả khi người dùng đã xác nhận', async () => {
    const calls: RunOptions[] = [];
    const audit = memoryAuditLog();
    const denyAll: Policy = { check: () => ({ decision: 'deny', reason: 'cấm thử nghiệm' }) };
    const chat = service({ adapters: [fakeAdapter('codex', 'x', calls)], policy: denyAll, audit });

    for (const permission of ['read-only', 'edit'] as const) {
      for (const confirmed of [false, true]) {
        const result = await chat.send({
          agentId: 'codex',
          prompt: 'rm -rf',
          cwd: 'D:/proj',
          permission,
          confirmed,
        });
        expect(result).toEqual({ status: 'denied', reason: 'cấm thử nghiệm' });
      }
    }
    // adapter.run chưa từng được gọi, không có cuộc trò chuyện nào được tạo.
    expect(calls).toHaveLength(0);
    expect(chat.listConversations()).toHaveLength(0);
    const decisions = audit.entries.flatMap((e) => (e.type === 'policy' ? [e.decision] : []));
    expect(decisions).toEqual(['deny', 'deny', 'deny', 'deny']);
  });

  it('chính sách lỗi thì coi như chặn', async () => {
    const calls: RunOptions[] = [];
    const broken: Policy = {
      check: () => {
        throw new Error('hỏng');
      },
    };
    const chat = service({ adapters: [fakeAdapter('codex', 'x', calls)], policy: broken });
    const result = await chat.send({ agentId: 'codex', prompt: 'hi', cwd: '.' });
    expect(result.status).toBe('denied');
    expect(calls).toHaveLength(0);
  });

  it('chặn cả lượt sau trong cuộc trò chuyện đã có', async () => {
    const calls: RunOptions[] = [];
    let allow = true;
    const toggle: Policy = {
      check: () => (allow ? { decision: 'allow' } : { decision: 'deny', reason: 'tắt' }),
    };
    const chat = service({ adapters: [fakeAdapter('codex', 'x', calls)], policy: toggle });
    const first = started(await chat.send({ agentId: 'codex', prompt: 'a', cwd: '.' }));
    allow = false;
    const second = await chat.send({
      conversationId: first.conversationId,
      agentId: 'codex',
      prompt: 'b',
    });
    expect(second.status).toBe('denied');
    expect(calls).toHaveLength(1);
    expect(chat.listConversations()[0]?.turns).toHaveLength(1);
  });

  it('"hỏi" thì chưa chạy; xác nhận thì chạy; lượt sau cùng cuộc trò chuyện không hỏi lại', async () => {
    const calls: RunOptions[] = [];
    // Không truyền policy → dùng chính sách mặc định bản Cá nhân.
    const chat = new ChatService({ identity, adapters: [fakeAdapter('codex', 'x', calls)] });
    const request = {
      agentId: 'codex',
      prompt: 'sửa',
      cwd: 'D:/proj',
      permission: 'edit' as const,
    };

    const asked = await chat.send(request);
    expect(asked.status).toBe('needs_confirmation');
    expect(calls).toHaveLength(0);

    const ok = started(await chat.send({ ...request, confirmed: true }));
    expect(calls).toHaveLength(1);

    const again = await chat.send({
      conversationId: ok.conversationId,
      agentId: 'codex',
      prompt: 'tiếp',
    });
    expect(again.status).toBe('started');
    expect(calls[1]?.permission).toBe('edit');
  });
});

describe('ChatService + ổ cắm nhật ký và danh tính', () => {
  it('ghi ai ra lệnh, chính sách quyết gì, agent làm gì', async () => {
    const audit = memoryAuditLog();
    const toolAdapter: AgentAdapter = {
      ...fakeAdapter('codex', '', []),
      run(_options, onEvent) {
        onEvent({ type: 'tool_call', id: 'c1', name: 'shell', input: 'ls' });
        onEvent({ type: 'tool_result', id: 'c1', output: 'a.txt', isError: false });
        onEvent({ type: 'text', id: 'm', text: 'Có ' });
        onEvent({ type: 'text', id: 'm', text: 'a.txt' });
        onEvent({ type: 'done', cancelled: false });
        return { cancel: () => undefined, finished: Promise.resolve() };
      },
    };
    const chat = service({ adapters: [toolAdapter], audit });
    await chat.send({ agentId: 'codex', prompt: 'liệt kê file', cwd: 'D:/proj' });

    expect(audit.entries.every((e) => e.actor.id === 'local:tester')).toBe(true);
    expect(
      audit.entries.map((e) => (e.type === 'agent_event' ? `event:${e.event.type}` : e.type)),
    ).toEqual(['request', 'policy', 'event:tool_call', 'event:tool_result', 'reply', 'event:done']);
    const reply = audit.entries.find((e) => e.type === 'reply');
    expect(reply?.type === 'reply' && reply.text).toBe('Có a.txt');
  });
});
