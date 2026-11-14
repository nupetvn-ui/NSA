import { describe, expect, it } from 'vitest';
import type { AgentAdapter, Capabilities } from '@nsa/adapter-sdk';
import { ChatService, localIdentity, memoryAuditLog, personalPolicy } from './index.js';

const CAPS: Capabilities = {
  streaming: false,
  resume: false,
  tools: true,
  editFiles: false,
  images: false,
  mcp: false,
  subagents: false,
  toolGate: false,
  tier: 'headless',
};

function adapter(id: string): AgentAdapter {
  return {
    id,
    displayName: id,
    detect: () => Promise.resolve({ installed: true, ready: true, version: '1' }),
    capabilities: () => CAPS,
    run(_options, onEvent) {
      onEvent({ type: 'text', id: '1', text: 'xong' });
      onEvent({ type: 'usage', inputTokens: 10, outputTokens: 2 });
      onEvent({ type: 'done', cancelled: false });
      return { cancel: () => undefined, finished: Promise.resolve() };
    },
  };
}

/** Traces nối các dòng nhật ký của một lượt bằng mã lượt (ADR-0018): không dòng nào được thiếu. */
describe('mã lượt trong nhật ký (nền của Traces)', () => {
  it('lượt chat: request, policy và mọi sự kiện cùng mang turnId + conversationId', async () => {
    const audit = memoryAuditLog();
    const chat = new ChatService({
      adapters: [adapter('a')],
      identity: localIdentity('t'),
      policy: personalPolicy(),
      audit,
    });
    const res = await chat.send({ agentId: 'a', prompt: 'chào', cwd: 'D:/x' });
    expect(res.status).toBe('started');
    if (res.status !== 'started') return;
    await new Promise((r) => setTimeout(r, 30));
    expect(audit.entries.map((e) => e.type)).toEqual(
      expect.arrayContaining(['request', 'policy', 'agent_event', 'reply']),
    );
    for (const e of audit.entries) {
      expect(e.turnId, e.type).toBe(res.turnId);
      expect(e.conversationId, e.type).toBe(res.conversationId);
    }
  });

  it('việc nền (runTask): mọi dòng của một lần thử cùng một turnId, không có cuộc trò chuyện', async () => {
    const audit = memoryAuditLog();
    const chat = new ChatService({
      adapters: [adapter('a')],
      identity: localIdentity('t'),
      audit,
    });
    await chat.runTask({ agentId: 'a', prompt: 'tóm tắt', cwd: 'D:/x', purpose: 'chắt lọc' });
    const ids = new Set(audit.entries.map((e) => e.turnId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBeTruthy();
    expect(audit.entries.every((e) => e.conversationId === undefined)).toBe(true);
  });
});
