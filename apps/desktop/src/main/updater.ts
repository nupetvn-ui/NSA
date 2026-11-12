import { app } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateStatus } from '@nsa/core';

const RECHECK_MS = 4 * 60 * 60 * 1000;

let status: UpdateStatus = { state: 'idle' };

export function getUpdateStatus(): UpdateStatus {
  return status;
}

/** Thoát app và cài bản mới đã tải xong. */
export function installUpdate(): void {
  if (status.state !== 'downloaded') return;
  electronUpdater.autoUpdater.quitAndInstall(false, true);
}

/**
 * Tự cập nhật: kiểm tra GitHub Releases của repo (mục `publish` trong
 * electron-builder.yml) khi mở app và mỗi 4 giờ, tải bản mới ở nền,
 * báo lên giao diện, cài khi người dùng bấm "Khởi động lại" hoặc khi thoát app.
 * Chỉ chạy trong bản đã đóng gói.
 *
 * Biến môi trường:
 * - NSA_DISABLE_AUTO_UPDATE=1 — tắt hẳn.
 * - NSA_UPDATE_URL=<url> — đọc bản cập nhật từ máy chủ khác (provider generic),
 *   dùng để thử luồng cập nhật mà không cần phát hành lên GitHub.
 */
export function setupAutoUpdate(onStatus: (status: UpdateStatus) => void): void {
  if (!app.isPackaged || process.env['NSA_DISABLE_AUTO_UPDATE'] === '1') return;

  const set = (next: UpdateStatus): void => {
    status = next;
    onStatus(next);
  };

  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const feed = process.env['NSA_UPDATE_URL'];
  if (feed) {
    autoUpdater.setFeedURL({ provider: 'generic', url: feed });
    console.info('[auto-update] dùng máy chủ cập nhật:', feed);
  }

  autoUpdater.on('checking-for-update', () => {
    if (status.state !== 'downloaded') set({ state: 'checking' });
  });
  autoUpdater.on('update-not-available', () => set({ state: 'idle' }));
  autoUpdater.on('update-available', (info) => {
    console.info('[auto-update] có bản mới:', info.version);
    set({ state: 'downloading', version: info.version, percent: 0 });
  });
  autoUpdater.on('download-progress', (progress) => {
    if (status.state === 'downloading') {
      set({ ...status, percent: Math.round(progress.percent) });
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.info('[auto-update] đã tải xong bản', info.version);
    set({ state: 'downloaded', version: info.version });
  });
  autoUpdater.on('error', (err) => {
    console.error('[auto-update] lỗi:', err);
    // Lỗi mạng hoặc chưa có bản phát hành: không làm phiền người dùng, chỉ ghi lại.
    if (status.state !== 'downloaded')
      set({ state: 'error', message: String(err?.message ?? err) });
  });

  const check = (): void => {
    // Lỗi đã được sự kiện 'error' ở trên xử lý.
    autoUpdater.checkForUpdates().catch(() => undefined);
  };
  check();
  setInterval(check, RECHECK_MS).unref();
}
