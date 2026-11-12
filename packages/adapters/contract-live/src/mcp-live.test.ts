/**
 * Gắn server MCP của NSA (bộ nhớ) vào CLI THẬT: agent phải gọi được tool `mem_search` và
 * đọc được kết quả. Chỉ chạy khi NSA_LIVE_CONTRACT=1 (xem live.test.ts).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentAdapter, AgentEvent } from '@nsa/adapter-sdk';
import { createClaudeAdapter } from '@nsa/adapter-claude';
import { createCodexAdapter } from '@nsa/adapter-codex';
import { createOpenCodeAdapter } from '@nsa/adapter-opencode';
import { McpHttpServer } from '@nsa/memory';

const LIVE = process.env['NSA_LIVE_CONTRACT'] === '1';
const only = (process.env['NSA_LIVE_AGENTS'] ?? '').split(',').filter(Boolean);

const ADAPTERS: AgentAdapter[] = [
  createClaudeAdapter(),
  createCodexAdapter(),
  createOpenCodeAdapter({ model: process.env['NSA_OPENCODE_MODEL'] ?? 'opencode/big-pickle' }),
].filter((a) => only.length === 0 || only.includes(a.id));

const SECRET = 'ZEBRA-4217';

describe.skipIf(!LIVE)('MCP bộ nhớ gắn vào CLI thật', () => {
  let server: McpHttpServer;
  const calls: string[] = [];
  beforeAll(async () => {
    server = await McpHttpServer.start({
      name: 'nsa_mem',
      version: '0.0.0',
      tools: [
        {
          name: 'mem_search',
          description: 'Tìm trong bộ nhớ NSA của người dùng.',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
          readOnly: true,
          call: (args, ctx) => {
            calls.push(`${ctx.agentId}:${String(args['query'])}`);
            return `Mục nhớ: mã kiểm tra của người dùng là ${SECRET}.`;
          },
        },
      ],
    });
  });
  afterAll(() => server.close());

  it.each(ADAPTERS.map((a) => [a.id, a] as const))(
    '%s gọi được mem_search',
    async (id, adapter) => {
      const detect = await adapter.detect();
      if (!detect.ready) {
        console.warn(`[bỏ qua] ${id}: ${detect.note ?? 'chưa sẵn sàng'}`);
        return;
      }
      const registration = server.register({ agentId: id });
      const cwd = mkdtempSync(join(tmpdir(), `nsa-mcp-${id}-`));
      let text = '';
      const tools: string[] = [];
      const errors: string[] = [];
      const run = adapter.run(
        {
          prompt:
            'Gọi tool mem_search (server nsa_mem) với query "mã kiểm tra", rồi trả lời đúng mã kiểm tra tìm được. Chỉ trả lời mã.',
          cwd,
          permission: 'read-only',
          mcpServers: [registration.server],
        },
        (e: AgentEvent) => {
          if (e.type === 'text') text += e.text;
          if (e.type === 'tool_call') tools.push(e.name);
          if (e.type === 'error') errors.push(e.message);
        },
      );
      await run.finished;
      registration.dispose();
      console.log(
        `[${id}] tools=${tools.join(',')} errors=${errors.join(' | ')} text=${text.slice(0, 200)}`,
      );
      expect(calls.some((c) => c.startsWith(`${id}:`))).toBe(true);
      expect(text).toContain(SECRET);
    },
    240_000,
  );
});
