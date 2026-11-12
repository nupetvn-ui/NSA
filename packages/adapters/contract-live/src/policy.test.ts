/**
 * "Chính sách chặn thì adapter không được chạy" — kiểm với TỪNG adapter thật (gọi CLI giả ghi
 * lại mọi lần bị gọi). Chạy trong mọi lần `pnpm test`.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { prepareFakeCli, type AgentAdapter, type CliAdapterOptions } from '@nsa/adapter-sdk';
import { createAntigravityAdapter } from '@nsa/adapter-antigravity';
import { createClaudeAdapter } from '@nsa/adapter-claude';
import { createCodexAdapter } from '@nsa/adapter-codex';
import { createGeminiAdapter } from '@nsa/adapter-gemini';
import { createOpenCodeAdapter } from '@nsa/adapter-opencode';
import { createCustomCliAdapter } from '@nsa/adapter-pty';
import { ChatService, localIdentity, memoryAuditLog, type Policy } from '@nsa/core';

const FACTORIES: [string, (o: CliAdapterOptions) => AgentAdapter][] = [
  ['claude', createClaudeAdapter],
  ['codex', createCodexAdapter],
  ['opencode', createOpenCodeAdapter],
  ['gemini', createGeminiAdapter],
  ['antigravity', createAntigravityAdapter],
  [
    'pty',
    (o) =>
      createCustomCliAdapter({
        id: 'pty',
        displayName: 'PTY',
        command: o.command ?? '',
        args: o.prefixArgs ?? [],
      }),
  ],
];

const denyAll: Policy = { check: () => ({ decision: 'deny', reason: 'cấm thử nghiệm' }) };

describe.each(FACTORIES)('chính sách chặn → %s không được chạy', (id, factory) => {
  it('kể cả khi đã xác nhận, kể cả khi quyền sửa file, kể cả lượt thứ hai', async () => {
    const fake = prepareFakeCli(`policy-${id}`, ['{"type":"noop"}']);
    Object.assign(process.env, fake.env);
    const adapter = factory({ command: fake.command, prefixArgs: fake.prefixArgs });
    const audit = memoryAuditLog();
    const chat = new ChatService({
      adapters: [adapter],
      identity: localIdentity('tester'),
      policy: denyAll,
      audit,
    });
    for (const permission of ['read-only', 'edit'] as const) {
      for (const confirmed of [false, true]) {
        const result = await chat.send({
          agentId: id,
          prompt: 'xoá hết',
          cwd: process.cwd(),
          permission,
          confirmed,
        });
        expect(result).toEqual({ status: 'denied', reason: 'cấm thử nghiệm' });
      }
    }
    // CLI giả ghi một dòng mỗi lần bị gọi — phải trống.
    expect(readFileSync(fake.log, 'utf8')).toBe('');
    expect(chat.listConversations()).toHaveLength(0);
    expect(
      audit.entries
        .filter((e) => e.type === 'policy')
        .every((e) => e.type === 'policy' && e.decision === 'deny'),
    ).toBe(true);
  });
});
