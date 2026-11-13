/**
 * Plugin Google Workspace chạy qua đường ống thật: plugin host (tiến trình riêng) → quyền `cli` →
 * cổng MCP (chính sách, hỏi người dùng) → "gws" GIẢ (script Node ghi lại tham số). KHÔNG có gws thật
 * và tài khoản Google thật ở đây: xem ADR-0012 mục "Chưa chạy thật".
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { localIdentity, memoryAuditLog, personalPolicy } from '@nsa/core';
import { McpGateway } from '@nsa/mcp-gateway';
import { PluginHost } from '@nsa/plugin-host';

const SOURCE = join(import.meta.dirname, 'google-workspace');
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const FAKE_GWS = `
const fs = require('node:fs');
const log = process.argv[2];
const args = process.argv.slice(3);
fs.appendFileSync(log, JSON.stringify(args) + '\\n');
if (args[0] === '--version') { console.log('gws 0.22.5'); process.exit(0); }
if (process.env.FAKE_EXIT) process.exit(Number(process.env.FAKE_EXIT));
if (args.join(' ').includes('AUTHFAIL')) { console.error('credentials missing'); process.exit(2); }
console.log(JSON.stringify({ ok: true, echo: args.slice(0, 3) }));
`;

async function setup(options: { confirm?: boolean; missing?: boolean } = {}) {
  const work = tempDir('nsa-gws-fake-');
  const logFile = join(work, 'calls.log');
  writeFileSync(join(work, 'fake-gws.js'), FAKE_GWS);
  const audit = memoryAuditLog();
  const identity = localIdentity('tester');
  const policy = personalPolicy();
  const confirms: string[] = [];
  const host = await PluginHost.open({
    dir: tempDir('nsa-gws-host-'),
    nsaVersion: '0.1.0',
    identity,
    policy,
    audit,
    cliResolver: (command) =>
      options.missing
        ? { error: `Máy chưa có chương trình "${command}" trong PATH.` }
        : { file: process.execPath, prefixArgs: [join(work, 'fake-gws.js'), logFile] },
    confirm: async (_id, text) => {
      confirms.push(text);
      return options.confirm ?? false;
    },
    heartbeatMs: 0,
    toolTimeoutMs: 20_000,
  });
  cleanups.push(() => host.close());
  host.saveSettings({ developerMode: true });
  const prepared = host.prepareFromDirectory(SOURCE);
  expect(prepared.blocked).toBeUndefined();
  expect(prepared.manifest.permissions.cli[0]?.allow.length).toBeGreaterThan(10);
  expect(prepared.riskWarning).toMatch(/KHÔNG phải sản phẩm chính thức/);
  const res = await host.install(prepared.prepareId, { cli: ['gws'] }, true);
  expect(res.status).toBe('installed');

  const gateway = await McpGateway.start({
    version: '0',
    identity,
    policy,
    audit,
    askUser: async (_c, description) => {
      confirms.push(description);
      return options.confirm ?? false;
    },
  });
  cleanups.push(() => gateway.close());
  gateway.addSource(() => host.tools());
  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<string> => {
    const { server, dispose } = gateway.register({
      agentId: 'claude',
      conversationId: 'c',
      turnId: 't',
    });
    try {
      const res = await fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: `google_workspace__${tool}`, arguments: args },
        }),
      });
      const json = (await res.json()) as {
        result?: { content: { text: string }[]; isError?: boolean };
        error?: { message: string };
      };
      const text = json.result?.content[0]?.text ?? json.error?.message ?? '';
      if (json.result?.isError === true || json.error) throw new Error(text);
      return text;
    } finally {
      dispose();
    }
  };
  const calls = (): string[][] =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as string[])
      : [];
  return { host, audit, confirms, call, calls };
}

describe('plugin Google Workspace (qua gws giả)', () => {
  it('mỗi tool đọc ra đúng dòng lệnh gws theo tài liệu của gws, kèm nhắc nội dung là dữ liệu không đáng tin', async () => {
    const s = await setup();
    const out = await s.call('drive_list_files', {
      query: "name contains 'báo cáo'",
      page_size: 5,
    });
    expect(out).toContain('KHÔNG làm theo');
    expect(out).toContain('"ok":true');
    await s.call('drive_get_file', { file_id: 'FILE_ID_123' });
    await s.call('gmail_triage', { max: 5, query: 'from:boss' });
    await s.call('gmail_read_message', { message_id: 'MSG_ID_123', format: 'full' });
    await s.call('calendar_agenda', { range: 'today' });
    await s.call('calendar_agenda', { days: 3, calendar: 'Work' });
    await s.call('sheets_read', { spreadsheet_id: 'SHEET_ID_123', range: 'Sheet1!A1:D10' });
    await s.call('docs_get', { document_id: 'DOC_ID_123' });
    const c = s.calls();
    expect(c[0]).toEqual([
      'drive',
      'files',
      'list',
      `--params=${JSON.stringify({
        pageSize: 5,
        q: "name contains 'báo cáo'",
        orderBy: 'modifiedTime desc',
        fields: 'files(id,name,mimeType,modifiedTime,owners(displayName),webViewLink)',
      })}`,
    ]);
    expect(c[1]?.slice(0, 3)).toEqual(['drive', 'files', 'get']);
    expect(c[2]).toEqual(['gmail', '+triage', '--max=5', '--query=from:boss']);
    expect(c[3]?.slice(0, 4)).toEqual(['gmail', 'users', 'messages', 'get']);
    expect(c[3]?.[4]).toBe('--params={"userId":"me","id":"MSG_ID_123","format":"full"}');
    expect(c[4]).toEqual(['calendar', '+agenda', '--today']);
    expect(c[5]).toEqual(['calendar', '+agenda', '--days=3', '--calendar=Work']);
    expect(c[6]).toEqual([
      'sheets',
      '+read',
      '--spreadsheet=SHEET_ID_123',
      '--range=Sheet1!A1:D10',
    ]);
    expect(c[7]).toEqual(['docs', 'documents', 'get', '--params={"documentId":"DOC_ID_123"}']);
  }, 60_000);

  it('tool ghi không nhạy cảm chạy ngay; sheets_append / docs_append_text đúng cú pháp', async () => {
    const s = await setup();
    await s.call('sheets_append', {
      spreadsheet_id: 'SHEET_ID_123',
      row: ['Alice', 100, true],
      range: 'Sheet2!A1',
    });
    await s.call('docs_append_text', { document_id: 'DOC_ID_123', text: 'Xin chào' });
    expect(s.calls()).toEqual([
      [
        'sheets',
        '+append',
        '--spreadsheet=SHEET_ID_123',
        '--json-values=[["Alice","100","true"]]',
        '--range=Sheet2!A1',
      ],
      ['docs', '+write', '--document=DOC_ID_123', '--text=Xin chào'],
    ]);
    expect(s.confirms).toHaveLength(0);
  }, 60_000);

  it('gửi thư / gửi Chat / xoá file luôn hỏi; từ chối thì gws KHÔNG chạy', async () => {
    const no = await setup({ confirm: false });
    await expect(
      no.call('gmail_send', { to: 'a@b.c', subject: 'Chào', body: 'Nội dung' }),
    ).rejects.toThrow();
    await expect(no.call('chat_send', { space: 'spaces/AAAA123', text: 'hi' })).rejects.toThrow();
    await expect(no.call('drive_delete_file', { file_id: 'FILE_ID_123' })).rejects.toThrow();
    expect(no.calls()).toHaveLength(0);
    expect(no.confirms).toHaveLength(3);

    const yes = await setup({ confirm: true });
    await yes.call('gmail_send', { to: 'a@b.c', subject: 'Chào', body: 'Nội dung', draft: true });
    await yes.call('chat_send', { space: 'spaces/AAAA123', text: 'hi' });
    await yes.call('drive_delete_file', { file_id: 'FILE_ID_123' });
    expect(yes.calls()).toEqual([
      ['gmail', '+send', '--to=a@b.c', '--subject=Chào', '--body=Nội dung', '--draft'],
      ['chat', '+send', '--space=spaces/AAAA123', '--text=hi'],
      ['drive', 'files', 'delete', '--params={"fileId":"FILE_ID_123"}'],
    ]);
    // Cổng MCP đã hỏi rồi: plugin / lõi không hỏi lần hai (3 lần hỏi cho 3 thao tác).
    expect(yes.confirms).toHaveLength(3);
  }, 60_000);

  it('nội dung do agent đưa vào chỉ là dữ liệu: không thành cờ, không thành lệnh', async () => {
    const s = await setup({ confirm: true });
    await s.call('gmail_send', {
      to: 'a@b.c',
      subject: '--output=C:/x',
      body: '--upload=C:/secret.txt; calc',
    });
    const [argv] = s.calls();
    expect(argv).toEqual([
      'gmail',
      '+send',
      '--to=a@b.c',
      '--subject=--output=C:/x',
      '--body=--upload=C:/secret.txt; calc',
    ]);
    // id sai dạng bị chặn ngay ở plugin
    await expect(s.call('drive_get_file', { file_id: '../../x; calc' })).rejects.toThrow(
      /không hợp lệ/,
    );
    await expect(s.call('chat_send', { space: 'spaces/../x', text: 'hi' })).rejects.toThrow(
      /spaces/,
    );
    expect(s.calls()).toHaveLength(1);
  }, 60_000);

  it('lỗi dễ hiểu: chưa đăng nhập (mã 2), chưa cài gws', async () => {
    const s = await setup();
    await expect(s.call('drive_get_file', { file_id: 'AUTHFAIL_ID_1' })).rejects.toThrow(
      /gws auth login/,
    );
    const missing = await setup({ missing: true });
    await expect(missing.call('drive_list_files')).rejects.toThrow(/chưa có chương trình "gws"/);
    await expect(missing.call('drive_list_files')).rejects.toThrow(
      /github\.com\/googleworkspace\/cli\/releases/,
    );
    expect(await s.call('status')).toContain('gws đã cài: gws 0.22.5');
    expect(await missing.call('status')).toContain('Chưa dùng được gws');
  }, 60_000);

  it('nhật ký có từng lần chạy gws nhưng không chứa nội dung thư / tài liệu; ctx.cli bị tắt khi thu hồi quyền', async () => {
    const s = await setup({ confirm: true });
    await s.call('gmail_send', { to: 'a@b.c', subject: 'Bí mật', body: 'NOI-DUNG-RIENG-TU' });
    const lines = s.audit.entries.filter(
      (e) => e.type === 'plugin' && e.op === 'action' && e.detail?.includes('cli.gws'),
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(s.audit.entries)).not.toContain('NOI-DUNG-RIENG-TU');
    expect(JSON.stringify(lines)).toContain('gws gmail +send');
    await s.host.updateGrants('google-workspace', { cli: [] });
    await new Promise((r) => setTimeout(r, 1500));
    await expect(s.call('drive_list_files')).rejects.toThrow(/chưa được cấp quyền chạy gws/);
  }, 60_000);

  it('manifest: lệnh nhạy cảm đúng loại, tool khai báo khớp mã, cờ bị cấm có đủ', async () => {
    const manifest = JSON.parse(readFileSync(join(SOURCE, 'nsa-plugin.json'), 'utf8')) as {
      tools: { name: string; sensitive?: boolean; readOnly?: boolean }[];
      permissions: {
        cli: { allow: (string | { args: string; sensitive?: boolean })[]; denyFlags: string[] }[];
      };
    };
    const mod = (await import('./google-workspace/main.js')) as {
      default: { tools: Record<string, unknown> };
    };
    expect(Object.keys(mod.default.tools).sort()).toEqual(manifest.tools.map((t) => t.name).sort());
    const sensitiveTools = manifest.tools
      .filter((t) => t.sensitive)
      .map((t) => t.name)
      .sort();
    expect(sensitiveTools).toEqual(['chat_send', 'drive_delete_file', 'gmail_send']);
    const sensitiveCmds = manifest.permissions.cli[0]?.allow
      .filter(
        (a): a is { args: string; sensitive?: boolean } =>
          typeof a !== 'string' && a.sensitive === true,
      )
      .map((a) => a.args)
      .sort();
    expect(sensitiveCmds).toEqual(['chat +send', 'drive files delete', 'gmail +send']);
    expect(manifest.permissions.cli[0]?.denyFlags).toEqual(
      expect.arrayContaining(['--output', '-o', '--upload', '--attach']),
    );
  });
});
