import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, app, nativeTheme, shell } from 'electron';
import {
  ChatService,
  NsaCore,
  localIdentity,
  personalPolicy,
  type IpcEventChannel,
  type IpcEventContract,
} from '@nsa/core';
import { createClaudeAdapter } from '@nsa/adapter-claude';
import { createCodexAdapter } from '@nsa/adapter-codex';
import { createFileAuditLog } from './audit';
import { registerIpc } from './ipc';
import { createFileStore } from './store';
import { setupAutoUpdate } from './updater';
import icon from '../../resources/icon.png?asset';

const core = new NsaCore();

function broadcast<E extends IpcEventChannel>(channel: E, payload: IpcEventContract[E]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/** Màu nền và nút cửa sổ khớp với giao diện sáng/tối (giống thanh tiêu đề liền khối trên macOS). */
function titleBarOverlay() {
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    color: dark ? '#1e1e1e' : '#ffffff',
    symbolColor: dark ? '#f5f5f7' : '#1d1d1f',
    height: 52,
  };
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlay(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    width: 1200,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    title: 'NSA',
    show: false,
    autoHideMenuBar: true,
    icon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  win.once('ready-to-show', () => win.show());

  const onThemeChange = (): void => {
    if (!win.isDestroyed()) win.setTitleBarOverlay(titleBarOverlay());
  };
  nativeTheme.on('updated', onThemeChange);
  win.on('closed', () => nativeTheme.off('updated', onThemeChange));

  // Liên kết ngoài mở bằng trình duyệt mặc định, không mở cửa sổ Electron mới.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(() => {
    app.setAppUserModelId('vn.nupet.nsa');

    // Bản Cá nhân: cắm bộ mặc định vào ba ổ cắm của lõi (danh tính, chính sách, nhật ký).
    const chat = new ChatService({
      adapters: [createClaudeAdapter(), createCodexAdapter()],
      identity: localIdentity(userInfo().username),
      policy: personalPolicy({ homeDir: homedir() }),
      audit: createFileAuditLog(join(app.getPath('userData'), 'audit')),
      store: createFileStore(join(app.getPath('userData'), 'conversations.json')),
      onEvent: (event) => broadcast('chat:event', event),
    });

    registerIpc(core, chat);
    createWindow();
    setupAutoUpdate((status) => broadcast('app:update', status));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
