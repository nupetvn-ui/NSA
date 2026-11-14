import { mkdtempSync, rmSync } from 'node:fs';
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

describe('ngữ cảnh tự chèn đầu lượt', () => {
  it('nhánh ẩn của plugin (Knowledge Base…) không bị chèn vào mọi cuộc trò chuyện', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nsa-ctx-'));
    dirs.push(root);
    const service = await MemoryService.open({
      root,
      identity: localIdentity('tester'),
      policy: personalPolicy(),
      audit: memoryAuditLog(),
    });
    services.push(service);
    await service.saveBranch('plugin', { title: 'plugin', hidden: true });
    await service.saveBranch('plugin/knowledge-base', { title: 'KB', hidden: true });
    await service.teach({
      branch: 'plugin/knowledge-base',
      title: 'Bảng giá',
      body: 'Trà đào cam sả 45000 đồng',
      kind: 'fact',
      confidence: 0.9,
    });
    await service.teach({
      branch: 'nguoi-dung',
      title: 'Tên',
      body: 'Người dùng tên là Lan',
      kind: 'fact',
      confidence: 0.9,
    });
    const ctx = service.contextFor('trà đào cam sả giá bao nhiêu');
    expect(ctx?.text).toContain('tên là Lan');
    expect(ctx?.text).not.toContain('45000');
    // Vẫn tìm được khi hỏi thẳng nhánh đó (đường của chính plugin).
    expect(service.search('cam sả', { branch: 'plugin/knowledge-base' })).toHaveLength(1);
  });
});
