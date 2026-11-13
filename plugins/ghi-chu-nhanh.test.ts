/**
 * Plugin mẫu "Ghi chú nhanh" chạy qua ĐÚNG đường ống thật: gói có chữ ký → plugin host (tiến
 * trình riêng, node --permission) → cổng MCP (HTTP, chính sách, nhật ký) → NSA Mem thật.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localIdentity, memoryAuditLog, personalPolicy } from '@nsa/core';
import { McpGateway } from '@nsa/mcp-gateway';
import { MemoryService } from '@nsa/memory';
import {
  PluginHost,
  createMemoryBridge,
  generateSigningKey,
  packDirectory,
} from '@nsa/plugin-host';

const SOURCE = join(import.meta.dirname, 'ghi-chu-nhanh');
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nsa-sample-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('plugin mẫu Ghi chú nhanh', () => {
  it('cài từ gói ký → tool qua cổng MCP → màn hình → việc nền → nhánh nhớ → tắt → gỡ', async () => {
    const identity = localIdentity('tester');
    const audit = memoryAuditLog();
    const policy = personalPolicy();
    const memory = await MemoryService.open({ root: tempDir(), identity, policy });
    cleanups.push(() => memory.close());

    const key = generateSigningKey();
    const pkgFile = join(tempDir(), 'ghi-chu-nhanh.nsapkg');
    writeFileSync(pkgFile, packDirectory(SOURCE, { key, publisher: 'NSA' }));

    const host = await PluginHost.open({
      dir: join(tempDir(), 'plugins'),
      nsaVersion: '0.1.0',
      identity,
      policy,
      audit,
      trustedPublishers: [{ keyId: key.keyId, name: 'NSA', publicKey: key.publicKey }],
      memory: createMemoryBridge(memory),
      heartbeatMs: 0,
    });
    cleanups.push(() => host.close());

    const asked: string[] = [];
    const gateway = await McpGateway.start({
      version: '0',
      identity,
      policy,
      audit,
      askUser: (_ctx, description) => {
        asked.push(description);
        return Promise.resolve(true);
      },
    });
    cleanups.push(() => gateway.close());
    gateway.addSource(() => host.tools());
    const call = async (tool: string, args: Record<string, unknown> = {}) => {
      const reg = gateway.register({ agentId: 'claude', conversationId: 'c', turnId: 't' });
      try {
        const res = await fetch(reg.server.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${reg.server.token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: tool, arguments: args },
          }),
        });
        const json = (await res.json()) as {
          result: { content: { text: string }[]; isError?: boolean };
        };
        return { text: json.result.content[0]?.text ?? '', isError: json.result.isError === true };
      } finally {
        reg.dispose();
      }
    };

    // Cài từ gói có chữ ký tin cậy, cấp quyền nhớ.
    const prepared = host.prepareFromFile(pkgFile);
    expect(prepared).toMatchObject({ signature: 'trusted', publisher: 'NSA' });
    expect(prepared.icon.kind).toBe('image');
    const installed = await host.install(prepared.prepareId, {
      network: [],
      folders: {},
      memory: true,
      notifications: false,
    });
    expect(installed.status).toBe('installed');
    expect(host.get('ghi-chu-nhanh')).toMatchObject({ status: 'running', enabled: true });
    expect(gateway.listTools().map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'ghi_chu_nhanh__add_note',
        'ghi_chu_nhanh__list_notes',
        'ghi_chu_nhanh__pin_note',
        'ghi_chu_nhanh__clear_notes',
      ]),
    );

    // Tool MCP.
    expect((await call('ghi_chu_nhanh__add_note', { text: 'Mua sữa' })).text).toBe(
      'Đã thêm ghi chú #1.',
    );
    await call('ghi_chu_nhanh__add_note', { text: 'Gọi cho Bình' });
    expect((await call('ghi_chu_nhanh__list_notes')).text).toBe('#2: Gọi cho Bình\n#1: Mua sữa');

    // Màn hình + hàm màn hình.
    expect(readFileSync(host.assetPath('ghi-chu-nhanh', 'ui/index.html') ?? '', 'utf8')).toContain(
      'Ghi chú nhanh',
    );
    expect(existsSync(host.assetPath('ghi-chu-nhanh', 'ui/app.js') ?? '')).toBe(true);
    expect(await host.callUi('ghi-chu-nhanh', 'list', null)).toHaveLength(2);

    // Việc nền.
    await host.runJob('ghi-chu-nhanh', 'stats');
    expect(await host.callUi('ghi-chu-nhanh', 'stats', null)).toMatchObject({ count: 2 });

    // Nhánh nhớ: ghim vào hộp duyệt của NSA Mem, nguồn gốc là plugin; nhánh ẩn.
    const pinned = await call('ghi_chu_nhanh__pin_note', { id: 1 });
    expect(pinned.isError).toBe(false);
    const branch = memory.listBranches().find((b) => b.path === 'plugin/ghi-chu-nhanh/ghi-chu');
    expect(branch).toMatchObject({ hidden: true });
    const proposals = memory.listProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.draft).toMatchObject({
      branch: 'plugin/ghi-chu-nhanh/ghi-chu',
      body: 'Mua sữa',
      source: { kind: 'plugin', ref: 'plugin:ghi-chu-nhanh' },
    });

    // Thao tác nhạy cảm luôn hỏi.
    expect((await call('ghi_chu_nhanh__clear_notes')).text).toBe('Đã xoá 2 ghi chú.');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/nhạy cảm/);

    // Thu hồi quyền nhớ → ghim bị từ chối; plugin vẫn chạy phần còn lại.
    await host.updateGrants('ghi-chu-nhanh', {
      network: [],
      folders: {},
      memory: false,
      notifications: false,
    });
    await call('ghi_chu_nhanh__add_note', { text: 'x' });
    expect((await call('ghi_chu_nhanh__pin_note', { id: 1 })).isError).toBe(true);

    // Tắt → tool biến mất; gỡ → sạch.
    await host.setEnabled('ghi-chu-nhanh', false);
    expect(gateway.listTools()).toEqual([]);
    await host.uninstall('ghi-chu-nhanh');
    expect(host.list()).toEqual([]);
  }, 60_000);
});
