import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localIdentity, memoryAuditLog, personalPolicy, type MemoryDraft } from '@nsa/core';
import { EmbeddingVectorIndex } from './embedding-index.js';
import { MemoryService } from './service.js';

const dirs: string[] = [];
const services: MemoryService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Túi từ băm vào 32 chiều — thay cho model embedding thật. */
const embed = (texts: string[]): Promise<number[][]> =>
  Promise.resolve(
    texts.map((t) => {
      const v = new Array<number>(32).fill(0);
      for (const w of t.toLowerCase().split(/\W+/)) {
        if (!w) continue;
        let h = 7;
        for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 32;
        v[h] = (v[h] ?? 0) + 1;
      }
      return v;
    }),
  );

async function open(options: { ready?: () => boolean; embedFn?: typeof embed } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nsa-vec-'));
  dirs.push(root);
  const calls: number[] = [];
  const holder: { service?: MemoryService } = {};
  const index = new EmbeddingVectorIndex({
    file: join(root, '.nsa', 'vectors.json'),
    embed: (t) => {
      calls.push(t.length);
      return (options.embedFn ?? embed)(t);
    },
    ready: options.ready ?? (() => true),
    entries: () => holder.service?.listEntries() ?? [],
  });
  const service = await MemoryService.open({
    root,
    identity: localIdentity('tester'),
    policy: personalPolicy(),
    audit: memoryAuditLog(),
    vector: index,
  });
  holder.service = service;
  services.push(service);
  return { service, index, calls, root };
}

const draft = (title: string, body: string, extra: Partial<MemoryDraft> = {}) => ({
  branch: 'chung',
  title,
  body,
  kind: 'fact' as const,
  confidence: 0.95,
  ...extra,
});

describe('tìm theo nghĩa (EmbeddingVectorIndex)', () => {
  it('ghi mục nhớ không gọi mạng; tìm mới tính vector (lười) và trả mode "semantic"', async () => {
    const { service, calls } = await open();
    await service.teach(draft('Giao hàng', 'Miễn phí giao hàng cho đơn trên 500k'));
    await service.teach(draft('Đổi trả', 'Đổi trả trong vòng bảy ngày'));
    expect(calls).toHaveLength(0);
    const r = await service.searchHybrid('miễn phí giao hàng');
    expect(r.mode).toBe('semantic');
    expect(r.hits[0]?.entry.title).toBe('Giao hàng');
    // Lần tìm sau: chỉ tính vector cho câu hỏi, không tính lại mục nhớ.
    const before = calls.length;
    await service.searchHybrid('đổi trả');
    expect(calls.slice(before)).toEqual([1]);
  });

  it('mục nhạy cảm không bao giờ được gửi đi tính vector', async () => {
    const { service, calls } = await open();
    await service.teach(draft('Thẻ', 'Số thẻ 4111 1111 1111 1111', { sensitive: true }));
    await service.teach(draft('Bình thường', 'Cà phê sữa 25000'));
    await service.searchHybrid('cà phê');
    expect(calls.reduce((a, b) => a + b, 0)).toBe(2); // 1 mục thường + 1 câu hỏi
  });

  it('chưa có model embedding hoặc embedding lỗi → lùi về FTS5, vẫn trả kết quả', async () => {
    const none = await open({ ready: () => false });
    await none.service.teach(draft('Giao hàng', 'Miễn phí giao hàng'));
    const a = await none.service.searchHybrid('giao hàng');
    expect(a.mode).toBe('keyword');
    expect(a.hits).toHaveLength(1);
    expect(none.calls).toHaveLength(0);

    const broken = await open({ embedFn: () => Promise.reject(new Error('hết hạn mức')) });
    await broken.service.teach(draft('Giao hàng', 'Miễn phí giao hàng'));
    const b = await broken.service.searchHybrid('giao hàng');
    expect(b.mode).toBe('keyword');
    expect(b.note).toContain('hết hạn mức');
    expect(b.hits).toHaveLength(1);
  });

  it('xoá mục nhớ thì vector của nó biến mất; mất file vector thì dựng lại từ Markdown', async () => {
    const { service, index, root } = await open();
    const e = await service.teach(draft('A', 'alpha beta'));
    await service.searchHybrid('alpha');
    expect(index.count).toBe(1);
    await service.delete(e.id);
    expect(index.count).toBe(0);
    const again = await service.teach(draft('B', 'gamma delta'));
    await service.searchHybrid('gamma');
    expect(index.count).toBe(1);
    rmSync(join(root, '.nsa', 'vectors.json'));
    const fresh = new EmbeddingVectorIndex({
      file: join(root, '.nsa', 'vectors.json'),
      embed,
      ready: () => true,
      entries: () => service.listEntries(),
    });
    expect(fresh.count).toBe(0);
    expect((await fresh.query('gamma', 3))[0]?.id).toBe(again.id); // dựng lại từ các mục nhớ
  });
});
