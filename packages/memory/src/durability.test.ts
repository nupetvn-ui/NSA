/**
 * Độ bền của NSA Mem khi bị ngắt giữa chừng (mất điện, app chết) và khi chỉ mục lệch với file.
 * Nguyên tắc: file Markdown + lịch sử git là bản gốc; chỉ mục là bản sao dựng lại được.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localIdentity, memoryAuditLog, personalPolicy } from '@nsa/core';
import { MemoryService } from './service.js';

const dirs: string[] = [];
const services: MemoryService[] = [];
afterEach(() => {
  for (const s of services.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function open(root: string) {
  const service = await MemoryService.open({
    root,
    identity: localIdentity('tester'),
    policy: personalPolicy(),
    audit: memoryAuditLog(),
  });
  services.push(service);
  return service;
}
const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), 'nsa-dur-'));
  dirs.push(root);
  return root;
};
const entry = (title: string, body: string) => ({
  branch: 'chung',
  title,
  body,
  kind: 'fact' as const,
  confidence: 0.9,
});
const mdFiles = (root: string) =>
  readdirSync(join(root, 'chung')).filter((f) => f.endsWith('.md') && f !== '_branch.md');

describe('tìm tiếng Việt', () => {
  it('"đ" gập thành "d": gõ không dấu vẫn ra "được", "đổi trả", "đồng"; trích đoạn giữ nguyên dấu', async () => {
    const root = fresh();
    const s = await open(root);
    await s.teach(entry('Chính sách', 'Khách được đổi trả hàng trong 7 ngày. Giá 1.250.000 đồng.'));
    for (const q of ['doi tra', 'dong', 'đổi trả', 'ĐỔI TRẢ', 'chinh sach']) {
      expect(s.search(q), q).toHaveLength(1);
    }
    expect(s.search('doi tra')[0]?.snippet).toContain('[đổi]');
  });

  it('chỉ mục dựng theo cách cũ (không gập đ) tự dựng lại khi mở', async () => {
    const root = fresh();
    const s = await open(root);
    await s.teach(entry('Giá', 'Cà phê được bán 25000 đồng'));
    s.close();
    services.pop();
    // Giả lập chỉ mục phiên bản cũ.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(root, '.nsa', 'index.sqlite'));
    db.exec('PRAGMA user_version = 0');
    db.close();
    const again = await open(root);
    expect(again.search('phe 25000')).toHaveLength(1);
  });
});

describe('ngắt giữa chừng', () => {
  it('đã ghi file mà chưa kịp commit / lập chỉ mục → mở lại: mục có trong kho, trong lịch sử, tìm được', async () => {
    const root = fresh();
    const s = await open(root);
    const kept = await s.teach(entry('Giữ', 'mục bình thường alpha'));
    s.close();
    services.pop();
    // Lần ghi bị ngắt: file mới nằm trên đĩa nhưng không có commit và không có trong chỉ mục.
    const orphanFile = join(root, 'chung', 'm-20260101-deadbeef.md');
    writeFileSync(
      orphanFile,
      readFileSync(join(root, 'chung', `${kept.id}.md`), 'utf8')
        .replace(kept.id, 'm-20260101-deadbeef')
        .replace('mục bình thường alpha', 'mục dở dang bravo'),
    );
    writeFileSync(join(root, 'chung', 'm-xx.md.tmp'), 'rác');
    const again = await open(root);
    expect(again.search('bravo')).toHaveLength(1);
    expect(again.listEntries()).toHaveLength(2);
    expect(existsSync(join(root, 'chung', 'm-xx.md.tmp'))).toBe(false);
    const hist = await again.history({ limit: 10 });
    expect(hist[0]?.summary).toContain('Khôi phục');
    // Đã vào lịch sử → xoá rồi hoàn tác được như mục bình thường.
    await again.delete('m-20260101-deadbeef');
    const del = (await again.history({ limit: 5 })).find((h) => h.op === 'delete');
    await again.undo(del?.commit as string);
    expect(again.search('bravo')).toHaveLength(1);
  });

  it('file đã sửa tại chỗ nhưng chỉ mục còn bản cũ (cùng số mục) → mở lại nhận bản mới', async () => {
    const root = fresh();
    const s = await open(root);
    const e = await s.teach(entry('Giá', 'cà phê 25000'));
    s.close();
    services.pop();
    const file = join(root, 'chung', `${e.id}.md`);
    const text = readFileSync(file, 'utf8')
      .replace('cà phê 25000', 'cà phê 30000')
      .replace(/updated: ".*"/, 'updated: "2099-01-01T00:00:00.000Z"');
    writeFileSync(file, text);
    const again = await open(root);
    expect(again.search('30000')).toHaveLength(1);
    expect(again.search('25000')).toHaveLength(0);
  });

  it('mất / hỏng cả chỉ mục SQLite và vector → dựng lại từ Markdown, số mục khớp từng file', async () => {
    const root = fresh();
    const s = await open(root);
    for (let i = 0; i < 12; i++) await s.teach(entry(`Mục ${i}`, `nội dung số ${i} về đơn hàng`));
    s.close();
    services.pop();
    rmSync(join(root, '.nsa', 'index.sqlite'));
    writeFileSync(join(root, '.nsa', 'vectors.json'), '{hỏng');
    const again = await open(root);
    expect(again.listEntries()).toHaveLength(12);
    expect(mdFiles(root)).toHaveLength(12);
    expect(again.search('đơn hàng', { limit: 50 })).toHaveLength(12);
    // Chỉ mục SQLite là file nhị phân hỏng hẳn
    again.close();
    services.pop();
    writeFileSync(join(root, '.nsa', 'index.sqlite'), 'không phải sqlite');
    expect((await open(root)).listEntries()).toHaveLength(12); // file chỉ mục hỏng → xoá đi, dựng lại
  });

  it('đã nhận đề xuất (mục đã ghi) mà chưa kịp cập nhật hộp duyệt → mở lại không nhận đúp', async () => {
    const root = fresh();
    const s = await open(root);
    const draft = { ...entry('Giá', 'cà phê muối 32000'), source: { kind: 'plugin' as const } };
    const p = await s.propose(draft);
    expect(p.status).toBe('accepted');
    s.close();
    services.pop();
    // Giả lập chết trước khi hộp duyệt ghi trạng thái: đề xuất còn 'pending' trên đĩa.
    const inbox = join(root, '.nsa', 'inbox.json');
    const data = JSON.parse(readFileSync(inbox, 'utf8')) as { proposals: { status: string }[] };
    data.proposals.forEach((x) => (x.status = 'pending'));
    writeFileSync(inbox, JSON.stringify(data));
    const again = await open(root);
    expect(again.listProposals('pending')).toHaveLength(0);
    expect(again.listEntries()).toHaveLength(1);
  });
});
