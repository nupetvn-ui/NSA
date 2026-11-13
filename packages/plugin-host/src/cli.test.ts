/**
 * Quyền `cli` (ADR-0012): plugin nhờ lõi chạy chương trình dòng lệnh. Chương trình ở đây là một
 * script Node giả ghi lại tham số + biến môi trường nó nhận được.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localIdentity, memoryAuditLog, personalPolicy, type Policy } from '@nsa/core';
import { PluginHost, defaultResolver, matchAllow, minimalEnv, validateArgs } from './index.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const FAKE = `
const fs = require('node:fs');
const log = process.argv[2];
const args = process.argv.slice(3);
fs.appendFileSync(log, JSON.stringify({ args, env: Object.keys(process.env), cwd: process.cwd() }) + '\\n');
if (args.includes('exit2')) { console.error('auth error'); process.exit(2); }
if (args.includes('hang')) setInterval(() => {}, 1000);
else console.log(JSON.stringify({ ok: true, args }));
`;

const MAIN = `
export default {
  tools: {
    run: async (a, ctx) => JSON.stringify(await ctx.cli.run('fake', a.args, { tool: a.tool, timeoutMs: a.timeoutMs })),
    has_cli: async (a, ctx) => String(ctx.cli !== null),
    spawn: async () => { const cp = await import('node:child_process'); return cp.execSync('echo hi').toString(); },
  },
};
`;

function manifest(
  overrides: Record<string, unknown> = {},
  cliOverrides: Record<string, unknown> = {},
) {
  return {
    id: 'cli-thu',
    name: 'CLI thử',
    version: '1.0.0',
    nsa: '>=0.1.0',
    main: 'main.js',
    icon: 'emoji:🛠',
    permissions: {
      cli: [
        {
          id: 'fake',
          label: 'Chương trình giả',
          command: 'fakecli',
          install: 'Cài fakecli từ example.com.',
          allow: ['drive files list', { args: 'gmail +send', sensitive: true }, 'drive files get'],
          denyFlags: ['--output', '-o', '--upload'],
          ...cliOverrides,
        },
      ],
    },
    tools: ['run', 'has_cli', 'spawn'].map((name) => ({
      name,
      description: `tool ${name}`,
      sensitive: false,
      readOnly: false,
    })),
    ...overrides,
  };
}

async function setup(
  options: {
    policy?: Policy;
    confirm?: boolean;
    grant?: boolean;
    missing?: boolean;
    manifest?: Record<string, unknown>;
  } = {},
) {
  const dir = tempDir('nsa-cli-host-');
  const src = tempDir('nsa-cli-src-');
  const work = tempDir('nsa-cli-bin-');
  const logFile = join(work, 'calls.log');
  writeFileSync(join(work, 'fake.js'), FAKE);
  writeFileSync(join(src, 'nsa-plugin.json'), JSON.stringify(manifest(options.manifest)));
  writeFileSync(join(src, 'main.js'), MAIN);
  mkdirSync(join(src, 'ui'));
  const audit = memoryAuditLog();
  const confirms: string[] = [];
  process.env['NSA_TEST_SECRET'] = 'LEAK-ME-12345';
  cleanups.push(() => void delete process.env['NSA_TEST_SECRET']);
  const host = await PluginHost.open({
    dir,
    nsaVersion: '0.1.0',
    identity: localIdentity('tester'),
    policy: options.policy ?? personalPolicy(),
    audit,
    cliResolver: (command) =>
      options.missing
        ? { error: `Máy chưa có chương trình "${command}" trong PATH.` }
        : { file: process.execPath, prefixArgs: [join(work, 'fake.js'), logFile] },
    confirm: async (_id, text) => {
      confirms.push(text);
      return options.confirm ?? false;
    },
    heartbeatMs: 0,
    toolTimeoutMs: 15_000,
    startTimeoutMs: 10_000,
  });
  cleanups.push(() => host.close());
  host.saveSettings({ developerMode: true });
  const prepared = host.prepareFromDirectory(src);
  expect(prepared.blocked).toBeUndefined();
  const res = await host.install(
    prepared.prepareId,
    { cli: options.grant === false ? [] : ['fake'] },
    true,
  );
  expect(res.status).toBe('installed');
  const call = async (args: string[], extra: Record<string, unknown> = {}) => {
    const t = host.tools().find((x) => x.name === 'cli_thu__run');
    if (!t) throw new Error('không có tool');
    return JSON.parse(await t.call({ args, ...extra }, { agentId: 'claude' })) as {
      code: number | null;
      stdout: string;
      stderr: string;
      error?: string;
    };
  };
  const calls = (): { args: string[]; env: string[]; cwd: string }[] =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { args: string[]; env: string[]; cwd: string })
      : [];
  return { host, audit, confirms, call, calls, dir };
}

describe('hàm thuần của quyền cli', () => {
  it('matchAllow: khớp từng từ ở đầu dòng lệnh, lấy mục dài nhất', () => {
    const allow = [
      { args: ['drive', 'files', 'list'], sensitive: false },
      { args: ['drive', 'files'], sensitive: true },
    ];
    expect(matchAllow(allow, ['drive', 'files', 'list', '--params={}'])?.sensitive).toBe(false);
    expect(matchAllow(allow, ['drive', 'files', 'delete'])?.sensitive).toBe(true);
    expect(matchAllow(allow, ['drive'])).toBeNull();
    expect(matchAllow(allow, ['gmail', 'users'])).toBeNull();
    expect(matchAllow(allow, ['drive', 'filesx', 'list'])).toBeNull();
  });

  it('validateArgs: cấm cờ trong denyFlags (cả dạng --cờ=giá trị), NUL, quá dài, sai kiểu', () => {
    expect(validateArgs(['a', '--output', 'x'], ['--output'])).toMatch(/bị cấm/);
    expect(validateArgs(['a', '--output=C:/x'], ['--output'])).toMatch(/bị cấm/);
    expect(validateArgs(['a', '-o'], ['-o'])).toMatch(/bị cấm/);
    expect(validateArgs(['a', '--body=--output'], ['--output'])).toBeNull(); // chỉ là giá trị chữ
    expect(validateArgs(['a\0b'], [])).toMatch(/NUL/);
    expect(validateArgs(['x'.repeat(40_000)], [])).toMatch(/dài quá/);
    expect(validateArgs([1], [])).toMatch(/chuỗi/);
    expect(validateArgs([], [])).toMatch(/Thiếu/);
  });

  it('minimalEnv: chỉ giữ biến chương trình cần, bỏ mọi biến khác (khoá, token…)', () => {
    const env = minimalEnv({
      PATH: '/bin',
      USERPROFILE: 'C:/Users/x',
      GOOGLE_WORKSPACE_CLI_TOKEN: 't',
      ANTHROPIC_API_KEY: 'sk-secret',
      NSA_TEST_SECRET: 'x',
      Path: 'C:/win',
    });
    expect(Object.keys(env).sort()).toEqual(
      ['GOOGLE_WORKSPACE_CLI_TOKEN', 'Path', 'PATH', 'USERPROFILE'].sort(),
    );
  });

  it('defaultResolver: không có trong PATH thì báo cách xử lý, không ném lỗi', () => {
    const r = defaultResolver('chuong-trinh-khong-ton-tai-xyz', { PATH: tmpdir() });
    expect('error' in r && r.error).toMatch(/chưa có chương trình/);
  });
});

describe('plugin nhờ lõi chạy chương trình', () => {
  it('đã cấp + lệnh nằm trong danh sách: chạy, không qua shell, môi trường tối thiểu', async () => {
    const s = await setup();
    const r = await s.call([
      'drive',
      'files',
      'list',
      '--params={"pageSize":5}',
      '; echo hacked && calc',
    ]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true });
    const [seen] = s.calls();
    // Chuỗi có ký tự shell chỉ là một tham số chữ.
    expect(seen?.args).toEqual([
      'drive',
      'files',
      'list',
      '--params={"pageSize":5}',
      '; echo hacked && calc',
    ]);
    // Không thừa kế biến của app.
    expect(seen?.env).not.toContain('NSA_TEST_SECRET');
    expect(seen?.env.some((k) => /key|token|secret/i.test(k))).toBe(false);
    // Thư mục chạy là thư mục tạm, không phải thư mục dữ liệu / cài đặt của plugin.
    expect(seen?.cwd.toLowerCase()).toContain(tmpdir().toLowerCase().slice(0, 8));
    // Mỗi lần chạy có dấu vết trong nhật ký, không kèm nội dung tham số.
    const logged = s.audit.entries.find(
      (e) => e.type === 'plugin' && e.op === 'action' && e.detail?.includes('cli.fake'),
    );
    expect(logged).toMatchObject({ decision: 'allow' });
    expect(JSON.stringify(logged)).toContain('fakecli drive files list');
    expect(JSON.stringify(s.audit.entries)).not.toContain('pageSize');
  });

  it('chưa cấp quyền: bị từ chối, chương trình không chạy; tool ctx.cli = null', async () => {
    const s = await setup({ grant: false });
    const t = s.host.tools().find((x) => x.name === 'cli_thu__has_cli');
    expect(await t?.call({}, { agentId: 'a' })).toBe('false');
    await expect(s.call(['drive', 'files', 'list'])).rejects.toThrow();
    expect(s.calls()).toHaveLength(0);
  });

  it('lệnh ngoài danh sách đã khai bị từ chối và ghi nhật ký', async () => {
    const s = await setup();
    await expect(s.call(['drive', 'files', 'delete', '--params={}'])).rejects.toThrow(
      /ngoài danh sách/,
    );
    await expect(s.call(['auth', 'export', '--unmasked'])).rejects.toThrow(/ngoài danh sách/);
    await expect(s.call(['drive'])).rejects.toThrow(/ngoài danh sách/);
    expect(s.calls()).toHaveLength(0);
    expect(
      s.audit.entries.some(
        (e) => e.type === 'plugin' && e.op === 'denied' && e.decision === 'deny',
      ),
    ).toBe(true);
  });

  it('cờ bị cấm (ghi file ra đường dẫn tuỳ ý, tải file lên) không chạy được', async () => {
    const s = await setup();
    await expect(s.call(['drive', 'files', 'get', '--output', 'C:/Windows/x'])).rejects.toThrow(
      /bị cấm/,
    );
    await expect(s.call(['drive', 'files', 'get', '--upload=C:/secret.txt'])).rejects.toThrow(
      /bị cấm/,
    );
    expect(s.calls()).toHaveLength(0);
  });

  it('chính sách chặn: không chạy', async () => {
    const deny: Policy = {
      check: ({ action }) =>
        action.kind === 'plugin.action'
          ? { decision: 'deny', reason: 'quản trị chặn' }
          : { decision: 'allow' },
    };
    const s = await setup({ policy: deny });
    await expect(s.call(['drive', 'files', 'list'])).rejects.toThrow(/quản trị chặn/);
    expect(s.calls()).toHaveLength(0);
  });

  it('lệnh nhạy cảm luôn hỏi: từ chối thì không chạy, đồng ý thì chạy', async () => {
    const no = await setup({ confirm: false });
    await expect(no.call(['gmail', '+send', '--to=a@b.c'])).rejects.toThrow(/không đồng ý/);
    expect(no.calls()).toHaveLength(0);
    expect(no.confirms[0]).toContain('gmail +send');
    const yes = await setup({ confirm: true });
    expect((await yes.call(['gmail', '+send', '--to=a@b.c'])).code).toBe(0);
    expect(yes.calls()).toHaveLength(1);
    // Lệnh thường không hỏi.
    await yes.call(['drive', 'files', 'list']);
    expect(yes.confirms).toHaveLength(1);
  });

  it('mã thoát khác 0 được trả lại nguyên vẹn; chưa cài chương trình thì báo cách cài', async () => {
    const s = await setup();
    const r = await s.call(['drive', 'files', 'list', 'exit2']);
    expect(r).toMatchObject({ code: 2 });
    expect(r.stderr).toContain('auth error');
    const missing = await setup({ missing: true });
    const m = await missing.call(['drive', 'files', 'list']);
    expect(m.code).toBeNull();
    expect(m.error).toMatch(/chưa có chương trình "fakecli"/);
    expect(m.error).toContain('Cài fakecli từ example.com.');
  });

  it('chương trình treo bị giết đúng hạn', async () => {
    const s = await setup();
    const r = await s.call(['drive', 'files', 'list', 'hang'], { timeoutMs: 1000 });
    expect(r.code).toBeNull();
    expect(r.error).toMatch(/Hết giờ/);
  }, 30_000);

  it('plugin vẫn không tự sinh được tiến trình con (cô lập ADR-0010 không đổi)', async () => {
    const s = await setup();
    const t = s.host.tools().find((x) => x.name === 'cli_thu__spawn');
    await expect(t?.call({}, { agentId: 'a' })).rejects.toThrow();
  });

  it('manifest: command có đường dẫn, allow rỗng hoặc từ lạ bị báo lỗi tiếng Việt', async () => {
    const { validateManifest } = await import('@nsa/plugin-sdk');
    const bad = (cli: Record<string, unknown>) =>
      validateManifest({
        ...manifest(),
        permissions: { cli: [{ ...manifest().permissions.cli[0], ...cli }] },
      });
    expect(bad({ command: 'C:/x/gws.exe' }).ok).toBe(false);
    expect(bad({ command: '../gws' }).ok).toBe(false);
    expect(bad({ allow: [] }).ok).toBe(false);
    expect(bad({ allow: ['drive; calc'] }).ok).toBe(false);
    expect(bad({ denyFlags: ['output'] }).ok).toBe(false);
    expect(bad({}).ok).toBe(true);
  });
});
