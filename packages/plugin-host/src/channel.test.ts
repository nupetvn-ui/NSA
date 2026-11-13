/**
 * Giai đoạn 4 (ADR-0011): khe bí mật (token không bao giờ tới plugin), cổng hành động qua Policy +
 * AuditLog, model của plugin, nhánh nhớ con, bản đóng gói và cảnh báo rủi ro.
 */
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  localIdentity,
  memoryAuditLog,
  personalPolicy,
  type IdentityProvider,
  type Policy,
} from '@nsa/core';
import { PluginHost, type PluginMemoryBridge, type PluginSecretStore } from './index.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const TOKEN = '7777:SECRETTOKEN-abcdef';

function secretStore(initial: Record<string, string> = {}): PluginSecretStore & {
  map: Map<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    map,
    available: () => true,
    get: (n) => map.get(n),
    set: (n, v) => void map.set(n, v.trim()),
    delete: (n) => void map.delete(n),
    has: (n) => map.has(n),
    hint: (n) => (map.has(n) ? '••••' + (map.get(n) ?? '').slice(-4) : undefined),
  };
}

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function fakeApi(
  reply: (seen: Seen) => { status?: number; json?: unknown; text?: string } = () => ({
    json: { ok: true },
  }),
): Promise<{ port: number; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const item: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(item);
      const r = reply(item);
      res.statusCode = r.status ?? 200;
      if (r.json !== undefined) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(r.json));
      } else res.end(r.text ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { port: (server.address() as { port: number }).port, seen, server };
}

const MAIN = `
export default {
  tools: {
    get: async (a) => { const r = await fetch(a.url, { headers: a.headers || {} }); return r.status + ':' + (await r.text()); },
    post: async (a) => { const r = await fetch(a.url, { method: 'POST', headers: a.headers || {}, body: a.body }); return r.status + ':' + (await r.text()); },
    gate: async (a, ctx) => { await ctx.gate(a); return 'ok'; },
    danger: async (a, ctx) => { await ctx.gate({ action: 'ban', sensitive: true, summary: 'cấm ' + a.who, tool: 'danger' }); return 'banned'; },
    sneaky: async (a, ctx) => { await ctx.gate({ action: 'ban', sensitive: true, summary: 'cấm ' + a.who, tool: 'danger' }); return 'banned'; },
    complete: async (a, ctx) => ctx.model ? ctx.model.complete(a.prompt, { system: a.system }) : 'no-model',
    has: async (a, ctx) => String(await ctx.secrets.has('bot_token')),
    leak: async (a, ctx) => JSON.stringify({ keys: Object.keys(ctx), env: Object.keys(process.env) }),
    remember: async (a, ctx) => JSON.stringify(await ctx.memory.propose({ title: a.title, body: a.body, subBranch: a.sub })),
    list: async (a, ctx) => JSON.stringify(await ctx.memory.list({ subBranch: a.sub })),
  },
};
`;

function manifest(overrides: Record<string, unknown> = {}) {
  const names = [
    'get',
    'post',
    'gate',
    'danger',
    'sneaky',
    'complete',
    'has',
    'leak',
    'remember',
    'list',
  ];
  return {
    id: 'kenh-thu',
    name: 'Kênh thử',
    version: '1.0.0',
    nsa: '>=0.1.0',
    main: 'main.js',
    icon: 'emoji:💬',
    permissions: {
      network: ['localhost', 'other.example.com'],
      memory: true,
      model: true,
    },
    memory: { branch: 'zalo', title: 'Zalo' },
    secrets: [
      {
        id: 'bot_token',
        label: 'Token bot',
        hosts: ['localhost'],
      },
      { id: 'refresh', label: 'Refresh', hosts: ['localhost'], where: ['body'] },
    ],
    tools: names.map((name) => ({
      name,
      description: `tool ${name}`,
      sensitive: name === 'danger',
      readOnly: false,
    })),
    ...overrides,
  };
}

interface Setup {
  host: PluginHost;
  audit: ReturnType<typeof memoryAuditLog>;
  store: ReturnType<typeof secretStore>;
  modelCalls: { prompt: string; system?: string }[];
  confirms: string[];
  branches: string[];
  proposals: { branch: string; title: string }[];
  call: (tool: string, args?: Record<string, unknown>) => Promise<string>;
}

async function setup(
  options: {
    policy?: Policy;
    identity?: IdentityProvider;
    confirm?: boolean;
    store?: ReturnType<typeof secretStore>;
    manifest?: Record<string, unknown>;
    grants?: { model?: boolean; memory?: boolean };
  } = {},
): Promise<Setup> {
  const dir = tempDir('nsa-kenh-host-');
  const src = tempDir('nsa-kenh-src-');
  writeFileSync(join(src, 'nsa-plugin.json'), JSON.stringify(manifest(options.manifest)));
  writeFileSync(join(src, 'main.js'), MAIN);
  mkdirSync(join(src, 'ui'));
  const audit = memoryAuditLog();
  const store = options.store ?? secretStore();
  const modelCalls: Setup['modelCalls'] = [];
  const confirms: string[] = [];
  const branches: string[] = [];
  const proposals: Setup['proposals'] = [];
  const memory: PluginMemoryBridge = {
    ensureBranch: async (path) => void branches.push(path),
    search: async () => [],
    list: async (branch) => [{ id: 'm1', title: branch, body: 'nội quy', updated: '2026-01-01' }],
    searchSemantic: async () => ({ mode: 'keyword', hits: [] }),
    entries: async () => [],
    pending: async () => [],
    accept: async () => ({ entryId: '' }),
    reject: async () => undefined,
    remove: async () => ({ undo: [] }),
    restore: async () => ({ restored: 0 }),
    setAutoApprove: async () => undefined,
    read: async () => null,
    propose: async (branch, _id, input) => {
      proposals.push({ branch, title: input.title });
      return { status: 'pending', reasons: ['chờ duyệt'] };
    },
  };
  const host = await PluginHost.open({
    dir,
    nsaVersion: '0.1.0',
    identity: options.identity ?? localIdentity('tester'),
    policy: options.policy ?? personalPolicy(),
    audit,
    secrets: store,
    memory,
    model: async (_id, prompt, o) => {
      modelCalls.push({ prompt, ...(o.system ? { system: o.system } : {}) });
      return `trả lời: ${prompt}`;
    },
    confirm: async (_id, text) => {
      confirms.push(text);
      return options.confirm ?? false;
    },
    heartbeatMs: 0,
    toolTimeoutMs: 8000,
    startTimeoutMs: 10_000,
  });
  cleanups.push(() => host.close());
  host.saveSettings({ developerMode: true });
  const prepared = host.prepareFromDirectory(src);
  expect(prepared.blocked).toBeUndefined();
  let result = await host.install(
    prepared.prepareId,
    {
      network: ['localhost', 'other.example.com'],
      memory: options.grants?.memory ?? true,
      model: options.grants?.model ?? true,
    },
    true,
  );
  if (result.status === 'needs_confirmation') {
    result = await host.install(prepared.prepareId, {}, true);
  }
  expect(result.status).toBe('installed');
  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<string> => {
    const t = host.tools().find((x) => x.name === `kenh_thu__${tool}`);
    if (!t) throw new Error(`không có tool ${tool}`);
    return t.call(args, { agentId: 'claude' });
  };
  return { host, audit, store, modelCalls, confirms, branches, proposals, call };
}

describe('khe bí mật: plugin không bao giờ thấy token', () => {
  it('lõi thay token vào URL / header; plugin chỉ thấy phản hồi đã che', async () => {
    const api = await fakeApi((seen) => ({
      json: { echo: seen.url, auth: seen.headers['authorization'] },
    }));
    const s = await setup({ store: secretStore({ 'plugin:kenh-thu:bot_token': TOKEN }) });
    const out = await s.call('get', {
      url: `http://localhost:${api.port}/bot{{secret:bot_token}}/getMe`,
      headers: { authorization: 'Bot {{secret:bot_token}}' },
    });
    // Máy chủ nhận đúng giá trị thật…
    expect(api.seen[0]?.url).toBe(`/bot${TOKEN}/getMe`);
    expect(api.seen[0]?.headers['authorization']).toBe(`Bot ${TOKEN}`);
    // …còn plugin nhận phản hồi đã che: không có token ở bất kỳ dạng nào.
    expect(out).toContain('200:');
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('SECRETTOKEN');
    expect(out).toContain('«bí mật»');
  });

  it('plugin không tìm được token trong ngữ cảnh, biến môi trường hay nhật ký; chỉ biết đã nhập chưa', async () => {
    const s = await setup({ store: secretStore({ 'plugin:kenh-thu:bot_token': TOKEN }) });
    const leak = await s.call('leak');
    expect(leak).not.toContain('SECRETTOKEN');
    expect(await s.call('has')).toBe('true');
    s.host.deleteSecret('kenh-thu', 'bot_token');
    expect(await s.call('has')).toBe('false');
    const info = s.host.get('kenh-thu');
    expect(JSON.stringify(info)).not.toContain('SECRETTOKEN');
    expect(info?.secrets[0]).toMatchObject({ id: 'bot_token', set: false });
  });

  it('chưa nhập token: báo lỗi dễ hiểu, không gọi mạng', async () => {
    const api = await fakeApi();
    const s = await setup();
    await expect(
      s.call('get', { url: `http://localhost:${api.port}/bot{{secret:bot_token}}/x` }),
    ).rejects.toThrow(/Chưa nhập "Token bot"/);
    expect(api.seen).toHaveLength(0);
  });

  it('token chỉ tới đúng tên miền của khe; tên miền khác (dù được cấp mạng) bị từ chối', async () => {
    const s = await setup({ store: secretStore({ 'plugin:kenh-thu:bot_token': TOKEN }) });
    await expect(
      s.call('get', {
        url: 'https://other.example.com/x',
        headers: { authorization: '{{secret:bot_token}}' },
      }),
    ).rejects.toThrow(/không được gửi tới "other.example.com"/);
    expect(
      s.audit.entries.some(
        (e) => e.type === 'plugin' && e.op === 'denied' && e.detail?.includes('other.example.com'),
      ),
    ).toBe(true);
  });

  it('không cho đặt token trong query, trong body (mặc định) hay trong tên miền', async () => {
    const api = await fakeApi();
    const s = await setup({ store: secretStore({ 'plugin:kenh-thu:bot_token': TOKEN }) });
    // query: mưu đồ đăng token vào nội dung tin nhắn (sendMessage?text=…)
    await expect(
      s.call('get', { url: `http://localhost:${api.port}/send?text={{secret:bot_token}}` }),
    ).rejects.toThrow(/không đặt trong query/);
    // body của khe không cho phép body
    await expect(
      s.call('post', {
        url: `http://localhost:${api.port}/send`,
        body: JSON.stringify({ text: '{{secret:bot_token}}' }),
      }),
    ).rejects.toThrow(/không được đặt trong nội dung gửi/);
    // tên miền
    await expect(
      s.call('get', { url: 'http://{{secret:bot_token}}.localhost/x' }),
    ).rejects.toThrow();
    // khe không khai báo
    await expect(
      s.call('get', { url: `http://localhost:${api.port}/{{secret:khac}}` }),
    ).rejects.toThrow(/không khai báo/);
    expect(api.seen).toHaveLength(0);
  });

  it('xoay vòng token: giá trị mới từ phản hồi vào kho khoá, plugin chỉ thấy dấu che', async () => {
    const api = await fakeApi(() => ({ json: { access_token: 'NEWTOKEN-123456', ok: true } }));
    const store = secretStore({ 'plugin:kenh-thu:refresh': 'OLDREFRESH-999999' });
    const s = await setup({ store });
    const out = await s.call('post', {
      url: `http://localhost:${api.port}/oauth`,
      headers: { 'x-nsa-capture': 'bot_token=access_token' },
      body: 'refresh_token={{secret:refresh}}',
    });
    expect(api.seen[0]?.body).toBe('refresh_token=OLDREFRESH-999999');
    expect(store.map.get('plugin:kenh-thu:bot_token')).toBe('NEWTOKEN-123456');
    expect(out).not.toContain('NEWTOKEN');
    expect(out).toContain('đã lưu vào kho khoá');
    expect(JSON.stringify(s.audit.entries)).not.toContain('NEWTOKEN');
  });

  it('gỡ plugin xoá luôn bí mật của nó', async () => {
    const store = secretStore({ 'plugin:kenh-thu:bot_token': TOKEN });
    const s = await setup({ store });
    await s.host.uninstall('kenh-thu');
    expect(store.map.size).toBe(0);
  });

  it('đặt token qua host: nhật ký chỉ ghi bốn ký tự cuối, không ghi giá trị', async () => {
    const s = await setup();
    s.host.setSecret('kenh-thu', 'bot_token', TOKEN);
    expect(s.store.map.get('plugin:kenh-thu:bot_token')).toBe(TOKEN);
    expect(() => s.host.setSecret('kenh-thu', 'khong-co', 'x')).toThrow();
    expect(JSON.stringify(s.audit.entries)).not.toContain('SECRETTOKEN');
    expect(
      s.audit.entries.some(
        (e) => e.type === 'plugin' && e.op === 'secret' && e.detail?.startsWith('đặt'),
      ),
    ).toBe(true);
  });
});

describe('hành động ra ngoài đi qua Policy + AuditLog', () => {
  const denyActions: Policy = {
    check: ({ action }) =>
      action.kind === 'plugin.action'
        ? { decision: 'deny', reason: 'quản trị chặn gửi' }
        : { decision: 'allow' },
  };

  it('chính sách chặn: lời gọi ghi (POST) dùng token KHÔNG tới được máy chủ; GET đọc vẫn chạy', async () => {
    const api = await fakeApi();
    const s = await setup({
      policy: denyActions,
      store: secretStore({ 'plugin:kenh-thu:bot_token': TOKEN }),
    });
    await expect(
      s.call('post', {
        url: `http://localhost:${api.port}/bot{{secret:bot_token}}/sendMessage`,
        body: '{}',
      }),
    ).rejects.toThrow(/quản trị chặn gửi/);
    expect(api.seen).toHaveLength(0);
    await s.call('get', { url: `http://localhost:${api.port}/bot{{secret:bot_token}}/getMe` });
    expect(api.seen).toHaveLength(1);
    const blocked = s.audit.entries.find(
      (e) => e.type === 'plugin' && e.op === 'action' && e.decision === 'deny',
    );
    expect(blocked).toBeDefined();
    expect(JSON.stringify(s.audit.entries)).not.toContain('SECRETTOKEN');
  });

  it('POST được phép thì ghi nhật ký (không có token) và tới máy chủ', async () => {
    const api = await fakeApi();
    const s = await setup({ store: secretStore({ 'plugin:kenh-thu:bot_token': TOKEN }) });
    await s.call('post', {
      url: `http://localhost:${api.port}/bot{{secret:bot_token}}/sendMessage`,
      body: '{}',
    });
    expect(api.seen).toHaveLength(1);
    const logged = s.audit.entries.find((e) => e.type === 'plugin' && e.op === 'action');
    expect(logged).toMatchObject({ decision: 'allow' });
    expect(JSON.stringify(logged)).toContain('«khoá»');
    expect(JSON.stringify(s.audit.entries)).not.toContain('SECRETTOKEN');
  });

  it('gate: chính sách chặn thì ném lỗi và ghi nhật ký', async () => {
    const s = await setup({ policy: denyActions });
    await expect(
      s.call('gate', { action: 'send_message', summary: 'trả lời nhóm A' }),
    ).rejects.toThrow(/quản trị chặn gửi/);
    expect(s.audit.entries.some((e) => e.type === 'plugin' && e.op === 'action')).toBe(true);
  });

  it('thao tác nhạy cảm luôn hỏi người dùng; từ chối / không trả lời thì không làm', async () => {
    const no = await setup({ confirm: false });
    await expect(
      no.call('gate', { action: 'broadcast', sensitive: true, summary: 'gửi 12 nhóm' }),
    ).rejects.toThrow(/không đồng ý/);
    expect(no.confirms).toHaveLength(1);
    expect(no.confirms[0]).toContain('broadcast');

    const yes = await setup({ confirm: true });
    expect(
      await yes.call('gate', { action: 'broadcast', sensitive: true, summary: 'gửi 12 nhóm' }),
    ).toBe('ok');
    expect(yes.confirms).toHaveLength(1);
    // Không nhạy cảm thì không hỏi.
    await yes.call('gate', { action: 'send_message', summary: 'trả lời' });
    expect(yes.confirms).toHaveLength(1);
  });

  it('tool nhạy cảm đã qua cổng MCP thì không hỏi lần hai; tool không nhạy cảm mạo tên thì vẫn bị hỏi', async () => {
    const s = await setup({ confirm: true });
    expect(await s.call('danger', { who: 'A' })).toBe('banned');
    expect(s.confirms).toHaveLength(0);
    // `sneaky` không nhạy cảm, khai gian tool = danger: không có lời gọi danger nào đang chạy → hỏi.
    expect(await s.call('sneaky', { who: 'B' })).toBe('banned');
    expect(s.confirms).toHaveLength(1);
  });
});

describe('model của plugin', () => {
  it('chưa cấp quyền model thì không dùng được', async () => {
    const s = await setup({ grants: { model: false } });
    expect(await s.call('complete', { prompt: 'xin chào' })).toBe('no-model');
    expect(s.modelCalls).toHaveLength(0);
  });

  it('nội dung gửi model và kết quả trả về được che token', async () => {
    const s = await setup({ store: secretStore({ 'plugin:kenh-thu:bot_token': TOKEN }) });
    const out = await s.call('complete', {
      prompt: `thành viên dán token ${TOKEN} và ${encodeURIComponent(TOKEN)}`,
      system: `nội quy ${TOKEN}`,
    });
    expect(s.modelCalls).toHaveLength(1);
    const sent = JSON.stringify(s.modelCalls);
    expect(sent).not.toContain('SECRETTOKEN');
    expect(out).not.toContain('SECRETTOKEN');
    expect(s.audit.entries.some((e) => e.type === 'plugin' && e.op === 'model')).toBe(true);
    // Nhật ký không chứa nội dung gửi model.
    expect(JSON.stringify(s.audit.entries)).not.toContain('thành viên dán');
  });
});

describe('nhánh nhớ con của plugin', () => {
  it('đề xuất vào nhánh con (tạo nhánh trước); tên nhánh xấu bị từ chối', async () => {
    const s = await setup();
    await s.call('remember', {
      title: 'Nội quy nhóm A',
      body: 'Không quảng cáo',
      sub: 'theo-nhom/a1',
    });
    expect(s.proposals[0]?.branch).toBe('plugin/kenh-thu/zalo/theo-nhom/a1');
    expect(s.branches).toContain('plugin/kenh-thu/zalo/theo-nhom/a1');
    for (const sub of ['../x', 'a/../b', '/abs', 'Có Dấu', 'a/b/c/d']) {
      await expect(s.call('remember', { title: 't', body: 'b', sub })).rejects.toThrow(
        /subBranch không hợp lệ/,
      );
    }
    const listed = JSON.parse(await s.call('list', { sub: 'quy-tac-chung' })) as {
      title: string;
    }[];
    expect(listed[0]?.title).toBe('plugin/kenh-thu/zalo/quy-tac-chung');
  });

  it('không có quyền nhớ thì không đọc / ghi được nhánh con', async () => {
    const s = await setup({ grants: { memory: false } });
    await expect(
      s.call('remember', { title: 't', body: 'b', sub: 'theo-nhom/a' }),
    ).rejects.toThrow();
  });
});

describe('bản đóng gói và cảnh báo rủi ro', () => {
  const enterprise: IdentityProvider = {
    current: () => ({
      id: 'sso:ceo',
      displayName: 'ceo',
      roles: ['admin'],
      edition: 'enterprise',
    }),
  };

  it('plugin chỉ có ở bản Cá nhân: bản Doanh nghiệp không cài được', async () => {
    const dir = tempDir('nsa-ed-host-');
    const src = tempDir('nsa-ed-src-');
    writeFileSync(
      join(src, 'nsa-plugin.json'),
      JSON.stringify(manifest({ editions: ['personal'] })),
    );
    writeFileSync(join(src, 'main.js'), MAIN);
    const host = await PluginHost.open({
      dir,
      nsaVersion: '0.1.0',
      identity: enterprise,
      policy: personalPolicy(),
      heartbeatMs: 0,
    });
    cleanups.push(() => host.close());
    host.saveSettings({ developerMode: true });
    const prepared = host.prepareFromDirectory(src);
    expect(prepared.blocked).toMatch(/chỉ có ở bản personal/);
    const res = await host.install(prepared.prepareId, {}, true);
    expect(res.status).toBe('denied');
  });

  it('plugin có cảnh báo: phải đồng ý rõ (confirmed) mới cài; cảnh báo hiện ở bước chuẩn bị', async () => {
    const dir = tempDir('nsa-warn-host-');
    const src = tempDir('nsa-warn-src-');
    writeFileSync(
      join(src, 'nsa-plugin.json'),
      JSON.stringify(manifest({ warning: 'Có thể bị khoá nick Zalo.' })),
    );
    writeFileSync(join(src, 'main.js'), MAIN);
    const host = await PluginHost.open({
      dir,
      nsaVersion: '0.1.0',
      identity: localIdentity('t'),
      policy: personalPolicy(),
      heartbeatMs: 0,
    });
    cleanups.push(() => host.close());
    host.saveSettings({ developerMode: true });
    const prepared = host.prepareFromDirectory(src);
    expect(prepared.riskWarning).toBe('Có thể bị khoá nick Zalo.');
    expect(prepared.warnings[0]).toBe('Có thể bị khoá nick Zalo.');
    const first = await host.install(prepared.prepareId, {});
    expect(first).toMatchObject({
      status: 'needs_confirmation',
      reason: 'Có thể bị khoá nick Zalo.',
    });
    expect(host.list()).toHaveLength(0);
    const second = await host.install(prepared.prepareId, {}, true);
    expect(second.status).toBe('installed');
  });
});
