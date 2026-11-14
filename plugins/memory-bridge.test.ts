import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localIdentity, memoryAuditLog, personalPolicy } from '@nsa/core';
import { MemoryService } from '@nsa/memory';
import { createMemoryBridge } from '@nsa/plugin-host';

const dirs: string[] = [];
const services: MemoryService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const A = 'plugin/a/kho';
const B = 'plugin/b/kho';

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'nsa-bridge-'));
  dirs.push(root);
  const service = await MemoryService.open({
    root,
    identity: localIdentity('tester'),
    policy: personalPolicy(),
    audit: memoryAuditLog(),
  });
  services.push(service);
  const bridge = createMemoryBridge(service);
  await bridge.ensureBranch(A, 'A');
  await bridge.ensureBranch(B, 'B');
  await bridge.setAutoApprove(A, false);
  await bridge.setAutoApprove(B, false);
  return { service, bridge };
}

describe('cầu nối bộ nhớ của plugin: duyệt, xoá, hoàn tác chỉ trong nhánh của chính nó', () => {
  it('đề xuất → chờ duyệt (nhánh tắt tự nhận) → nhận có sửa → xoá → hoàn tác', async () => {
    const { bridge } = await setup();
    const r = await bridge.propose(A, 'a', { title: 'T', body: 'nội dung một', tags: ['x'] });
    expect(r.status).toBe('pending');
    const [p] = await bridge.pending(A);
    expect(p?.tags).toEqual(['x']);
    const { entryId } = await bridge.accept(A, p?.id as string, { body: 'nội dung đã sửa' });
    expect((await bridge.read(A, entryId))?.body).toBe('nội dung đã sửa');
    const { undo } = await bridge.remove(A, [entryId]);
    expect(await bridge.read(A, entryId)).toBeNull();
    expect((await bridge.restore(A, undo)).restored).toBe(1);
    expect((await bridge.read(A, entryId))?.body).toBe('nội dung đã sửa');
  });

  it('plugin này không duyệt / xoá / hoàn tác được mục của plugin khác', async () => {
    const { bridge } = await setup();
    await bridge.propose(B, 'b', { title: 'Của B', body: 'bí mật của B' });
    const [pb] = await bridge.pending(B);
    await expect(bridge.accept(A, pb?.id as string, {})).rejects.toThrow('không thuộc nhánh');
    await expect(bridge.reject(A, pb?.id as string)).rejects.toThrow('không thuộc nhánh');
    const { entryId } = await bridge.accept(B, pb?.id as string, {});
    await expect(bridge.remove(A, [entryId])).rejects.toThrow('không nằm trong nhánh');
    const { undo } = await bridge.remove(B, [entryId]);
    await expect(bridge.restore(A, undo)).rejects.toThrow('Không hoàn tác được');
    expect((await bridge.restore(B, undo)).restored).toBe(1);
  });

  it('sửa mục đã có (targetId) chỉ trong nhánh của mình; mục nhạy cảm không lọt vào tìm kiếm', async () => {
    const { bridge } = await setup();
    await bridge.propose(A, 'a', {
      title: 'Thẻ',
      body: 'số thẻ 4111 1111 1111 1111',
      sensitive: true,
    });
    await bridge.propose(A, 'a', { title: 'Giá', body: 'cà phê 25000' });
    for (const p of await bridge.pending(A)) await bridge.accept(A, p.id, {});
    const hits = await bridge.searchSemantic(A, 'thẻ 4111', 5);
    expect(hits.hits.map((h) => h.title)).not.toContain('Thẻ');
    const [price] = (await bridge.entries(A, 10)).filter((e) => e.title === 'Giá');
    const upd = await bridge.propose(A, 'a', {
      title: 'Giá',
      body: 'cà phê 30000',
      targetId: price?.id as string,
    });
    expect(upd.status).toBe('pending');
    await expect(
      bridge.propose(B, 'b', { title: 'Giá', body: 'đè', targetId: price?.id as string }),
    ).rejects.toThrow('không nằm trong nhánh');
  });
});
