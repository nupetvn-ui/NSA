import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentAdapter } from '@nsa/adapter-sdk';
import { generateSigningKey, type SigningKey, type TrustedPublisher } from '@nsa/plugin-host';
import { AdapterManager, type AdapterManagerOptions } from './manager.js';
import { IndexAdapterSource } from './source.js';
import { buildPack, writeRelease, type BuiltPack, type PackInput } from './release.js';
import type { AdapterAuditEvent, AdapterNotice } from './types.js';

const requireModule = createRequire(import.meta.url);
const nsaKey = generateSigningKey();
const otherKey = generateSigningKey();
const trusted: TrustedPublisher[] = [
  { keyId: nsaKey.keyId, name: 'NSA', publicKey: nsaKey.publicKey },
];
const sign = (key: SigningKey = nsaKey) => ({ key, publisher: 'NSA' });

const CAPS = `{streaming:false,resume:false,tools:false,editFiles:false,images:false,mcp:false,subagents:false,toolGate:false,tier:'headless'}`;

/** Mã CommonJS của một adapter giả (đúng dạng gói thật). */
function moduleSource(name: string, extra = ''): string {
  return `
    ${extra}
    module.exports = {
      contract: 1,
      createAdapter() {
        return {
          id: 'claude',
          displayName: ${JSON.stringify(name)},
          detect: async () => ({ installed: false, ready: false }),
          capabilities: () => (${CAPS}),
          run: () => ({ cancel() {}, finished: Promise.resolve() }),
        };
      },
    };`;
}

function bundledClaude(): AdapterManagerOptions['bundled'][number] {
  return {
    id: 'claude',
    version: '0.1.0',
    create: (): AgentAdapter => ({
      id: 'claude',
      displayName: 'Claude Code',
      detect: () => Promise.resolve({ installed: false, ready: false }),
      capabilities: () => ({
        streaming: false,
        resume: false,
        tools: false,
        editFiles: false,
        images: false,
        mcp: false,
        subagents: false,
        toolGate: false,
        tier: 'headless' as const,
      }),
      run: () => ({ cancel: () => undefined, finished: Promise.resolve() }),
    }),
  };
}

function adapterPack(
  version: string,
  code: string,
  options: { key?: SigningKey | null; nsa?: string } = {},
): BuiltPack {
  const input: PackInput = {
    kind: 'adapter',
    id: 'claude',
    version,
    nsa: options.nsa ?? '>=0.1.0',
    entryContent: code,
  };
  return buildPack(input, options.key === null ? undefined : sign(options.key ?? nsaKey));
}

let servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  servers = [];
});

function setup(packs: BuiltPack[], overrides: Partial<AdapterManagerOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nsa-adapters-'));
  const releaseDir = join(root, 'release');
  const indexFile = writeRelease(releaseDir, packs);
  const audits: AdapterAuditEvent[] = [];
  const notices: AdapterNotice[] = [];
  const changed: string[][] = [];
  const options: AdapterManagerOptions = {
    dir: join(root, 'adapters'),
    appVersion: '0.1.0',
    bundled: [bundledClaude()],
    trusted,
    source: new IndexAdapterSource(indexFile),
    audit: (e) => audits.push(e),
    notify: (n) => notices.push(n),
    onChanged: (ids) => changed.push(ids),
    ...overrides,
  };
  return {
    root,
    releaseDir,
    indexFile,
    audits,
    notices,
    changed,
    options,
    make: () => new AdapterManager(options),
  };
}

const name = (m: AdapterManager) => m.create('claude').displayName;

describe('AdapterManager — cập nhật adapter không cần cập nhật app', () => {
  it('bản kèm app chạy khi chưa có gì tải về', () => {
    const t = setup([]);
    const m = t.make();
    expect(name(m)).toBe('Claude Code');
    expect(m.status()).toEqual([
      { id: 'claude', source: 'bundled', version: '0.1.0', bundledVersion: '0.1.0' },
    ]);
  });

  it('gói ký đúng, mới hơn, tương thích → dùng ngay; mở lại app vẫn dùng', async () => {
    const t = setup([adapterPack('0.2.0', moduleSource('Claude Code (bản mới)'))]);
    const m = t.make();
    const report = await m.checkForUpdates();
    expect(report.installed).toEqual([{ id: 'claude', version: '0.2.0' }]);
    expect(name(m)).toBe('Claude Code (bản mới)');
    expect(m.status()[0]).toMatchObject({ source: 'downloaded', version: '0.2.0' });
    expect(t.changed).toEqual([['claude']]);
    expect(t.audits.map((a) => a.action)).toEqual(['installed']);
    expect(t.notices[0]?.level).toBe('info');
    // "Mở lại app": một manager mới trên cùng thư mục dữ liệu.
    expect(name(t.make())).toBe('Claude Code (bản mới)');
  });

  it('bản không mới hơn bản đang dùng thì bỏ qua (không hạ cấp)', async () => {
    const t = setup([adapterPack('0.1.0', moduleSource('Cũ'))]);
    const m = t.make();
    expect((await m.checkForUpdates()).installed).toEqual([]);
    expect(name(m)).toBe('Claude Code');
  });

  it('gói bị sửa sau khi ký → bị từ chối, bản kèm app vẫn chạy', async () => {
    const good = adapterPack('0.2.0', moduleSource('Hợp lệ'));
    // Giải gói, đổi mã trong file vào, nén lại NGUYÊN chữ ký cũ.
    const json = JSON.parse(gunzipSync(good.bytes).toString('utf8')) as {
      files: Record<string, string>;
    };
    json.files['index.cjs'] = Buffer.from(moduleSource('Độc hại')).toString('base64');
    const tampered: BuiltPack = { ...good, bytes: gzipSync(Buffer.from(JSON.stringify(json))) };
    delete tampered.entry.sha256; // chỉ mục không bảo vệ: chữ ký mới là lớp chính
    const t = setup([tampered]);
    const m = t.make();
    const report = await m.checkForUpdates();
    expect(report.rejected[0]?.reason).toContain('bị sửa sau khi ký');
    expect(name(m)).toBe('Claude Code');
    expect(t.audits[0]).toMatchObject({ action: 'rejected', version: '0.2.0' });
    expect(t.notices[0]?.level).toBe('warn');
    // Không thử lại đúng phiên bản đó.
    expect((await m.checkForUpdates()).rejected).toEqual([]);
  });

  it('mã băm trong chỉ mục không khớp file tải về → từ chối', async () => {
    const p = adapterPack('0.2.0', moduleSource('A'));
    p.entry.sha256 = '0'.repeat(64);
    const t = setup([p]);
    const report = await t.make().checkForUpdates();
    expect(report.rejected[0]?.reason).toContain('mã băm');
  });

  it('gói chưa ký, hoặc ký bằng khoá lạ → từ chối (không có chế độ cài gói chưa ký ngoài dev)', async () => {
    for (const key of [null, otherKey] as const) {
      const t = setup([adapterPack('0.2.0', moduleSource('A'), { key })]);
      const m = t.make();
      const report = await m.checkForUpdates();
      expect(report.installed).toEqual([]);
      expect(report.rejected).toHaveLength(1);
      expect(name(m)).toBe('Claude Code');
    }
  });

  it('chế độ nhà phát triển (allowUnsigned) nhận gói chưa ký, nhưng vẫn từ chối gói bị sửa', async () => {
    const t = setup([adapterPack('0.2.0', moduleSource('Dev'), { key: null })], {
      allowUnsigned: true,
    });
    const m = t.make();
    expect((await m.checkForUpdates()).installed).toHaveLength(1);
    expect(name(m)).toBe('Dev');
  });

  it('không tương thích với phiên bản app → từ chối (kể cả khi chỉ mục khai là hợp)', async () => {
    // Manifest trong gói (đã ký) đòi app >= 9, dù chỉ mục khai >= 0.1.
    const p = adapterPack('0.3.0', moduleSource('B'), { nsa: '>=9.0.0' });
    p.entry.nsa = '>=0.1.0';
    const t = setup([p]);
    const m = t.make();
    const report = await m.checkForUpdates();
    expect(report.rejected[0]?.reason).toContain('cần NSA');
    expect(name(m)).toBe('Claude Code');
  });

  it('chỉ mục khai trước là không hợp app này → bỏ qua, không tải', async () => {
    const t = setup([adapterPack('0.4.0', moduleSource('C'), { nsa: '>=9.0.0' })]);
    const report = await t.make().checkForUpdates();
    expect(report).toEqual({ installed: [], rejected: [] });
  });

  it('bản tải về nạp lỗi (cú pháp / ném lỗi) → từ chối, không thành bản chạy', async () => {
    for (const code of ['this is not javascript (', "throw new Error('boom');"]) {
      const t = setup([adapterPack('0.2.0', code)]);
      const m = t.make();
      const report = await m.checkForUpdates();
      expect(report.rejected[0]?.reason).toContain('không nạp được');
      expect(name(m)).toBe('Claude Code');
      expect(readdirSync(join(t.options.dir, 'claude'))).toEqual([]); // đã dọn
    }
  });

  it('trượt test hợp đồng tối thiểu → từ chối', async () => {
    const wrongId = moduleSource('X').replace("id: 'claude'", "id: 'codex'");
    const noRun = moduleSource('X').replace(
      'run: () => ({ cancel() {}, finished: Promise.resolve() }),',
      '',
    );
    const badDetect = moduleSource('X').replace(
      'detect: async () => ({ installed: false, ready: false })',
      'detect: async () => 42',
    );
    for (const [code, why] of [
      [wrongId, 'khác mã gói'],
      [noRun, 'thiếu hàm run'],
      [badDetect, 'detect()'],
    ] as const) {
      const t = setup([adapterPack('0.2.0', code)]);
      const m = t.make();
      const report = await m.checkForUpdates();
      expect(report.rejected[0]?.reason).toContain(why);
      expect(name(m)).toBe('Claude Code');
    }
  });

  it('bản đã cài nhưng hỏng lúc mở app (file bị hỏng) → quay về bản kèm app, báo người dùng, ghi nhật ký', async () => {
    const t = setup([adapterPack('0.2.0', moduleSource('Tốt'))]);
    await t.make().checkForUpdates();
    // Hỏng sau khi cài: ai đó / lỗi đĩa làm hỏng file.
    writeFileSync(join(t.options.dir, 'claude', '0.2.0', 'index.cjs'), 'module.exports = {');
    t.audits.length = 0;
    t.notices.length = 0;
    const m = t.make();
    expect(name(m)).toBe('Claude Code');
    expect(m.status()[0]?.source).toBe('bundled');
    expect(t.audits[0]).toMatchObject({ action: 'fallback', version: '0.2.0' });
    expect(t.notices[0]).toMatchObject({ level: 'warn' });
    expect(t.notices[0]?.message).toContain('quay về bản kèm app');
    // Không thử lại bản hỏng; lần mở sau không báo lại.
    t.notices.length = 0;
    expect(name(t.make())).toBe('Claude Code');
    expect(t.notices).toEqual([]);
    expect((await t.make().checkForUpdates()).installed).toEqual([]);
  });

  it('bản tải về nạp được nhưng createAdapter() ném lỗi lúc dùng → lùi về bản kèm app ngay', async () => {
    let boom = false;
    const t = setup([adapterPack('0.2.0', moduleSource('Tốt'))], {
      loadModule: (file) => {
        const mod = requireModule(file) as {
          createAdapter(p?: unknown): unknown;
          contract: number;
        };
        return {
          contract: mod.contract,
          createAdapter: (p?: unknown) => {
            if (boom) throw new Error('hỏng lúc chạy');
            return mod.createAdapter(p);
          },
        };
      },
    });
    const m = t.make();
    await m.checkForUpdates();
    expect(name(m)).toBe('Tốt');
    boom = true;
    expect(name(m)).toBe('Claude Code');
    expect(t.audits.at(-1)).toMatchObject({ action: 'fallback' });
    expect(m.status()[0]?.source).toBe('bundled');
  });

  it('app cập nhật và đã kèm bản mới hơn bản tải về thì bỏ bản tải về cũ', async () => {
    const t = setup([adapterPack('0.2.0', moduleSource('Tải về'))]);
    await t.make().checkForUpdates();
    const newBundled = { ...bundledClaude(), version: '0.3.0' };
    const m = new AdapterManager({ ...t.options, bundled: [newBundled] });
    expect(m.status()[0]).toMatchObject({ source: 'bundled', version: '0.3.0' });
  });

  it('nguồn lỗi (không tải được chỉ mục) → báo trong kết quả, không ném, bản kèm app vẫn chạy', async () => {
    const t = setup([], {
      source: new IndexAdapterSource(join(tmpdir(), 'khong-co', 'index.json')),
    });
    const m = t.make();
    const report = await m.checkForUpdates();
    expect(report.error).toBeTruthy();
    expect(name(m)).toBe('Claude Code');
  });
});

describe('AdapterManager — file dữ liệu hãng/model theo cùng kênh', () => {
  const catalogOptions = (root: string) => ({
    file: join(root, 'provider-catalog.json'),
    bundledVersion: '2026.11.12',
    validate: (json: unknown): { version: string } | string => {
      const v = (json as { version?: unknown }).version;
      return typeof v === 'string' ? { version: v } : 'thiếu version';
    },
  });
  const catalogPack = (version: string, body: unknown, key: SigningKey | null = nsaKey) =>
    buildPack(
      {
        kind: 'catalog',
        id: 'provider-catalog',
        version,
        nsa: '>=0.1.0',
        entryContent: JSON.stringify(body),
      },
      key ? sign(key) : undefined,
    );

  it('bản mới hơn, ký đúng, hợp lệ → ghi ra provider-catalog.json', async () => {
    const t = setup([catalogPack('2026.12.01', { version: '2026.12.01', providers: [] })]);
    const cat = catalogOptions(t.root);
    const m = new AdapterManager({ ...t.options, catalog: cat });
    expect((await m.checkForUpdates()).installed).toEqual([
      { id: 'provider-catalog', version: '2026.12.01' },
    ]);
    expect(JSON.parse(readFileSync(cat.file, 'utf8')).version).toBe('2026.12.01');
    expect(t.audits[0]).toMatchObject({ action: 'catalog' });
  });

  it('bản cũ hơn, không hợp lệ, hoặc chưa ký → không ghi', async () => {
    const t = setup([
      catalogPack('2026.10.01', { version: '2026.10.01' }),
      catalogPack('2026.12.02', { thieu: true }),
      catalogPack('2026.12.03', { version: '2026.12.03' }, null),
    ]);
    const cat = catalogOptions(t.root);
    const m = new AdapterManager({ ...t.options, catalog: cat });
    const report = await m.checkForUpdates();
    expect(report.installed).toEqual([]);
    expect(report.rejected.map((r) => r.version).sort()).toEqual(['2026.12.02', '2026.12.03']);
    expect(() => readFileSync(cat.file)).toThrow();
  });
});

describe('IndexAdapterSource', () => {
  function serve(dir: string): Promise<string> {
    return new Promise((resolve) => {
      const server = createServer((req, res) => {
        try {
          const body = readFileSync(join(dir, (req.url ?? '/').slice(1)));
          res.writeHead(200).end(body);
        } catch {
          res.writeHead(404).end();
        }
      });
      servers.push(server);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`);
      });
    });
  }

  it('đọc chỉ mục và tải gói qua máy chủ cục bộ; gói được cài như thường', async () => {
    const t = setup([adapterPack('0.2.0', moduleSource('Qua HTTP'))]);
    const base = await serve(t.releaseDir);
    const m = new AdapterManager({
      ...t.options,
      source: new IndexAdapterSource(`${base}/index.json`),
    });
    expect((await m.checkForUpdates()).installed).toHaveLength(1);
    expect(name(m)).toBe('Qua HTTP');
  });

  it('địa chỉ http không phải loopback bị từ chối (chỉ https)', async () => {
    const source = new IndexAdapterSource('http://example.com/index.json');
    await expect(source.list()).rejects.toThrow(/https/);
  });

  it('bỏ qua mục hỏng trong chỉ mục mà không hỏng cả chỉ mục', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nsa-idx-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'index.json'),
      JSON.stringify({
        schema: 1,
        packages: [
          { id: 'claude' },
          { id: 'a', kind: 'adapter', version: '1.0.0', package: 'a.nsapkg' },
          7,
        ],
      }),
    );
    const list = await new IndexAdapterSource(join(dir, 'index.json')).list();
    expect(list.map((e) => e.id)).toEqual(['a']);
  });
});
