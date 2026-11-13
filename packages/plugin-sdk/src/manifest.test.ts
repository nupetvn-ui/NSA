import { describe, expect, it } from 'vitest';
import {
  domainAllowed,
  formatManifestErrors,
  gatewayToolName,
  isCompatible,
  satisfies,
  validateManifest,
} from './index.js';

const valid = {
  id: 'ghi-chu',
  name: 'Ghi chú',
  version: '1.0.0',
  nsa: '>=0.1.0',
  main: 'main.js',
  icon: 'emoji:📝',
  permissions: { network: ['api.example.com'], memory: true, notifications: true },
  tools: [{ name: 'add_note', description: 'Thêm ghi chú', sensitive: false }],
  screens: [{ id: 'main', title: 'Ghi chú', entry: 'ui/index.html' }],
  jobs: [{ id: 'tick', title: 'Đồng bộ', every: '5m' }],
  memory: { branch: 'ghi-chu', title: 'Ghi chú' },
};

describe('manifest', () => {
  it('nhận manifest đúng và điền giá trị mặc định', () => {
    const r = validateManifest(valid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.jobs[0]?.everySeconds).toBe(300);
    expect(r.manifest.tools[0]).toMatchObject({ sensitive: false, readOnly: false });
    expect(r.manifest.permissions.folders).toEqual([]);
  });

  it('báo mọi lỗi cùng lúc, bằng tiếng Việt, kèm vị trí', () => {
    const r = validateManifest({
      id: 'Sai Tên',
      version: '1',
      nsa: 'abc',
      tools: [{ name: 'Add', description: '' }, 'x'],
      permissions: { network: ['http://x'], camera: true },
      jobs: [{ id: 'a', title: 'A', every: '2s' }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const paths = r.errors.map((e) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'id',
        'name',
        'version',
        'nsa',
        'tools[0].name',
        'tools[0].description',
        'tools[1]',
        'permissions.network[0]',
        'permissions.camera',
        'jobs[0].every',
      ]),
    );
    expect(formatManifestErrors(r.errors)).toContain('• id:');
    expect(formatManifestErrors(r.errors)).toMatch(/không phải tên miền hợp lệ/);
  });

  it('plugin có tool / việc nền thì phải có main; quyền memory đi kèm nhánh', () => {
    const noMain = validateManifest({ ...valid, main: undefined });
    expect(noMain.ok).toBe(false);
    const noBranch = validateManifest({ ...valid, memory: undefined });
    expect(noBranch.ok).toBe(false);
    const noPerm = validateManifest({ ...valid, permissions: {} });
    expect(noPerm.ok).toBe(false);
  });

  it('tên dành riêng, tool vừa nhạy cảm vừa chỉ đọc, đường dẫn thoát thư mục bị từ chối', () => {
    expect(validateManifest({ ...valid, id: 'nsa' }).ok).toBe(false);
    expect(
      validateManifest({
        ...valid,
        tools: [{ name: 'a', description: 'x', sensitive: true, readOnly: true }],
      }).ok,
    ).toBe(false);
    expect(validateManifest({ ...valid, main: '../x.js' }).ok).toBe(false);
    expect(validateManifest({ ...valid, icon: '/etc/passwd.png' }).ok).toBe(false);
  });

  it('tương thích phiên bản, tên miền và tên tool trên cổng', () => {
    expect(satisfies('0.2.1', '>=0.1.0')).toBe(true);
    expect(satisfies('0.2.1', '^0.2.0')).toBe(true);
    expect(satisfies('0.3.0', '^0.2.0')).toBe(false);
    expect(satisfies('1.4.0', '>=1.0.0 <2.0.0')).toBe(true);
    expect(satisfies('2.0.0', '>=1.0.0 <2.0.0')).toBe(false);
    expect(satisfies('1.2.3', '1.x')).toBe(true);
    expect(satisfies('0.1.0', '*')).toBe(true);
    expect(isCompatible({ nsa: '>=0.5.0' }, '0.1.0')).toBe(false);
    expect(domainAllowed('api.example.com', ['api.example.com'])).toBe(true);
    expect(domainAllowed('x.example.com', ['*.example.com'])).toBe(true);
    expect(domainAllowed('example.com', ['*.example.com'])).toBe(false);
    expect(domainAllowed('evilexample.com', ['*.example.com'])).toBe(false);
    expect(gatewayToolName('ghi-chu', 'add_note')).toBe('ghi_chu__add_note');
  });
});
