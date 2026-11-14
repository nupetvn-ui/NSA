/**
 * G1 (ADR-0016): app ĐANG CÀI nhận adapter Claude bản mới từ một máy chủ chỉ mục cục bộ mà không
 * cập nhật app; gói hỏng thì quay về bản kèm app; gói bị sửa sau khi ký thì bị từ chối.
 * Chạy ở đích `NSA_E2E_TARGET` (dev | build | packaged). Với bản đóng gói, khoá tin cậy kèm app
 * (`resources/adapter-trust.json`, đã giải nén) được thay bằng khoá thử — giống một bản dựng có khoá riêng.
 */
import { createServer, type Server } from 'node:http';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSigningKey } from '@nsa/plugin-host';
import { buildPacks } from '../scripts/adapter-packs.mjs';
import { launchApp, packagedTrustFile, stopDevServer, target, type Launched } from './harness';

const NEW_NAME = 'Claude Code (bản cập nhật)';
const key = generateSigningKey();
const work = mkdtempSync(join(tmpdir(), 'nsa-adapter-e2e-'));
const trustFile = join(work, 'adapter-trust.json');
let backup: string | undefined;
const servers: Server[] = [];

function serve(dir: string): Promise<string> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      try {
        res.writeHead(200).end(readFileSync(join(dir, (req.url ?? '/').slice(1))));
      } catch {
        res.writeHead(404).end();
      }
    });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/index.json`);
    });
  });
}

async function release(name: string, patch: (code: string) => string): Promise<string> {
  const out = join(work, name);
  await buildPacks({
    out,
    only: ['claude'],
    catalog: false,
    signing: { pem: key.privateKeyPem, publisher: 'NSA' },
    overrides: { claude: { version: '0.1.1', patch } },
  });
  return out;
}

let goodUrl = '';
let brokenUrl = '';
let tamperedUrl = '';

beforeAll(async () => {
  writeFileSync(
    trustFile,
    JSON.stringify({ keys: [{ keyId: key.keyId, name: 'NSA', publicKey: key.publicKey }] }),
  );
  if (target === 'packaged') {
    backup = join(work, 'trust.orig.json');
    copyFileSync(packagedTrustFile(), backup);
    copyFileSync(trustFile, packagedTrustFile());
  }
  const good = await release('good', (c) => {
    if (!c.includes('Claude Code')) throw new Error('không thấy tên để đổi');
    return c.replaceAll('Claude Code', NEW_NAME);
  });
  goodUrl = await serve(good);
  brokenUrl = await serve(
    await release('broken', (c) => `throw new Error('hỏng có chủ ý');\n${c}`),
  );
  // Gói bị sửa SAU khi ký: giữ nguyên chữ ký, đổi nội dung file vào.
  const tampered = await release('tampered', (c) => c);
  const file = join(tampered, 'claude-0.1.1.nsapkg');
  const pkg = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as {
    files: Record<string, string>;
  };
  pkg.files['index.cjs'] = Buffer.from(
    `${Buffer.from(pkg.files['index.cjs'] ?? '', 'base64').toString('utf8')}\n// độc hại`,
  ).toString('base64');
  writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(pkg))));
  // Chỉ mục cũ có mã băm của gói gốc: bỏ để chữ ký là lớp kiểm duy nhất được thử.
  const idx = JSON.parse(readFileSync(join(tampered, 'index.json'), 'utf8')) as {
    packages: { sha256?: string }[];
  };
  for (const p of idx.packages) delete p.sha256;
  writeFileSync(join(tampered, 'index.json'), JSON.stringify(idx));
  tamperedUrl = await serve(tampered);
}, 180_000);

afterAll(async () => {
  if (backup) copyFileSync(backup, packagedTrustFile());
  await stopDevServer();
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    // tiến trình app vừa đóng có thể còn giữ file một lúc — thư mục tạm, bỏ qua
  }
});

async function open(userData: string, indexUrl: string | null): Promise<Launched> {
  return launchApp({
    NSA_USER_DATA: userData,
    NSA_ADAPTER_TRUST_FILE: trustFile,
    NSA_ADAPTER_CHECK_DELAY_MS: '200',
    ...(indexUrl ? { NSA_ADAPTER_INDEX_URL: indexUrl, NSA_ADAPTER_UPDATES: 'on' } : {}),
  });
}

const agentNames = (run: Launched) => run.page.locator('.agent-row').allTextContents();

function auditText(userData: string): string {
  const dir = join(userData, 'audit');
  return readdirSync(dir)
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

describe(`cập nhật adapter không cần cập nhật app (${target})`, () => {
  it('gói mới ký đúng → app đang chạy dùng ngay; mở lại vẫn dùng; file hỏng → quay về bản kèm app', async () => {
    const userData = mkdtempSync(join(work, 'u1-'));
    let run = await open(userData, goodUrl);
    await run.page.getByText(NEW_NAME).first().waitFor({ timeout: 60_000 });
    await run.page.getByText(/Đã cập nhật adapter claude lên 0\.1\.1/).waitFor();
    expect(run.problems).toEqual([]);
    await run.close();

    // Mở lại, KHÔNG có máy chủ chỉ mục: bản đã tải vẫn được dùng.
    run = await open(userData, null);
    await run.page.getByText(NEW_NAME).first().waitFor({ timeout: 30_000 });
    expect((await agentNames(run)).join()).toContain(NEW_NAME);
    await run.close();

    // Làm hỏng file đã tải: app quay về bản kèm app, báo người dùng, ghi nhật ký.
    writeFileSync(join(userData, 'adapters', 'claude', '0.1.1', 'index.cjs'), 'module.exports = {');
    run = await open(userData, null);
    await run.page.getByText(/quay về bản kèm app/).waitFor({ timeout: 30_000 });
    expect((await agentNames(run)).join()).not.toContain(NEW_NAME);
    await run.close();
    expect(auditText(userData)).toContain('"action":"fallback"');
  });

  it('gói hỏng khi nạp → bị từ chối, vẫn dùng bản kèm app', async () => {
    const userData = mkdtempSync(join(work, 'u2-'));
    const run = await open(userData, brokenUrl);
    await run.page
      .getByText(/NSA từ chối bản cập nhật claude 0\.1\.1/)
      .waitFor({ timeout: 60_000 });
    expect((await agentNames(run)).join()).not.toContain(NEW_NAME);
    await run.close();
  });

  it('gói bị sửa sau khi ký → bị từ chối', async () => {
    const userData = mkdtempSync(join(work, 'u3-'));
    const run = await open(userData, tamperedUrl);
    await run.page.getByText(/bị sửa sau khi ký/).waitFor({ timeout: 60_000 });
    expect((await agentNames(run)).join()).not.toContain(NEW_NAME);
    await run.close();
    expect(auditText(userData)).toContain('"action":"rejected"');
  });
});
