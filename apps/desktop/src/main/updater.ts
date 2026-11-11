import { app } from 'electron';
import electronUpdater from 'electron-updater';

/**
 * Khung tự cập nhật: kiểm tra GitHub Releases của repo (mục `publish` trong
 * electron-builder.yml), tải bản mới ở nền và cài khi người dùng thoát app.
 * Chỉ chạy trong bản đã đóng gói; khi dev thì bỏ qua.
 */
export function setupAutoUpdate(): void {
  if (!app.isPackaged || process.env['NSA_DISABLE_AUTO_UPDATE'] === '1') return;

  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => console.error('[auto-update] lỗi:', err));
  autoUpdater.on('update-available', (info) =>
    console.info('[auto-update] có bản mới:', info.version),
  );
  autoUpdater.on('update-downloaded', (info) =>
    console.info('[auto-update] đã tải xong bản', info.version, '— sẽ cài khi thoát app'),
  );

  autoUpdater.checkForUpdates().catch((err: unknown) => {
    console.error('[auto-update] không kiểm tra được bản mới:', err);
  });
}
