import { describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentEvent, RunOptions } from '@nsa/adapter-sdk';
import {
  ChatService,
  applyEvent,
  buildHandoffContext,
  type ChatEvent,
  type Conversation,
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
      images: false,
      mcp: false,
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

describe('ChatService', () => {
  it('giữ phiên theo agent và chuyển ngữ cảnh khi đổi agent', () => {
    const claudeCalls: RunOptions[] = [];
    const codexCalls: RunOptions[] = [];
    const events: ChatEvent[] = [];
    let saved: Conversation[] = [];
    let n = 0;
    const service = new ChatService({
      adapters: [
        fakeAdapter('claude', 'Kế hoạch: A, B', claudeCalls),
        fakeAdapter('codex', 'Đã làm A', codexCalls),
      ],
      store: { load: () => [], save: (c) => (saved = c) },
      onEvent: (e) => events.push(e),
      newId: () => `id${++n}`,
    });

    const first = service.send({ agentId: 'claude', prompt: 'Lập kế hoạch', cwd: 'D:/proj' });
    service.send({ conversationId: first.conversationId, agentId: 'codex', prompt: 'Làm bước A' });
    service.send({ conversationId: first.conversationId, agentId: 'claude', prompt: 'Kiểm lại' });

    // Codex chưa có phiên → nhận ngữ cảnh chuyển giao chứa câu trả lời của Claude.
    expect(codexCalls[0]?.sessionId).toBeUndefined();
    expect(codexCalls[0]?.prompt).toContain('Kế hoạch: A, B');
    expect(codexCalls[0]?.prompt).toContain('Làm bước A');
    // Claude quay lại: tiếp tục phiên cũ và chỉ nhận phần Codex đã làm.
    expect(claudeCalls[1]?.sessionId).toBe('claude-session');
    expect(claudeCalls[1]?.prompt).toContain('Đã làm A');
    expect(claudeCalls[1]?.prompt).not.toContain('Lập kế hoạch');

    const [conversation] = service.listConversations();
    expect(conversation?.turns.map((t) => [t.agentId, t.status, t.handoff ?? false])).toEqual([
      ['claude', 'done', false],
      ['codex', 'done', true],
      ['claude', 'done', true],
    ]);
    expect(conversation?.cwd).toBe('D:/proj');
    expect(saved).toHaveLength(1);
    expect(events.filter((e) => e.event.type === 'done')).toHaveLength(3);
  });

  it('báo lỗi khi thiếu thư mục hoặc agent không tồn tại', () => {
    const service = new ChatService({ adapters: [fakeAdapter('claude', 'x', [])] });
    expect(() => service.send({ agentId: 'claude', prompt: 'hi' })).toThrow(/thư mục/);
    expect(() => service.send({ agentId: 'gpt', prompt: 'hi', cwd: '.' })).toThrow(/agent/);
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
    const service = new ChatService({
      adapters: [],
      store: { load: () => [stored], save: () => undefined },
    });
    expect(service.listConversations()[0]?.turns[0]?.status).toBe('cancelled');
  });
});
