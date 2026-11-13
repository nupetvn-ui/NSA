import { describe, expect, it } from 'vitest';
import { domainAllowed, validateManifest } from './index.js';

const base = {
  id: 'kb',
  name: 'KB',
  version: '1.0.0',
  nsa: '>=0.1.0',
  main: 'main.js',
  icon: 'emoji:📚',
};

describe('mạng "*" và loại việc model (giai đoạn 5)', () => {
  it('"*" khớp trang web công cộng, không bao giờ khớp máy cục bộ / IP / tên nội bộ', () => {
    expect(domainAllowed('vnexpress.net', ['*'])).toBe(true);
    expect(domainAllowed('docs.example.co.uk', ['*'])).toBe(true);
    expect(domainAllowed('localhost', ['*'])).toBe(false);
    expect(domainAllowed('127.0.0.1', ['*'])).toBe(false);
    expect(domainAllowed('192.168.1.5', ['*'])).toBe(false);
    expect(domainAllowed('[::1]', ['*'])).toBe(false);
    expect(domainAllowed('nas', ['*'])).toBe(false);
    expect(domainAllowed('may-in.local', ['*'])).toBe(false);
    expect(domainAllowed('localhost', ['*', 'localhost'])).toBe(true); // khai đích danh thì được
  });

  it('manifest nhận "*" trong network', () => {
    expect(validateManifest({ ...base, permissions: { network: ['*'] } }).ok).toBe(true);
  });

  it('modelTasks mặc định chỉ kênh chat; khai vision / embedding; loại lạ bị từ chối', () => {
    const ok = validateManifest({ ...base, permissions: { model: true } });
    expect(ok.ok && ok.manifest.permissions.modelTasks).toEqual(['channel']);
    const more = validateManifest({
      ...base,
      permissions: { model: true, modelTasks: ['vision', 'embedding'] },
    });
    expect(more.ok && more.manifest.permissions.modelTasks).toEqual(['vision', 'embedding']);
    expect(
      validateManifest({ ...base, permissions: { model: true, modelTasks: ['gì-đó'] } }).ok,
    ).toBe(false);
  });
});
