/**
 * Cấp key cho CLI THẬT (ADR-0009), trỏ vào máy chủ giả trên máy — không tốn token, không cần key.
 * Chỉ chạy khi NSA_LIVE_CONTRACT=1 (cần CLI đã cài):
 *
 *   NSA_LIVE_CONTRACT=1 pnpm test:live
 *
 * Kiểm: CLI gửi đúng key NSA cấp (không phải token đăng nhập gói thuê bao của người dùng),
 * và không ghi key vào thư mục cấu hình riêng mà NSA đưa cho nó.
 */
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@nsa/adapter-sdk';
import { startFakeApiServer, type FakeServer } from '@nsa/adapter-api';
import { createClaudeAdapter } from '@nsa/adapter-claude';
import { createCodexAdapter } from '@nsa/adapter-codex';
import { createOpenCodeAdapter } from '@nsa/adapter-opencode';
import {
  ProviderHub,
  bundledCatalog,
  memorySecretStore,
  memorySettingsStore,
  memoryUsageLedger,
  type CliId,
} from '@nsa/providers';

const LIVE = process.env['NSA_LIVE_CONTRACT'] === '1';
const KEY = 'sk-nsa-PAIRING-test-0123456789';

function walk(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  } catch {
    return [];
  }
}

let server: FakeServer | undefined;
afterAll(async () => server?.close());

describe.skipIf(!LIVE)('cấp key cho CLI thật (máy chủ giả)', () => {
  it.each([['opencode'], ['claude']] as [CliId][])(
    '%s gửi đúng key NSA cấp',
    async (cli) => {
      server ??= await startFakeApiServer();
      const catalog = structuredClone(bundledCatalog());
      const deepseek = catalog.providers.find((p) => p.id === 'deepseek');
      if (!deepseek) throw new Error('thiếu deepseek');
      deepseek.group = 'local'; // cho phép địa chỉ http của máy chủ giả
      deepseek.endpoints = { openai: server.openaiUrl, anthropic: server.anthropicUrl };
      const dataDir = mkdtempSync(join(tmpdir(), 'nsa-pairing-'));
      const hub = new ProviderHub({
        cliAdapters: {
          claude: (o) => createClaudeAdapter(o),
          codex: (o) => createCodexAdapter(o),
          opencode: (o) => createOpenCodeAdapter(o),
        },
        catalog,
        settings: memorySettingsStore(),
        secrets: memorySecretStore(),
        ledger: memoryUsageLedger(),
        dataDir,
      });
      hub.setKey('deepseek', KEY);
      hub.update({ kind: 'pairing', cli, model: 'deepseek/deepseek-flash', on: true });
      const adapter = hub.pairedAdapter(cli, 'deepseek/deepseek-flash');
      if (!adapter) throw new Error('không tạo được adapter');
      const before = server.requests.length;
      const events: AgentEvent[] = [];
      const run = adapter.run(
        { prompt: 'Reply with NSA-OK', cwd: dataDir, permission: 'read-only' },
        (e) => events.push(e),
      );
      await run.finished;
      const requests = server.requests.slice(before);
      expect(requests.length, JSON.stringify(events)).toBeGreaterThan(0);
      for (const r of requests) {
        const sent =
          r.headers['x-api-key'] ??
          String(r.headers['authorization'] ?? '').replace(/^Bearer /, '');
        expect(sent, 'CLI gửi credential khác key NSA cấp').toBe(KEY);
      }
      const text = events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');
      expect(text, JSON.stringify(requests.map((r) => [r.path, r.body['model']]))).toContain(
        'NSA-OK',
      );
      for (const file of walk(join(dataDir, 'cli-homes'))) {
        expect(readFileSync(file, 'utf8'), file).not.toContain(KEY);
      }
    },
    180_000,
  );
});
