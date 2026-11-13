import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  localIdentity,
  memoryAuditLog,
  personalPolicy,
  type AuditEntry,
  type Policy,
} from '@nsa/core';
import { McpGateway } from '@nsa/mcp-gateway';
import { gzipSync } from 'node:zlib';
import {
  PluginHost,
  generateSigningKey,
  packDirectory,
  readPackage,
  safeRelativePath,
  verifyPackage,
  type PluginMemoryBridge,
} from './index.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(prefix = 'nsa-plug-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const MAIN = `
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
export default {
  tools: {
    echo: async (a, ctx) => 'echo:' + a.text + ':' + (ctx.caller && ctx.caller.agentId),
    read_file: async (a) => readFileSync(a.path, 'utf8'),
    list_dir: async (a) => readdirSync(a.path).join(','),
    write_file: async (a) => { writeFileSync(a.path, a.text); return 'ok'; },
    write_data: async (a, ctx) => { writeFileSync(join(ctx.dataDir, 'x.txt'), a.text); return readFileSync(join(ctx.dataDir, 'x.txt'), 'utf8'); },
    http_get: async (a) => { const r = await fetch(a.url); return r.status + ':' + (await r.text()); },
    raw_net: (a) => new Promise((resolve) => {
      try { const s = net.connect(Number(a.port), '127.0.0.1'); s.on('connect', () => resolve('CONNECTED')); s.on('error', (e) => resolve('ERR:' + e.code)); }
      catch (e) { resolve('THROW:' + e.code); }
    }),
    env: async () => JSON.stringify(Object.keys(process.env)),
    spawn: async () => { const cp = await import('node:child_process'); return cp.execSync('echo hi').toString(); },
    crash: async () => { setTimeout(() => process.exit(3), 20); return 'bye'; },
    hang: async () => { for (;;) {} },
    config: async (a, ctx) => { await ctx.config.set('k', a.v); return JSON.stringify(await ctx.config.all()); },
    notify: async (a, ctx) => { await ctx.notify({ title: a.title }); return 'sent'; },
    remember: async (a, ctx) => { if (!ctx.memory) return 'no-memory'; return JSON.stringify(await ctx.memory.propose({ title: a.title, body: a.body })); },
    search: async (a, ctx) => JSON.stringify(await ctx.memory.search(a.q)),
    delete_all: async () => 'deleted',
  },
  jobs: { tick: async (ctx) => { const n = (await ctx.config.get('ticks', 0)) + 1; await ctx.config.set('ticks', n); } },
  ui: { hello: async (p) => 'hi ' + p },
};
`;

const MANIFEST = {
  id: 'thu-nghiem',
  name: 'Thử nghiệm',
  version: '1.0.0',
  nsa: '>=0.1.0',
  main: 'main.js',
  icon: 'emoji:🧪',
  permissions: { network: ['localhost'], memory: true, notifications: true },
  memory: { branch: 'ghi-chu', title: 'Ghi chú' },
  tools: [
    'echo',
    'read_file',
    'list_dir',
    'write_file',
    'write_data',
    'http_get',
    'raw_net',
    'env',
    'spawn',
    'crash',
    'hang',
    'config',
    'notify',
    'remember',
    'search',
  ].map((name) => ({ name, description: `tool ${name}`, readOnly: false })),
  jobs: [{ id: 'tick', title: 'Đếm', every: '10s' }],
  screens: [{ id: 'main', title: 'Chính', entry: 'ui/index.html' }],
};

function writePlugin(overrides: Record<string, unknown> = {}, main = MAIN): string {
  const dir = tempDir('nsa-src-');
  writeFileSync(join(dir, 'nsa-plugin.json'), JSON.stringify({ ...MANIFEST, ...overrides }));
  writeFileSync(join(dir, 'main.js'), main);
  mkdirSync(join(dir, 'ui'));
  writeFileSync(join(dir, 'ui', 'index.html'), '<h1>xin chào</h1>');
  return dir;
}

interface Setup {
  host: PluginHost;
  audit: ReturnType<typeof memoryAuditLog>;
  dir: string;
  notes: string[];
  proposals: string[];
}

async function setup(
  options: {
    developerMode?: boolean;
    policy?: Policy;
    trusted?: { keyId: string; name: string; publicKey: string }[];
    toolTimeoutMs?: number;
    nsaVersion?: string;
  } = {},
): Promise<Setup> {
  const dir = tempDir('nsa-host-');
  const audit = memoryAuditLog();
  const notes: string[] = [];
  const proposals: string[] = [];
  const memory: PluginMemoryBridge = {
    ensureBranch: async () => undefined,
    search: async (branch, q) => [{ id: 'm-1', title: `${branch}:${q}`, snippet: 's' }],
    read: async () => null,
    propose: async (branch, pluginId, input) => {
      proposals.push(`${pluginId}@${branch}:${input.title}`);
      return { status: 'pending', reasons: ['chờ duyệt'] };
    },
  };
  const host = await PluginHost.open({
    dir,
    nsaVersion: options.nsaVersion ?? '0.1.0',
    identity: localIdentity('tester'),
    policy: options.policy ?? personalPolicy(),
    audit,
    trustedPublishers: options.trusted ?? [],
    memory,
    notify: (id, n) => notes.push(`${id}:${n.title}`),
    heartbeatMs: 0,
    toolTimeoutMs: options.toolTimeoutMs ?? 5000,
    startTimeoutMs: 10_000,
  });
  cleanups.push(() => host.close());
  if (options.developerMode !== false) host.saveSettings({ developerMode: true });
  return { host, audit, dir, notes, proposals };
}

const everything = {
  network: ['localhost'],
  memory: true,
  notifications: true,
  folders: {},
};

async function install(
  host: PluginHost,
  source: string,
  grants = everything,
): Promise<ReturnType<PluginHost['get']>> {
  const prepared = host.prepareFromDirectory(source);
  expect(prepared.blocked).toBeUndefined();
  let result = await host.install(prepared.prepareId, grants);
  if (result.status === 'needs_confirmation') {
    result = await host.install(prepared.prepareId, grants, true);
  }
  expect(result.status).toBe('installed');
  return host.get(prepared.manifest.id);
}

/** Gọi tool qua đường đi thật: gateway MCP (HTTP) → chính sách → plugin. */
async function gatewayFor(
  s: Setup,
  policy: Policy = personalPolicy(),
  askUser = () => Promise.resolve(true),
) {
  const gateway = await McpGateway.start({
    version: '0',
    identity: localIdentity('tester'),
    policy,
    audit: s.audit,
    askUser,
  });
  cleanups.push(() => gateway.close());
  gateway.addSource(() => s.host.tools());
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const { server, dispose } = gateway.register({
      agentId: 'claude',
      conversationId: 'c1',
      turnId: 't1',
    });
    try {
      const res = await fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: tool, arguments: args },
        }),
      });
      const json = (await res.json()) as {
        result?: { content: { text: string }[]; isError?: boolean };
        error?: { message: string };
      };
      return {
        text: json.result?.content[0]?.text ?? json.error?.message ?? '',
        isError: json.result?.isError === true || json.error !== undefined,
      };
    } finally {
      dispose();
    }
  };
  return { gateway, call };
}

async function waitFor(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('hết giờ chờ');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('gói + chữ ký', () => {
  it('ký rồi kiểm: tin cậy / chưa tin cậy; sửa một byte sau khi ký → tampered', () => {
    const src = writePlugin();
    const key = generateSigningKey();
    const bytes = packDirectory(src, { key, publisher: 'Nhà A' });
    const pkg = readPackage(bytes);
    const trusted = [{ keyId: key.keyId, name: 'Nhà A', publicKey: key.publicKey }];
    expect(verifyPackage(pkg, trusted)).toMatchObject({ status: 'trusted', publisher: 'Nhà A' });
    expect(verifyPackage(pkg, [])).toMatchObject({ status: 'untrusted' });
    expect(verifyPackage(readPackage(packDirectory(src)), trusted).status).toBe('unsigned');

    // Sửa nội dung main.js sau khi ký.
    const evil = readPackage(bytes);
    evil.files['main.js'] = Buffer.from('export default { tools: {} }; // độc').toString('base64');
    expect(verifyPackage(evil, trusted).status).toBe('tampered');
    // Thêm file mới sau khi ký cũng bị bắt.
    const extra = readPackage(bytes);
    extra.files['extra.js'] = Buffer.from('1').toString('base64');
    expect(verifyPackage(extra, trusted).status).toBe('tampered');
    // Đổi tên nhà phát hành (để mạo danh) cũng bắt được.
    const renamed = readPackage(bytes);
    if (renamed.signature) renamed.signature.publisher = 'Nhà B';
    expect(verifyPackage(renamed, trusted).status).toBe('tampered');
  });

  it('từ chối đường dẫn thoát thư mục và file không phải gói', () => {
    expect(() => safeRelativePath('../x')).toThrow();
    expect(() => safeRelativePath('a/../../x')).toThrow();
    expect(() => safeRelativePath('C:/x')).toThrow();
    expect(() => safeRelativePath('/x')).toThrow();
    expect(safeRelativePath('ui\\index.html')).toBe('ui/index.html');
    expect(() => readPackage(Buffer.from('rác'))).toThrow(/không phải gói/);
    const evil = gzipSync(
      Buffer.from(
        JSON.stringify({ format: 'nsa-plugin-package@1', files: { '../evil.js': 'eA==' } }),
      ),
    );
    expect(() => readPackage(evil)).toThrow(/Đường dẫn không hợp lệ/);
  });

  it('cài gói bị sửa sau khi ký: bị từ chối, không có gì được cài', async () => {
    const s = await setup({ developerMode: false });
    const src = writePlugin();
    const key = generateSigningKey();
    const trusted = [{ keyId: key.keyId, name: 'Nhà A', publicKey: key.publicKey }];
    const s2 = await setup({ trusted });
    const pkg = readPackage(packDirectory(src, { key, publisher: 'Nhà A' }));
    pkg.files['main.js'] = Buffer.from('export default {}').toString('base64');
    const file = join(tempDir(), 'evil.nsapkg');
    // Ghi lại đúng định dạng gói nhưng nội dung đã bị đổi.
    writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(pkg))));
    const prepared = s2.host.prepareFromFile(file);
    expect(prepared.signature).toBe('tampered');
    expect(prepared.blocked).toMatch(/bị sửa/);
    const result = await s2.host.install(prepared.prepareId, everything, true);
    expect(result.status).toBe('denied');
    expect(s2.host.list()).toEqual([]);
    expect(s.host.list()).toEqual([]);
  });

  it('gói ký bởi khoá tin cậy cài được ngay cả khi không bật chế độ nhà phát triển; chưa ký thì không', async () => {
    const src = writePlugin();
    const key = generateSigningKey();
    const trusted = [{ keyId: key.keyId, name: 'Nhà A', publicKey: key.publicKey }];
    const s = await setup({ developerMode: false, trusted });
    const signed = join(tempDir(), 'a.nsapkg');
    writeFileSync(signed, packDirectory(src, { key, publisher: 'Nhà A' }));
    const prepared = s.host.prepareFromFile(signed);
    expect(prepared.signature).toBe('trusted');
    expect(prepared.blocked).toBeUndefined();
    const installed = await s.host.install(prepared.prepareId, everything);
    expect(installed.status).toBe('installed');
    expect(s.host.get('thu-nghiem')?.developer).toBe(false);

    const unsigned = s.host.prepareFromDirectory(src);
    expect(unsigned.blocked).toMatch(/chế độ nhà phát triển/);
    const refused = await s.host.install(unsigned.prepareId, everything, true);
    expect(refused.status).toBe('denied');
  });

  it('kiểm phiên bản tương thích', async () => {
    const s = await setup({ nsaVersion: '0.1.0' });
    const prepared = s.host.prepareFromDirectory(writePlugin({ nsa: '>=0.5.0' }));
    expect(prepared.blocked).toMatch(/cần NSA phiên bản >=0.5.0/);
  });

  it('thông báo lỗi manifest dễ hiểu', async () => {
    const s = await setup();
    const dir = writePlugin({ id: 'Sai Tên', tools: [{ name: 'X' }] });
    expect(() => s.host.prepareFromDirectory(dir)).toThrow(/nsa-plugin\.json có lỗi[\s\S]*• id:/);
  });
});

describe('vòng đời: cài / bật / tắt / gỡ / cập nhật — không khởi động lại app', () => {
  it('cài → tool hiện trên cổng → tắt → tool biến mất → bật lại → gỡ', async () => {
    const s = await setup();
    const { gateway, call } = await gatewayFor(s);
    expect(gateway.listTools()).toEqual([]);

    const info = await install(s.host, writePlugin());
    expect(info?.status).toBe('running');
    expect(gateway.listTools().map((t) => t.name)).toContain('thu_nghiem__echo');
    expect(await call('thu_nghiem__echo', { text: 'a' })).toEqual({
      text: 'echo:a:claude',
      isError: false,
    });

    await s.host.setEnabled('thu-nghiem', false);
    expect(gateway.listTools()).toEqual([]);
    expect((await call('thu_nghiem__echo', { text: 'a' })).isError).toBe(true);
    expect(s.host.get('thu-nghiem')?.status).toBe('stopped');

    await s.host.setEnabled('thu-nghiem', true);
    expect((await call('thu_nghiem__echo', { text: 'b' })).text).toBe('echo:b:claude');

    await s.host.uninstall('thu-nghiem');
    expect(s.host.list()).toEqual([]);
    expect(gateway.listTools()).toEqual([]);
    expect(existsSync(join(s.dir, 'installed', 'thu-nghiem'))).toBe(false);
    expect(existsSync(join(s.dir, 'data', 'thu-nghiem'))).toBe(false);
    const ops = s.audit.entries
      .filter((e) => e.type === 'plugin')
      .map((e) => (e as { op: string }).op);
    expect(ops).toEqual(expect.arrayContaining(['install', 'disable', 'enable', 'uninstall']));
  });

  it('cập nhật lên bản mới: tool đổi theo, quyền mới xin thêm được báo, dữ liệu cũ còn', async () => {
    const s = await setup();
    const { call } = await gatewayFor(s);
    await install(s.host, writePlugin());
    expect((await call('thu_nghiem__write_data', { text: 'giữ' })).text).toBe('giữ');

    const v2 = writePlugin({
      version: '1.1.0',
      permissions: { network: ['localhost', 'api.example.com'], memory: true, notifications: true },
    });
    const prepared = s.host.prepareFromDirectory(v2);
    expect(prepared.upgradeFrom).toBe('1.0.0');
    expect(prepared.newPermissions).toEqual(['Truy cập mạng tới api.example.com']);
    const result = await s.host.install(prepared.prepareId, everything, true);
    expect(result.status).toBe('installed');
    expect(s.host.get('thu-nghiem')?.version).toBe('1.1.0');
    // Quyền mới KHÔNG tự được cấp.
    expect(s.host.get('thu-nghiem')?.grants.network).toEqual(['localhost']);
    expect(readFileSync(join(s.dir, 'data', 'thu-nghiem', 'x.txt'), 'utf8')).toBe('giữ');
    expect((await call('thu_nghiem__echo', { text: 'v2' })).text).toBe('echo:v2:claude');
  });

  it('trạng thái giữ qua lần mở lại (tắt app rồi mở)', async () => {
    const s = await setup();
    await install(s.host, writePlugin());
    await s.host.setEnabled('thu-nghiem', false);
    await s.host.close();
    const again = await PluginHost.open({
      dir: s.dir,
      nsaVersion: '0.1.0',
      identity: localIdentity('tester'),
      policy: personalPolicy(),
      heartbeatMs: 0,
    });
    cleanups.push(() => again.close());
    expect(again.get('thu-nghiem')).toMatchObject({ enabled: false, status: 'stopped' });
    await again.setEnabled('thu-nghiem', true);
    await waitFor(() => again.get('thu-nghiem')?.status === 'running');
  });

  it('việc nền chạy theo lịch, lưu kết quả vào cấu hình của plugin', async () => {
    const s = await setup();
    await install(s.host, writePlugin());
    await s.host.runJob('thu-nghiem', 'tick');
    await s.host.runJob('thu-nghiem', 'tick');
    expect(
      JSON.parse(readFileSync(join(s.dir, 'data', 'thu-nghiem', 'config.json'), 'utf8')),
    ).toEqual({
      ticks: 2,
    });
    expect(s.host.get('thu-nghiem')?.jobs[0]?.lastRun).toBeTruthy();
  });

  it('màn hình: file tĩnh chỉ trong thư mục plugin; hàm màn hình gọi được; plugin tắt thì không', async () => {
    const s = await setup();
    await install(s.host, writePlugin());
    expect(readFileSync(s.host.assetPath('thu-nghiem', 'ui/index.html') ?? '', 'utf8')).toContain(
      'xin chào',
    );
    expect(s.host.assetPath('thu-nghiem', '../state.json')).toBeNull();
    expect(s.host.assetPath('thu-nghiem', '../../state.json')).toBeNull();
    expect(await s.host.callUi('thu-nghiem', 'hello', 'bạn')).toBe('hi bạn');
    await expect(s.host.callUi('thu-nghiem', 'khong-co', 1)).rejects.toThrow();
    await s.host.setEnabled('thu-nghiem', false);
    expect(s.host.assetPath('thu-nghiem', 'ui/index.html')).toBeNull();
  });
});

describe('cô lập: plugin chỉ làm được điều đã được cấp', () => {
  it('đọc file ngoài thư mục của mình bị từ chối (kho khoá, trạng thái host, dữ liệu plugin khác)', async () => {
    const s = await setup();
    const { call } = await gatewayFor(s);
    await install(s.host, writePlugin());
    // "Kho khoá" giả đặt cạnh thư mục plugin host.
    const secrets = join(tempDir('nsa-secrets-'), 'secrets.json');
    writeFileSync(secrets, '{"openai":"sk-THAT-LA-KEY"}');
    const outside = await call('thu_nghiem__read_file', { path: secrets });
    expect(outside.isError).toBe(true);
    expect(outside.text).not.toContain('sk-THAT-LA-KEY');
    expect(outside.text).toMatch(/ERR_ACCESS_DENIED|Access to this API has been restricted/);
    // Trạng thái của host (nằm trong thư mục gốc plugin host, ngoài thư mục plugin).
    expect((await call('thu_nghiem__read_file', { path: join(s.dir, 'state.json') })).isError).toBe(
      true,
    );
    expect((await call('thu_nghiem__list_dir', { path: s.dir })).isError).toBe(true);
    // Dữ liệu của plugin khác.
    mkdirSync(join(s.dir, 'data', 'khac'), { recursive: true });
    writeFileSync(join(s.dir, 'data', 'khac', 'bi-mat.txt'), 'của plugin khác');
    expect(
      (await call('thu_nghiem__read_file', { path: join(s.dir, 'data', 'khac', 'bi-mat.txt') }))
        .isError,
    ).toBe(true);
    // Ghi ra ngoài thư mục dữ liệu cũng bị từ chối; ghi trong thư mục dữ liệu thì được.
    const target = join(tempDir(), 'ghi.txt');
    expect((await call('thu_nghiem__write_file', { path: target, text: 'x' })).isError).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect((await call('thu_nghiem__write_data', { text: 'ổn' })).text).toBe('ổn');
    // Không đọc được mã nguồn (thư mục cài) để sửa: chỉ đọc, không ghi.
    expect(
      (
        await call('thu_nghiem__write_file', {
          path: join(s.dir, 'installed', 'thu-nghiem', 'main.js'),
          text: '',
        })
      ).isError,
    ).toBe(true);
    expect(s.audit.entries.some((e) => e.type === 'mcp_tool' && e.ok === false)).toBe(true);
  });

  it('thư mục được cấp thì đọc / ghi đúng quyền, thư mục không được cấp thì không', async () => {
    const s = await setup();
    const { call } = await gatewayFor(s);
    const granted = tempDir('nsa-granted-');
    const other = tempDir('nsa-other-');
    writeFileSync(join(granted, 'a.txt'), 'trong thư mục được cấp');
    writeFileSync(join(other, 'b.txt'), 'ngoài');
    await install(
      s.host,
      writePlugin({
        permissions: {
          ...MANIFEST.permissions,
          folders: [
            { id: 'docs', label: 'Tài liệu', access: 'read' },
            { id: 'out', label: 'Xuất', access: 'readwrite' },
          ],
        },
      }),
      { ...everything, folders: { docs: granted } },
    );
    expect((await call('thu_nghiem__read_file', { path: join(granted, 'a.txt') })).text).toBe(
      'trong thư mục được cấp',
    );
    expect((await call('thu_nghiem__read_file', { path: join(other, 'b.txt') })).isError).toBe(
      true,
    );
    // Quyền "read": không ghi được.
    expect(
      (await call('thu_nghiem__write_file', { path: join(granted, 'n.txt'), text: 'x' })).isError,
    ).toBe(true);
    // Thu hồi quyền → plugin khởi động lại và không đọc được nữa.
    await s.host.updateGrants('thu-nghiem', { ...everything, folders: {} });
    expect((await call('thu_nghiem__read_file', { path: join(granted, 'a.txt') })).isError).toBe(
      true,
    );
  });

  it('mạng: chỉ tên miền đã cấp; tên miền khác, IP và kết nối thô đều bị từ chối', async () => {
    const hits: string[] = [];
    const server: Server = createServer((req, res) => {
      hits.push(`${req.headers.host}${req.url}`);
      res.end('trả lời từ server');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as { port: number }).port;

    const s = await setup();
    const { call } = await gatewayFor(s);
    await install(s.host, writePlugin());

    // Tên miền đã cấp (localhost) → được.
    expect(await call('thu_nghiem__http_get', { url: `http://localhost:${port}/ok` })).toEqual({
      text: '200:trả lời từ server',
      isError: false,
    });
    // Địa chỉ IP, dù cùng máy, không nằm trong danh sách → từ chối, server không nhận được gì.
    const before = hits.length;
    const ip = await call('thu_nghiem__http_get', { url: `http://127.0.0.1:${port}/ip` });
    expect(ip.isError).toBe(true);
    expect(ip.text).toMatch(/chưa được cấp quyền mạng tới "127\.0\.0\.1"/);
    expect(
      (await call('thu_nghiem__http_get', { url: 'https://evil.example.org/x' })).isError,
    ).toBe(true);
    expect(hits.length).toBe(before);
    // Mở socket thô để lách fetch → bị chặn trong tiến trình plugin.
    const raw = await call('thu_nghiem__raw_net', { port });
    expect(raw.text).toMatch(/THROW:ERR_NSA_DENIED/);
    expect(hits.length).toBe(before);
    // Thu hồi quyền mạng → ngay cả localhost cũng không còn.
    await s.host.updateGrants('thu-nghiem', { ...everything, network: [] });
    expect(
      (await call('thu_nghiem__http_get', { url: `http://localhost:${port}/x` })).isError,
    ).toBe(true);
    expect(s.audit.entries.some((e) => e.type === 'plugin' && e.op === 'denied')).toBe(true);
  });

  it('không sinh tiến trình con, không thấy biến môi trường của app (khoá, token)', async () => {
    process.env['NSA_FAKE_API_KEY'] = 'sk-should-not-leak';
    cleanups.push(() => void delete process.env['NSA_FAKE_API_KEY']);
    const s = await setup();
    const { call } = await gatewayFor(s);
    await install(s.host, writePlugin());
    const env = await call('thu_nghiem__env');
    expect(env.text).not.toContain('NSA_FAKE_API_KEY');
    expect(env.text).not.toContain('sk-');
    const spawned = await call('thu_nghiem__spawn');
    expect(spawned.isError).toBe(true);
    expect(spawned.text).toMatch(/ERR_ACCESS_DENIED|restricted/);
  });

  it('thông báo và nhánh nhớ chỉ có khi được cấp quyền; nhánh nhớ chỉ là của plugin', async () => {
    const s = await setup();
    const { call } = await gatewayFor(s);
    await install(s.host, writePlugin(), { ...everything, memory: false, notifications: false });
    expect((await call('thu_nghiem__notify', { title: 'hi' })).text).toMatch(
      /chưa được cấp quyền thông báo/,
    );
    expect((await call('thu_nghiem__remember', { title: 't', body: 'b' })).text).toBe('no-memory');
    expect((await call('thu_nghiem__search', { q: 'x' })).isError).toBe(true);
    await s.host.updateGrants('thu-nghiem', everything);
    expect((await call('thu_nghiem__notify', { title: 'hi' })).text).toBe('sent');
    expect(s.notes).toEqual(['thu-nghiem:hi']);
    expect(
      JSON.parse((await call('thu_nghiem__remember', { title: 't', body: 'b' })).text),
    ).toMatchObject({
      status: 'pending',
    });
    expect(s.proposals).toEqual(['thu-nghiem@plugin/thu-nghiem/ghi-chu:t']);
    expect(JSON.parse((await call('thu_nghiem__search', { q: 'x' })).text)[0].title).toBe(
      'plugin/thu-nghiem/ghi-chu:x',
    );
  });

  it('cấu hình riêng của plugin lưu và đọc lại được', async () => {
    const s = await setup();
    const { call } = await gatewayFor(s);
    await install(s.host, writePlugin());
    expect(JSON.parse((await call('thu_nghiem__config', { v: 7 })).text)).toEqual({ k: 7 });
  });
});

describe('plugin treo / sập không kéo app sập', () => {
  it('tool treo bị ngắt đúng hạn, plugin được khởi động lại, app vẫn chạy', async () => {
    const s = await setup({ toolTimeoutMs: 800 });
    const { call } = await gatewayFor(s);
    await install(s.host, writePlugin());
    const started = Date.now();
    const hung = await call('thu_nghiem__hang');
    expect(hung.isError).toBe(true);
    expect(hung.text).toMatch(/không trả lời/);
    expect(Date.now() - started).toBeLessThan(5000);
    // Lời gọi kế tiếp tự chờ plugin khởi động lại (tối đa vài giây).
    expect((await call('thu_nghiem__echo', { text: 'lại ổn' })).text).toBe('echo:lại ổn:claude');
  });

  it('plugin sập (process.exit) được khởi động lại và ghi nhật ký; sập liên tục thì bị dừng', async () => {
    const s = await setup();
    const { call } = await gatewayFor(s);
    await install(s.host, writePlugin());
    await call('thu_nghiem__crash');
    await waitFor(() => s.audit.entries.some((e) => e.type === 'plugin' && e.op === 'crash'));
    await waitFor(() => s.host.get('thu-nghiem')?.status === 'running');
    expect((await call('thu_nghiem__echo', { text: 'sống lại' })).text).toBe(
      'echo:sống lại:claude',
    );

    // Plugin hỏng ngay khi khởi động → báo lỗi dễ hiểu, không ném ra ngoài.
    const s2 = await setup();
    await install(s2.host, writePlugin({}, 'throw new Error("hỏng lúc nạp");'));
    expect(s2.host.get('thu-nghiem')?.status).toBe('failed');
    expect(s2.host.get('thu-nghiem')?.statusMessage).toMatch(/hỏng lúc nạp|thoát/);
    // Manifest khai tool mà plugin không cài đặt.
    const s3 = await setup();
    await install(s3.host, writePlugin({}, 'export default { tools: {} };'));
    expect(s3.host.get('thu-nghiem')?.statusMessage).toMatch(/không cài đặt/);
  });
});

describe('chính sách', () => {
  it('chính sách trả "chặn" thì tool của plugin KHÔNG chạy', async () => {
    const s = await setup();
    const deny: Policy = {
      check: ({ action }) =>
        action.kind === 'mcp.tool' && action.source === 'plugin'
          ? { decision: 'deny', reason: 'quản trị chặn plugin' }
          : { decision: 'allow' },
    };
    const { call } = await gatewayFor(s, deny);
    await install(s.host, writePlugin());
    const marker = 'CHAY-' + Date.now();
    const result = await call('thu_nghiem__write_data', { text: marker });
    expect(result).toEqual({ text: 'NSA chặn: quản trị chặn plugin', isError: true });
    expect(existsSync(join(s.dir, 'data', 'thu-nghiem', 'x.txt'))).toBe(false);
    const entry = s.audit.entries.find(
      (e): e is Extract<AuditEntry, { type: 'mcp_tool' }> => e.type === 'mcp_tool',
    );
    expect(entry).toMatchObject({
      decision: 'deny',
      source: 'plugin',
      pluginId: 'thu-nghiem',
      tool: 'thu_nghiem__write_data',
    });
    // Chính sách ném lỗi cũng là chặn.
    const boom: Policy = {
      check: () => {
        throw new Error('hỏng');
      },
    };
    const { call: call2 } = await gatewayFor(s, boom);
    expect((await call2('thu_nghiem__write_data', { text: 'x' })).isError).toBe(true);
    expect(existsSync(join(s.dir, 'data', 'thu-nghiem', 'x.txt'))).toBe(false);
  });

  it('thao tác nhạy cảm luôn hỏi người dùng mỗi lần; từ chối thì không chạy', async () => {
    const s = await setup();
    const questions: string[] = [];
    let answer = false;
    const { call } = await gatewayFor(s, personalPolicy(), (async (_ctx: unknown, q: string) => {
      questions.push(q);
      return answer;
    }) as never);
    await install(
      s.host,
      writePlugin({ tools: [{ name: 'write_data', description: 'ghi', sensitive: true }] }),
    );
    expect((await call('thu_nghiem__write_data', { text: 'a' })).text).toMatch(/không cho phép/);
    expect(existsSync(join(s.dir, 'data', 'thu-nghiem', 'x.txt'))).toBe(false);
    answer = true;
    expect((await call('thu_nghiem__write_data', { text: 'b' })).text).toBe('b');
    expect((await call('thu_nghiem__write_data', { text: 'c' })).text).toBe('c');
    expect(questions).toHaveLength(3); // hỏi cả ba lần, không nhớ câu trả lời trước
    expect(questions[0]).toMatch(/nhạy cảm/);
    const logged = s.audit.entries.filter((e) => e.type === 'mcp_tool');
    expect(
      logged.map(
        (e) =>
          (e as { decision: string; confirmed: boolean }).decision +
          ':' +
          (e as { confirmed: boolean }).confirmed,
      ),
    ).toEqual(['deny:false', 'allow:true', 'allow:true']);
  });

  it('việc cài plugin cũng đi qua chính sách: chặn thì không cài', async () => {
    const policy: Policy = {
      check: ({ action }) =>
        action.kind === 'plugin.manage'
          ? { decision: 'deny', reason: 'doanh nghiệp chỉ cho plugin đã duyệt' }
          : { decision: 'allow' },
    };
    const s = await setup({ policy });
    const prepared = s.host.prepareFromDirectory(writePlugin());
    const result = await s.host.install(prepared.prepareId, everything, true);
    expect(result).toEqual({ status: 'denied', reason: 'doanh nghiệp chỉ cho plugin đã duyệt' });
    expect(s.host.list()).toEqual([]);
    expect(existsSync(join(s.dir, 'installed', 'thu-nghiem'))).toBe(false);
  });

  it('plugin chưa ký: chính sách hỏi rồi mới cài (cảnh báo rõ)', async () => {
    const s = await setup();
    const prepared = s.host.prepareFromDirectory(writePlugin());
    expect(prepared.warnings[0]).toMatch(/CHƯA ĐƯỢC KÝ/);
    const first = await s.host.install(prepared.prepareId, everything);
    expect(first).toMatchObject({ status: 'needs_confirmation' });
    expect(s.host.list()).toEqual([]);
    expect((await s.host.install(prepared.prepareId, everything, true)).status).toBe('installed');
  });
});

describe('kho (file chỉ mục)', () => {
  it('liệt kê, cài từ kho, báo có bản mới, kiểm mã băm', async () => {
    const src = writePlugin();
    const key = generateSigningKey();
    const trusted = [{ keyId: key.keyId, name: 'Nhà A', publicKey: key.publicKey }];
    const repo = tempDir('nsa-repo-');
    const bytes = packDirectory(src, { key, publisher: 'Nhà A' });
    writeFileSync(join(repo, 'thu-nghiem-1.0.0.nsapkg'), bytes);
    const { createHash } = await import('node:crypto');
    const index: { plugins: Record<string, unknown>[] } = {
      plugins: [
        {
          id: 'thu-nghiem',
          name: 'Thử nghiệm',
          description: 'x',
          version: '1.0.0',
          icon: 'emoji:🧪',
          nsa: '>=0.1.0',
          package: 'thu-nghiem-1.0.0.nsapkg',
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
        { id: 'cu', name: 'Cần NSA mới', version: '1.0.0', nsa: '>=9.0.0', package: 'x.nsapkg' },
        { hong: true },
      ],
    };
    writeFileSync(join(repo, 'index.json'), JSON.stringify(index));
    const s = await setup({ developerMode: false, trusted });
    s.host.saveSettings({ registry: join(repo, 'index.json') });
    const entries = await s.host.registryEntries();
    expect(entries.map((e) => [e.id, e.compatible, e.updateAvailable])).toEqual([
      ['thu-nghiem', true, false],
      ['cu', false, false],
    ]);
    const prepared = await s.host.prepareFromRegistry('thu-nghiem');
    expect(prepared.signature).toBe('trusted');
    expect((await s.host.install(prepared.prepareId, everything)).status).toBe('installed');

    // Mã băm sai → từ chối.
    index.plugins[0] = { ...index.plugins[0]!, sha256: '0'.repeat(64) };
    writeFileSync(join(repo, 'index.json'), JSON.stringify(index));
    await expect(s.host.prepareFromRegistry('thu-nghiem')).rejects.toThrow(/mã băm/i);
    // Bản mới hơn trong kho → báo cập nhật.
    index.plugins[0] = {
      ...index.plugins[0]!,
      version: '1.2.0',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    writeFileSync(join(repo, 'index.json'), JSON.stringify(index));
    expect((await s.host.registryEntries())[0]).toMatchObject({
      installed: '1.0.0',
      updateAvailable: true,
    });
  });
});
