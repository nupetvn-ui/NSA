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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchApp, stopDevServer, target, type Launched } from './harness';

const REPLY = 'Xin chào từ agent giả của bài kiểm thử.';

let run: Launched;
let userData: string;

beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'nsa-e2e-'));
  run = await launchApp({ NSA_USER_DATA: userData, NSA_E2E_FAKE_AGENT: '1' });
}, 120_000);

afterAll(async () => {
  await run?.close();
  await stopDevServer();
  rmSync(userData, { recursive: true, force: true });
});

describe(`mở app NSA (${target})`, () => {
  it('hiện khung chính, không màn hình trắng', async () => {
    await run.page.getByText('Cuộc trò chuyện', { exact: true }).waitFor({ timeout: 30_000 });
    expect(await run.page.locator('.brand-name').textContent()).toBe('NSA');
  });

  it('chat: gửi một câu, agent giả trả lời', async () => {
    const { app, page } = run;
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
    const { page } = run;
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
    const { page } = run;
    await page.locator('.nav-item', { hasText: 'Nhà cung cấp' }).click();
    await page.getByRole('heading', { name: 'Nhà cung cấp', level: 1 }).waitFor();
    for (const tab of await page.getByRole('tab').all()) {
      await tab.click();
    }
  });

  it('App Store: mở', async () => {
    await run.page.locator('.nav-item', { hasText: 'App Store' }).click();
    await run.page.getByRole('heading', { name: 'App Store', level: 1 }).waitFor();
  });

  it('quay lại chat vẫn thấy câu trả lời', async () => {
    await run.page.locator('.conv-item').first().click();
    await run.page.getByText(REPLY).waitFor();
  });

  it('không có lỗi console / lỗi không bắt nào của giao diện', async () => {
    await run.page.waitForTimeout(500);
    expect(run.problems).toEqual([]);
  });
});
