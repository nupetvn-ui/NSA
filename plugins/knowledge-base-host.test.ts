/**
 * Plugin Knowledge Base ĐÃ ĐÓNG GÓI (main.js) chạy trong PluginHost thật: tiến trình riêng,
 * `node --permission`, NSA Mem thật (hộp duyệt, tìm lai FTS5 + vector), cổng MCP thật cho agent.
 * Model nhìn ảnh và embedding là GIẢ (chưa có key thật) — xem ADR-0015 mục "Chưa chạy thật".
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { localIdentity, memoryAuditLog, personalPolicy } from '@nsa/core';
import { McpGateway } from '@nsa/mcp-gateway';
import { EmbeddingVectorIndex, MemoryService } from '@nsa/memory';
import { PluginHost, createMemoryBridge } from '@nsa/plugin-host';
import { makePdf } from './knowledge-base-fixtures';

const SOURCE = join(import.meta.dirname, 'knowledge-base');
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

beforeAll(() => {
  // Bảo đảm main.js khớp mã nguồn hiện tại (file sinh ra).
  execFileSync(process.execPath, [join(SOURCE, 'build.mjs')], { stdio: 'ignore' });
});

/** Embedding giả: túi từ băm vào 64 chiều — đủ để kiểm đường ống, không phải chất lượng nghĩa. */
function fakeEmbed(texts: string[]): number[][] {
  return texts.map((t) => {
    const v = new Array<number>(64).fill(0);
    for (const w of t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\W+/)) {
      if (!w) continue;
      let h = 0;
      for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 64;
      v[h] = (v[h] ?? 0) + 1;
    }
    return v;
  });
}

async function setup(options: { embeddings?: boolean } = {}) {
  const src = tempDir('kb-src-');
  cpSync(SOURCE, src, {
    recursive: true,
    filter: (p) => !p.includes('node_modules') && !p.endsWith('.test.ts'),
  });
  const identity = localIdentity('tester');
  const policy = personalPolicy();
  const audit = memoryAuditLog();
  const memRoot = tempDir('kb-mem-');
  const embedCalls: number[] = [];
  const holder: { mem?: MemoryService } = {};
  const vector = new EmbeddingVectorIndex({
    file: join(memRoot, '.nsa', 'vectors.json'),
    embed: async (texts) => {
      embedCalls.push(texts.length);
      return fakeEmbed(texts);
    },
    ready: () => options.embeddings === true,
    entries: () => holder.mem?.listEntries() ?? [],
  });
  const mem = await MemoryService.open({ root: memRoot, identity, policy, audit, vector });
  holder.mem = mem;
  cleanups.push(() => mem.close());
  const visionCalls: string[] = [];
  const hostDir = tempDir('kb-host-');
  const kho = tempDir('kb-kho-');
  const host = await PluginHost.open({
    dir: hostDir,
    nsaVersion: '0.1.0',
    identity,
    policy,
    audit,
    memory: createMemoryBridge(mem),
    model: async () => 'không dùng',
    vision: async (_id, prompt) => {
      visionCalls.push(prompt);
      return 'MÔ TẢ: Bảng giá đồ uống tháng 11.\nCHỮ TRONG ẢNH: Trà đào cam sả 45000 đồng';
    },
    embed: async (_id, texts) => fakeEmbed(texts),
    modelStatus: async (task) => ({
      available: task !== 'embedding' || options.embeddings === true,
      label: 'Model giả',
      inputUsdPer1M: 0,
      outputUsdPer1M: 0,
      budget: { limitUsd: null, spentUsd: 0, level: 'ok' },
    }),
    heartbeatMs: 0,
    toolTimeoutMs: 30_000,
    startTimeoutMs: 20_000,
  });
  cleanups.push(() => host.close());
  host.saveSettings({ developerMode: true });
  const prepared = host.prepareFromDirectory(src);
  expect(prepared.blocked).toBeUndefined();
  expect(prepared.manifest.permissions.modelTasks).toEqual(['vision', 'embedding']);
  const res = await host.install(
    prepared.prepareId,
    {
      network: ['*'],
      memory: true,
      model: true,
      notifications: true,
      folders: { kho },
      cli: ['ffmpeg', 'ffprobe', 'whisper'],
    },
    true,
  );
  expect(res.status, JSON.stringify(res)).toBe('installed');

  const gateway = await McpGateway.start({
    version: '0',
    identity,
    policy,
    audit,
    askUser: async () => false,
  });
  cleanups.push(() => gateway.close());
  gateway.addSource(() => host.tools());
  const tool = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const { server, dispose } = gateway.register({
      agentId: 'claude',
      conversationId: 'c',
      turnId: 't',
    });
    try {
      const r = await fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: `knowledge_base__${name}`, arguments: args },
        }),
      });
      const json = (await r.json()) as {
        result?: { content: { text: string }[]; isError?: boolean };
      };
      return json.result?.content.map((c) => c.text).join('\n') ?? JSON.stringify(json);
    } finally {
      dispose();
    }
  };
  const ui = <T = unknown>(method: string, params?: unknown) =>
    host.callUi('knowledge-base', method, params) as Promise<T>;
  /** Tải lên như màn hình làm: từng đoạn base64. */
  const upload = async (name: string, bytes: Buffer, extra: Record<string, unknown> = {}) => {
    const { uploadId } = await ui<{ uploadId: string }>('uploadStart', {
      name,
      size: bytes.length,
    });
    for (let i = 0; i < bytes.length; i += 4096) {
      await ui('uploadChunk', { uploadId, b64: bytes.subarray(i, i + 4096).toString('base64') });
    }
    return ui<{ id: string; status: string }>('uploadFinish', { uploadId, name, ...extra });
  };
  const waitIdle = async () => {
    for (let i = 0; i < 150; i++) {
      const ov = await ui<{ sources: { status: string }[] }>('overview');
      if (ov.sources.every((s) => !['estimating', 'queued', 'running'].includes(s.status)))
        return ov;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('hàng đợi không xong');
  };
  return { host, mem, tool, ui, upload, waitIdle, visionCalls, embedCalls, kho, hostDir, audit };
}

describe('Knowledge Base đã đóng gói, chạy trong plugin host thật', () => {
  it('nạp PDF → hộp duyệt → nhận → agent hỏi qua cổng MCP và nhận câu trả lời kèm nguồn', async () => {
    const s = await setup();
    const up = await s.upload(
      'bang-gia.pdf',
      makePdf(['Ca phe sua 25000 dong', 'Giao hang mien phi tren 500000 dong']),
      {
        collection: 'bang gia',
      },
    );
    expect(up.status).toBe('created');
    const ov = await s.waitIdle();
    expect(ov.sources[0]).toMatchObject({ status: 'ingested', pending: 2 });

    // Chưa duyệt → agent chưa thấy gì (hộp duyệt chặn).
    expect(await s.tool('kb_search', { query: 'giao hang mien phi' })).toContain('Không tìm thấy');

    const pending = await s.ui<{ id: string; loc: string }[]>('pending');
    expect(pending).toHaveLength(2);
    const ctx = await s.ui<{ kind: string; text: string }>('context', {
      sourceId: (ov.sources[0] as unknown as { id: string }).id,
      loc: 'trang 2',
    });
    expect(ctx.text).toContain('Giao hang mien phi');
    await s.ui('acceptMany', { ids: pending.map((p) => p.id) });

    const answer = await s.tool('kb_search', { query: 'giao hang mien phi tren bao nhieu' });
    expect(answer).toContain('500000');
    expect(answer).toContain('NGUỒN: bang-gia.pdf · trang 2');
    expect(answer).toContain('tìm theo từ khoá');
    const id = /\[(m-[a-z0-9-]+)\]/.exec(answer)?.[1] as string;
    const opened = await s.tool('kb_open', { id });
    expect(opened).toContain('Đoạn gốc xung quanh');
    expect(await s.tool('kb_sources')).toContain('bang-gia.pdf');

    // Chính sách + nhật ký: tool của plugin đi qua cổng.
    expect(s.audit.entries.some((e) => e.type === 'mcp_tool')).toBe(true);
  }, 90_000);

  it('plugin không với tới file ngoài thư mục của nó (node --permission) và không có key', async () => {
    const s = await setup();
    // Quyền model: vision/embedding chỉ khi manifest khai; tool không có đường lấy key.
    const info = s.host.list().find((p) => p.id === 'knowledge-base');
    expect(info?.grants.cli).toEqual(['ffmpeg', 'ffprobe', 'whisper']);
    expect(info?.manifest.permissions.cli.every((c) => c.confinePaths)).toBe(true);
  }, 30_000);

  it('ảnh: model nhìn ảnh mô tả + lời dặn đi kèm; chữ trong ảnh tìm lại được sau khi duyệt', async () => {
    const s = await setup();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    await s.upload('gia.png', png, { note: 'đây là bảng giá tháng 11' });
    await s.waitIdle();
    expect(s.visionCalls[0]).toContain('đây là bảng giá tháng 11');
    const pending = await s.ui<{ id: string }[]>('pending');
    await s.ui('accept', { id: pending[0]?.id });
    const out = await s.tool('kb_search', { query: 'trà đào cam sả giá bao nhiêu' });
    expect(out).toContain('45000');
    expect(out).toContain('NGUỒN: gia.png');
  }, 60_000);

  it('tìm theo nghĩa: có model embedding thì tìm lai (vector), vẫn lùi về từ khoá khi chưa có', async () => {
    const s = await setup({ embeddings: true });
    await s.upload(
      'ship.md',
      Buffer.from('# Vận chuyển\nMiễn phí giao hàng cho đơn từ 500 nghìn.\n'),
    );
    await s.waitIdle();
    await s.ui('acceptMany', { ids: (await s.ui<{ id: string }[]>('pending')).map((p) => p.id) });
    // Mặc định TẮT dù có model embedding (chưa đo chất lượng thật): vẫn tìm từ khoá, không gọi embedding.
    expect(await s.tool('kb_search', { query: 'miễn phí giao hàng' })).toContain(
      'tìm theo từ khoá',
    );
    expect(s.embedCalls).toHaveLength(0);
    await s.ui('settings', { semantic: true });
    const out = await s.tool('kb_search', { query: 'miễn phí giao hàng' });
    expect(out).toContain('tìm theo nghĩa');
    expect(out).toContain('ship.md');
    expect(s.embedCalls.length).toBeGreaterThan(0); // vector được tính lười, lúc tìm

    const none = await setup({ embeddings: false });
    await none.upload('ship.md', Buffer.from('# Vận chuyển\nMiễn phí giao hàng.\n'));
    await none.waitIdle();
    await none.ui('acceptMany', {
      ids: (await none.ui<{ id: string }[]>('pending')).map((p) => p.id),
    });
    expect(await none.tool('kb_search', { query: 'miễn phí giao hàng' })).toContain(
      'tìm theo từ khoá',
    );
    expect(none.embedCalls).toHaveLength(0);
  }, 90_000);

  it('xoá nguồn gỡ các mục nhớ của nó khỏi tìm kiếm; hoàn tác trả lại', async () => {
    const s = await setup();
    await s.upload(
      'chinh-sach.txt',
      Buffer.from('Đổi trả trong vòng 7 ngày kể từ khi nhận hàng.\n'),
    );
    const ov = await s.waitIdle();
    await s.ui('acceptMany', { ids: (await s.ui<{ id: string }[]>('pending')).map((p) => p.id) });
    expect(await s.tool('kb_search', { query: 'đổi trả 7 ngày' })).toContain('7 ngày');
    const id = (ov.sources[0] as unknown as { id: string }).id;
    await s.ui('remove', { id });
    expect(await s.tool('kb_search', { query: 'đổi trả 7 ngày' })).toContain('Không tìm thấy');
    await s.ui('undoRemove');
    expect(await s.tool('kb_search', { query: 'đổi trả 7 ngày' })).toContain('7 ngày');
  }, 90_000);

  it('thẻ giả trong tài liệu: không vào kho, hiện cảnh báo, "nhận cả lô" bỏ qua mục nhạy cảm', async () => {
    const s = await setup();
    s.mem.saveBranch('plugin', { title: 'x' }).catch(() => undefined);
    const text = `${Array.from({ length: 60 }, (_, i) => `Khách số ${i} thích trà đào loại ${i * 7}.`).join(' ')}\n\nThẻ khách: 4111 1111 1111 1111 hết hạn 12/29\n`;
    await s.upload('khach.txt', Buffer.from(text));
    const ov = await s.waitIdle();
    expect(ov.sources[0]).toMatchObject({ pending: 3, accepted: 0 });
    expect(JSON.stringify(ov.sources[0])).toContain('nhạy cảm');
    const pending = await s.ui<{ id: string; sensitive: boolean }[]>('pending');
    expect(pending.filter((p) => p.sensitive)).toHaveLength(1);
    const r = await s.ui<{ accepted: number; skipped: number }>('acceptMany', {
      ids: pending.map((p) => p.id),
    });
    expect(r).toMatchObject({ accepted: 2, skipped: 1 }); // mục thường nhận được, mục có thẻ thì bỏ qua
    expect(await s.tool('kb_search', { query: 'thẻ khách 4111' })).not.toContain('4111');
  }, 60_000);

  it('thư mục đã cấp quyền: quét thư mục và nạp lại không nhân đôi', async () => {
    const s = await setup();
    writeFileSync(join(s.kho, 'a.md'), '# A\nNội dung A.\n');
    mkdirSync(join(s.kho, 'con'));
    writeFileSync(join(s.kho, 'con', 'b.txt'), 'Nội dung B.\n');
    const first = await s.ui<{ status: string }[]>('addFolder', { folder: 'kho' });
    expect(first.map((r) => r.status).sort()).toEqual(['created', 'created']);
    await s.waitIdle();
    const second = await s.ui<{ status: string }[]>('addFolder', { folder: 'kho' });
    expect(second.map((r) => r.status)).toEqual(['unchanged', 'unchanged']);
    expect(existsSync(s.kho)).toBe(true);
  }, 60_000);
});
