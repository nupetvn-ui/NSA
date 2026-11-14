/**
 * Dùng chung cho các bài mở app tự động: mở NSA thật bằng Electron ở một trong ba đích
 * (`NSA_E2E_TARGET`: dev | build | packaged) — xem ADR-0014.
 */
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';
import { workspaceAliases } from '../../../workspace-aliases';

export const desktop = resolve(__dirname, '..');
export const repo = resolve(desktop, '../..');
export const target = process.env['NSA_E2E_TARGET'] ?? 'dev';

export function packagedExe(): string {
  const releases = join(desktop, 'release');
  for (const ver of readdirSync(releases)) {
    const exe = join(releases, ver, 'win-unpacked', 'NSA.exe');
    if (existsSync(exe)) return exe;
  }
  throw new Error(`Không thấy NSA.exe trong ${releases} — chạy "pnpm dist:dir" trước.`);
}

/** File khoá tin cậy của bản đóng gói (đã giải nén khỏi asar) — bài thử ghi đè bằng khoá thử. */
export function packagedTrustFile(): string {
  return join(
    packagedExe(),
    '..',
    'resources',
    'app.asar.unpacked',
    'resources',
    'adapter-trust.json',
  );
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
  /** Lỗi console / lỗi không bắt của giao diện từ lúc mở. */
  problems: string[];
  close(): Promise<void>;
}

let vite: ViteDevServer | undefined;

/** Máy chủ Vite dùng chung cho đích `dev` (dựng một lần cho cả file test). */
async function devUrl(): Promise<string> {
  vite ??= await createServer({
    configFile: false,
    root: resolve(desktop, 'src/renderer'),
    resolve: { alias: workspaceAliases(repo) },
    plugins: [react()],
    server: { port: 0, host: '127.0.0.1' },
    logLevel: 'warn',
  });
  if (!vite.resolvedUrls) await vite.listen();
  return vite.resolvedUrls?.local[0] ?? '';
}

export async function stopDevServer(): Promise<void> {
  await vite?.close();
  vite = undefined;
}

export async function launchApp(extraEnv: Record<string, string>): Promise<Launched> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // Mặc định không tự cập nhật adapter (bài nào cần thì bật lại).
    NSA_ADAPTER_UPDATES: 'off',
    ...extraEnv,
  };
  delete env['ELECTRON_RUN_AS_NODE'];
  let app: ElectronApplication;
  if (target === 'packaged') {
    app = await electron.launch({ executablePath: packagedExe(), env });
  } else {
    if (target === 'dev') env['ELECTRON_RENDERER_URL'] = await devUrl();
    else delete env['ELECTRON_RENDERER_URL'];
    const electronExe = createRequire(join(desktop, 'package.json'))('electron') as string;
    app = await electron.launch({
      executablePath: electronExe,
      args: [join(desktop, 'out/main/index.js')],
      env,
    });
  }
  const page = await app.firstWindow();
  const problems: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  // Lỗi lúc nạp trang cũng phải bắt được: nạp lại một lần sau khi gắn bộ nghe.
  await page.reload();
  return { app, page, problems, close: () => app.close().catch(() => undefined) };
}
