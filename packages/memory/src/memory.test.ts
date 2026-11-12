import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  localIdentity,
  memoryAuditLog,
  personalPolicy,
  type MemoryDraft,
  type Policy,
} from '@nsa/core';
import { MemoryService } from './service.js';

const dirs: string[] = [];
const services: MemoryService[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nsa-mem-'));
  dirs.push(dir);
  return dir;
}

async function open(root = tempDir(), policy: Policy = personalPolicy()) {
  const audit = memoryAuditLog();
  const service = await MemoryService.open({
    root,
    identity: localIdentity('tester'),
    policy,
    audit,
  });
  services.push(service);
  return { service, audit, root };
}

afterEach(() => {
  for (const s of services.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function draft(partial: Partial<MemoryDraft> = {}): MemoryDraft {
  return {
    branch: 'nguoi-dung',
    title: 'Màu yêu thích',
    body: 'Người dùng thích màu xanh lá.',
    kind: 'preference',
    subject: 'mau-yeu-thich',
    confidence: 0.95,
    source: { kind: 'agent', agentId: 'claude' },
    ...partial,
  };
}

describe('kho nhớ Markdown + git', () => {
  it('tạo kho với các nhánh mặc định, mục nhớ là file Markdown có phần đầu đủ trường', async () => {
    const { service, root } = await open();
    expect(service.listBranches().map((b) => b.path)).toEqual([
      'chung',
      'du-an',
      'nguoi-dung',
      'quy-tac',
    ]);
    const entry = await service.teach({
      branch: 'nguoi-dung',
      title: 'Tên',
      body: 'Người dùng tên là An.',
      kind: 'fact',
    });
    const text = readFileSync(join(root, 'nguoi-dung', `${entry.id}.md`), 'utf8');
    expect(text).toMatch(/^---\n/);
    for (const field of ['source', 'confidence', 'created', 'owner', 'scope']) {
      expect(text).toContain(`${field}:`);
    }
    expect(entry.owner).toBe('local:tester');
    expect(entry.scope).toBe('personal');
    expect(existsSync(join(root, '.git'))).toBe(true);
  });

  it('tìm không dấu vẫn ra mục có dấu (FTS5 unicode61 remove_diacritics)', async () => {
    const { service } = await open();
    await service.teach({
      branch: 'nguoi-dung',
      title: 'Màu',
      body: 'Người dùng thích màu xanh lá.',
      kind: 'preference',
    });
    expect(service.search('mau xanh')[0]?.entry.body).toContain('xanh lá');
    expect(service.search('Màu yêu thích của tôi là gì?')).toHaveLength(1);
  });

  it('hoàn tác một lần sửa thì mục nhớ trở về như cũ; hoàn tác lần tạo thì mục biến mất', async () => {
    const { service, root } = await open();
    const entry = await service.teach({
      branch: 'chung',
      title: 'Cà phê',
      body: 'Uống cà phê đen.',
      kind: 'preference',
    });
    const file = join(root, 'chung', `${entry.id}.md`);
    const original = readFileSync(file, 'utf8');
    await service.update(entry.id, { body: 'Uống cà phê sữa.' });
    expect(service.get(entry.id)?.body).toBe('Uống cà phê sữa.');

    const history = await service.history({ entryId: entry.id });
    expect(history.map((h) => h.op)).toEqual(['update', 'create']);
    expect(history[0]?.undoable).toBe(true);
    expect(history[1]?.undoable).toBe(false); // còn thay đổi mới hơn

    await service.undo(history[0]?.commit ?? '');
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(service.get(entry.id)?.body).toBe('Uống cà phê đen.');
    expect(service.search('sua')).toHaveLength(0);

    // Bản hoàn tác cũng là một thay đổi: hoàn tác nó thì quay lại bản đã sửa.
    const again = await service.history({ entryId: entry.id });
    expect(again[0]?.op).toBe('revert');
    await service.undo(again[0]?.commit ?? '');
    expect(service.get(entry.id)?.body).toBe('Uống cà phê sữa.');
  });

  it('hoàn tác lần xoá thì mục nhớ quay lại', async () => {
    const { service } = await open();
    const entry = await service.teach({
      branch: 'chung',
      title: 'X',
      body: 'Điều cần giữ.',
      kind: 'fact',
    });
    await service.delete(entry.id);
    expect(service.get(entry.id)).toBeNull();
    const [latest] = await service.history();
    expect(latest?.op).toBe('delete');
    await service.undo(latest?.commit ?? '');
    expect(service.get(entry.id)?.body).toBe('Điều cần giữ.');
  });

  it('không hoàn tác được thay đổi cũ khi mục đã bị đổi tiếp', async () => {
    const { service } = await open();
    const entry = await service.teach({ branch: 'chung', title: 'A', body: 'một', kind: 'fact' });
    await service.update(entry.id, { body: 'hai' });
    const history = await service.history({ entryId: entry.id });
    await expect(service.undo(history[1]?.commit ?? '')).rejects.toThrow(
      /hoàn tác thay đổi mới hơn/,
    );
  });

  it('xoá chỉ mục SQLite rồi mở lại: dựng lại từ Markdown, vẫn tìm ra', async () => {
    const root = tempDir();
    const first = await open(root);
    await first.service.teach({
      branch: 'du-an',
      title: 'Gói',
      body: 'Dự án NSA dùng pnpm.',
      kind: 'fact',
    });
    first.service.close();
    services.splice(services.indexOf(first.service), 1);
    rmSync(join(root, '.nsa', 'index.sqlite'), { force: true });

    const second = await open(root);
    expect(second.service.search('pnpm')[0]?.entry.title).toBe('Gói');
  });
});

describe('hộp duyệt', () => {
  it('đề xuất chắc chắn, không mâu thuẫn → tự nhận', async () => {
    const { service } = await open();
    const p = await service.propose(draft());
    expect(p.status).toBe('accepted');
    expect(p.decidedBy).toBe('auto');
    expect(service.get(p.entryId ?? '')?.source).toEqual({ kind: 'agent', agentId: 'claude' });
  });

  it('đề xuất mâu thuẫn với mục đã có → nằm lại hộp duyệt, kèm mục mâu thuẫn', async () => {
    const { service } = await open();
    await service.propose(draft());
    const p = await service.propose(
      draft({ body: 'Người dùng thích màu đỏ.', title: 'Màu yêu thích mới' }),
    );
    expect(p.status).toBe('pending');
    expect(p.conflicts.map((c) => c.body)).toEqual(['Người dùng thích màu xanh lá.']);
    expect(p.reasons.join(' ')).toMatch(/Mâu thuẫn/);
    expect(service.listEntries()).toHaveLength(1);
  });

  it('mâu thuẫn được phát hiện cả khi không có khoá chủ đề (nội dung rất giống)', async () => {
    const { service } = await open();
    await service.propose(draft({ subject: undefined as unknown as string }));
    const noSubject = draft({ body: 'Người dùng thích màu đỏ.' });
    delete noSubject.subject;
    const p = await service.propose(noSubject);
    expect(p.status).toBe('pending');
  });

  it('quy tắc hành vi, nhạy cảm, độ tin cậy thấp, nhánh luôn duyệt → chờ người duyệt', async () => {
    const { service } = await open();
    const rule = await service.propose(
      draft({
        kind: 'rule',
        subject: 'r1',
        title: 'Không push',
        body: 'Không bao giờ git push lên main.',
      }),
    );
    const secret = await service.propose(
      draft({ subject: 's1', title: 'Mật khẩu wifi', body: 'Mật khẩu wifi nhà là abc123456.' }),
    );
    const low = await service.propose(
      draft({
        subject: 'l1',
        confidence: 0.4,
        title: 'Có thể thích trà',
        body: 'Có vẻ người dùng thích trà.',
      }),
    );
    const strict = await service.propose(
      draft({
        branch: 'quy-tac',
        kind: 'fact',
        subject: 'q1',
        title: 'Q',
        body: 'Một điều trong nhánh quy tắc.',
      }),
    );
    for (const p of [rule, secret, low, strict]) expect(p.status).toBe('pending');
    expect(rule.reasons.join()).toMatch(/quy tắc hành vi/);
    expect(secret.reasons.join()).toMatch(/nhạy cảm/);
    expect(low.reasons.join()).toMatch(/Độ tin cậy/);
    expect(strict.reasons.join()).toMatch(/luôn cần người duyệt/);
    expect(service.listEntries()).toHaveLength(0);
  });

  it('đề xuất trùng y hệt → tự từ chối', async () => {
    const { service } = await open();
    await service.propose(draft());
    const dup = await service.propose(draft({ title: 'Màu' }));
    expect(dup.status).toBe('rejected');
    expect(dup.reasons.join()).toMatch(/Trùng/);
  });

  it('người dùng sửa rồi nhận, hoặc từ chối', async () => {
    const { service } = await open();
    const p = await service.propose(
      draft({ kind: 'rule', subject: 'x', title: 'Rule', body: 'Luôn trả lời bằng tiếng Việt.' }),
    );
    const entry = await service.accept(p.id, { body: 'Luôn trả lời bằng tiếng Việt có dấu.' });
    expect(entry.body).toBe('Luôn trả lời bằng tiếng Việt có dấu.');
    expect(service.listProposals('pending')).toHaveLength(0);

    const q = await service.propose(
      draft({
        kind: 'rule',
        subject: 'y',
        title: 'R2',
        body: 'Một quy tắc khác hẳn về định dạng.',
      }),
    );
    await service.reject(q.id);
    expect(service.listProposals('rejected').map((x) => x.id)).toContain(q.id);
    await expect(service.accept(q.id)).rejects.toThrow();
  });

  it('mọi thay đổi đi qua Policy: chặn thì không ghi file, nhật ký ghi lại', async () => {
    const deny: Policy = {
      check: ({ action }) =>
        action.kind === 'memory.write'
          ? { decision: 'deny', reason: 'cấm ghi nhớ' }
          : { decision: 'allow' },
    };
    const { service, audit } = await open(tempDir(), deny);
    await expect(
      service.teach({ branch: 'chung', title: 'A', body: 'B', kind: 'fact' }),
    ).rejects.toThrow(/cấm ghi nhớ/);
    expect(service.listEntries()).toHaveLength(0);
    const p = await service.propose(draft());
    expect(p.status).toBe('pending');
    expect(p.reasons.join()).toMatch(/cấm ghi nhớ/);
    expect(audit.entries.some((e) => e.type === 'memory' && e.decision === 'deny')).toBe(true);
  });

  it('nhật ký ghi propose / accept / create', async () => {
    const { service, audit } = await open();
    await service.propose(draft());
    const ops = audit.entries.flatMap((e) => (e.type === 'memory' ? [`${e.op}:${e.by}`] : []));
    expect(ops).toEqual(['propose:agent', 'create:auto', 'accept:auto']);
  });
});

describe('ngữ cảnh cho agent', () => {
  it('chèn quy tắc + mục liên quan, bỏ mục nhạy cảm', async () => {
    const { service } = await open();
    await service.teach({
      branch: 'nguoi-dung',
      title: 'Màu',
      body: 'Người dùng thích màu xanh lá.',
      kind: 'preference',
    });
    await service.teach({
      branch: 'quy-tac',
      title: 'Ngôn ngữ',
      body: 'Luôn trả lời bằng tiếng Việt.',
      kind: 'rule',
    });
    await service.teach({
      branch: 'chung',
      title: 'Wifi',
      body: 'Mật khẩu wifi là 123.',
      kind: 'fact',
      sensitive: true,
    });
    const ctx = service.contextFor('màu gì?');
    expect(ctx?.text).toContain('xanh lá');
    expect(ctx?.text).toContain('(Quy tắc)');
    expect(ctx?.text).not.toContain('wifi');
    expect(ctx?.entries).toHaveLength(2);
  });

  it('kho trống → không chèn gì', async () => {
    const { service } = await open();
    expect(service.contextFor('xin chào')).toBeNull();
    expect(service.contextFor('xin chào', { tools: true })).toMatchObject({ entries: [] });
  });
});
