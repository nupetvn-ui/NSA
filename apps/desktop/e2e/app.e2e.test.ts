/**
 * Bài mở app tự động (G2, ADR-0014): mở NSA thật bằng Electron, đi qua chat, Bộ nhớ, Nhà cung cấp
 * và App Store, coi MỌI lỗi console / lỗi không bắt của giao diện là thất bại. Không cần CLI thật
 * hay key: app chạy với agent giả (`NSA_E2E_FAKE_AGENT=1`) và thư mục dữ liệu tạm.
 *
 * Ba đích chạy, chọn bằng `NSA_E2E_TARGET`:
 * - `dev` (mặc định): giao diện nạp từ máy chủ Vite dev — đúng đường đã làm màn hình đen ở PR #5
 *   (import `node:os` trong giao diện chỉ nổ ở chế độ này).
 * - `build`: chạy bản dựng `out/` (đường nạp file, như bản đóng gói nhưng chưa đóng gói).
 * - `packaged`: chạy `NSA.exe` trong `release/<ver>/win-unpacked` (bắt lỗi thiếu nhị phân gốc).
 */
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';
import { workspaceAliases } from '../../../workspace-aliases';

const desktop = resolve(__dirname, '..');
const repo = resolve(desktop, '../..');
const target = process.env['NSA_E2E_TARGET'] ?? 'dev';
const REPLY = 'Xin chào từ agent giả của bài kiểm thử.';

let app: ElectronApplication;
let page: Page;
let vite: ViteDevServer | undefined;
let userData: string;
const problems: string[] = [];

function packagedExe(): string {
  const releases = join(desktop, 'release');
  for (const ver of readdirSync(releases)) {
    const exe = join(releases, ver, 'win-unpacked', 'NSA.exe');
    if (existsSync(exe)) return exe;
  }
  throw new Error(`Không thấy NSA.exe trong ${releases} — chạy \`pnpm dist:dir\` trước.`);
}

beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'nsa-e2e-'));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NSA_USER_DATA: userData,
    NSA_E2E_FAKE_AGENT: '1',
  };
  delete env['ELECTRON_RUN_AS_NODE'];

  if (target === 'packaged') {
    app = await electron.launch({ executablePath: packagedExe(), env });
  } else {
    if (target === 'dev') {
      vite = await createServer({
        configFile: false,
        root: resolve(desktop, 'src/renderer'),
        resolve: { alias: workspaceAliases(repo) },
        plugins: [react()],
        server: { port: 0, host: '127.0.0.1' },
        logLevel: 'warn',
      });
      await vite.listen();
      env['ELECTRON_RENDERER_URL'] = vite.resolvedUrls?.local[0] ?? '';
    } else {
      delete env['ELECTRON_RENDERER_URL'];
    }
    const electronExe = createRequire(join(desktop, 'package.json'))('electron') as string;
    app = await electron.launch({
      executablePath: electronExe,
      args: [join(desktop, 'out/main/index.js')],
      env,
    });
  }

  page = await app.firstWindow();
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  // Lỗi xảy ra trước khi gắn bộ nghe (lúc nạp trang) cũng phải bắt được: nạp lại một lần.
  await page.reload();
}, 120_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  await vite?.close();
  rmSync(userData, { recursive: true, force: true });
});

describe(`mở app NSA (${target})`, () => {
  it('hiện khung chính, không màn hình trắng', async () => {
    await page.getByText('Cuộc trò chuyện', { exact: true }).waitFor({ timeout: 30_000 });
    expect(await page.locator('.brand-name').textContent()).toBe('NSA');
  });

  it('chat: gửi một câu, agent giả trả lời', async () => {
    // Hộp chọn thư mục của hệ điều hành không điều khiển được: thay bằng thư mục tạm.
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [dir] });
    }, userData);
    await page.getByRole('button', { name: 'Chọn…' }).click();
    await page.getByRole('radio', { name: /Agent giả/ }).click();
    await page.getByPlaceholder(/Nhắn cho/).fill('Chào bạn');
    await page.getByRole('button', { name: 'Gửi' }).click();
    await page.getByText(REPLY).waitFor({ timeout: 20_000 });
  });

  it('Bộ nhớ: mở và bấm qua từng thẻ', async () => {
    await page.locator('.nav-item', { hasText: 'Bộ nhớ' }).click();
    await page.getByRole('heading', { name: 'Bộ nhớ', level: 1 }).waitFor();
    for (const tab of await page
      .getByRole('tablist', { name: 'Mục bộ nhớ' })
      .getByRole('tab')
      .all()) {
      await tab.click();
    }
  });

  it('Nhà cung cấp: mở và bấm qua từng thẻ', async () => {
    await page.locator('.nav-item', { hasText: 'Nhà cung cấp' }).click();
    await page.getByRole('heading', { name: 'Nhà cung cấp', level: 1 }).waitFor();
    for (const tab of await page.getByRole('tab').all()) {
      await tab.click();
    }
  });

  it('App Store: mở', async () => {
    await page.locator('.nav-item', { hasText: 'App Store' }).click();
    await page.getByRole('heading', { name: 'App Store', level: 1 }).waitFor();
  });

  it('Knowledge Base: cài từ thư mục, mở màn hình (khung cô lập) và bấm qua từng thẻ', async () => {
    const dir = resolve(repo, 'plugins/knowledge-base');
    const installed = await page.evaluate(async (path) => {
      const nsa = (
        window as unknown as { nsa: { invoke: (c: string, ...a: unknown[]) => Promise<any> } }
      ).nsa;
      await nsa.invoke('plugins:saveSettings', { developerMode: true });
      const prepared = await nsa.invoke('plugins:prepare', { kind: 'path', path });
      const res = await nsa.invoke(
        'plugins:install',
        prepared.prepareId,
        {
          memory: true,
          model: true,
          notifications: true,
          network: ['*'],
          folders: {},
          cli: ['ffmpeg', 'ffprobe', 'whisper'],
        },
        true,
      );
      return res.status as string;
    }, dir);
    expect(installed).toBe('installed');
    await page.locator('.nav-item', { hasText: 'App Store' }).click();
    await page.getByText('Knowledge Base', { exact: true }).first().click();
    const frame = page.frameLocator('iframe.plugin-frame');
    await frame.getByText('Kéo-thả file hoặc thư mục vào đây').waitFor({ timeout: 30_000 });
    for (const tab of ['Duyệt', 'Tìm thử', 'Công cụ & cài đặt', 'Nguồn']) {
      await frame.locator('#tabs button', { hasText: tab }).click();
    }
    await frame.locator('#tab-sources').waitFor();
    await page.getByRole('button', { name: /App Store/ }).click();
  });

  it('quay lại chat vẫn thấy câu trả lời', async () => {
    await page.locator('.conv-item').first().click();
    await page.getByText(REPLY).waitFor();
  });

  it('không có lỗi console / lỗi không bắt nào của giao diện', async () => {
    await page.waitForTimeout(500);
    expect(problems).toEqual([]);
  });
});
