/**
 * Test hợp đồng với CLI THẬT. Chỉ chạy khi đặt NSA_LIVE_CONTRACT=1 (tốn token, cần mạng):
 *
 *   NSA_LIVE_CONTRACT=1 pnpm test:live
 *
 * Chọn CLI bằng NSA_LIVE_AGENTS=claude,opencode (mặc định: tất cả).
 * Đổi lệnh gọi bằng NSA_<ID>_CMD (ví dụ NSA_OPENCODE_CMD=/path/to/opencode).
 * OpenCode dùng model miễn phí NSA_OPENCODE_MODEL (mặc định opencode/big-pickle) nên chạy
 * được cả trên CI không có khoá nào.
 *
 * Bước nào CLI chưa cài / chưa đăng nhập thì bị BỎ QUA kèm lý do (vitest ghi "skipped"),
 * không bao giờ được tính là đã qua.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runContract, type AgentAdapter, type ContractResult } from '@nsa/adapter-sdk';
import { createAntigravityAdapter } from '@nsa/adapter-antigravity';
import { createClaudeAdapter } from '@nsa/adapter-claude';
import { createCodexAdapter } from '@nsa/adapter-codex';
import { createGeminiAdapter } from '@nsa/adapter-gemini';
import { createOpenCodeAdapter } from '@nsa/adapter-opencode';

const LIVE = process.env['NSA_LIVE_CONTRACT'] === '1';
const only = (process.env['NSA_LIVE_AGENTS'] ?? '').split(',').filter(Boolean);
const cmd = (id: string) => process.env[`NSA_${id.toUpperCase()}_CMD`];
const opt = (id: string) => (cmd(id) ? { command: cmd(id) as string } : {});

const ADAPTERS: AgentAdapter[] = [
  createClaudeAdapter(opt('claude')),
  createCodexAdapter(opt('codex')),
  createOpenCodeAdapter({
    ...opt('opencode'),
    model: process.env['NSA_OPENCODE_MODEL'] ?? 'opencode/big-pickle',
  }),
  createGeminiAdapter(opt('gemini')),
  createAntigravityAdapter(opt('antigravity')),
].filter((a) => only.length === 0 || only.includes(a.id));

const STEPS = ['send', 'resume', 'cancel', 'gate'] as const;

describe.runIf(LIVE)('hợp đồng adapter với CLI thật', () => {
  for (const adapter of ADAPTERS) {
    describe(adapter.displayName, () => {
      let results: ContractResult[] = [];
      beforeAll(async () => {
        const cwd = mkdtempSync(join(tmpdir(), `nsa-live-${adapter.id}-`));
        writeFileSync(join(cwd, 'README.md'), '# Thư mục thử của NSA\n');
        results = await runContract(adapter, { mode: 'live', cwd });
        // In ra để workflow hằng đêm gom thành bảng tóm tắt.
        console.log(`[contract] ${adapter.id} ${JSON.stringify(results)}`);
      }, 15 * 60_000);

      for (const step of STEPS) {
        it(step, (ctx) => {
          const result = results.find((r) => r.step === step);
          if (!result || result.status === 'skipped') {
            ctx.skip(result?.detail ?? 'không chạy');
            return;
          }
          expect(result.status, result.detail).toBe('passed');
        });
      }
    });
  }
});

describe.skipIf(LIVE)('hợp đồng adapter với CLI thật', () => {
  it.skip('đặt NSA_LIVE_CONTRACT=1 để chạy', () => undefined);
});
