import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { BrowserWindow, app, nativeTheme, safeStorage, shell } from 'electron';
import { ToolGateServer } from '@nsa/adapter-sdk';
import {
  ChatService,
  NsaCore,
  describeChange,
  detectCliChanges,
  localIdentity,
  personalPolicy,
  type CliChange,
  type IpcEventChannel,
  type IpcEventContract,
} from '@nsa/core';
import { createAgents } from './agents';
import { createFileAuditLog } from './audit';
import { createFingerprintStore } from './cli-changes';
import { setupProviders } from './providers';
import { registerIpc } from './ipc';
import { setupMemory } from './memory';
import { registerPluginScheme, setupPlugins, type PluginsSetup } from './plugins';
import { createFileStore } from './store';
import { setupAutoUpdate } from './updater';
import icon from '../../resources/icon.png?asset';

const core = new NsaCore();

// Giao thức của màn hình plugin phải đăng ký trước khi app sẵn sàng.
registerPluginScheme();

// Chạy thử / test tự động trong thư mục dữ liệu riêng, không đụng dữ liệu thật của người dùng.
const userDataOverride = process.env['NSA_USER_DATA'];
if (userDataOverride) app.setPath('userData', userDataOverride);

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

  void app.whenReady().then(async () => {
    app.setAppUserModelId('vn.nupet.nsa');
    const userData = app.getPath('userData');
    const identity = localIdentity(userInfo().username);
    const adapters = createAgents(userData);

    // Nhà cung cấp model qua API key (ADR-0009): key cất bằng safeStorage (Windows: DPAPI).
    // ChatService tạo sau, nhưng nhà cung cấp cần báo cho nó khi danh sách agent đổi.
    const ref: { chat?: ChatService } = {};
    const providers = setupProviders({
      userData,
      cipher: safeStorage,
      identity,
      audit: createFileAuditLog(join(userData, 'audit')),
      basePolicy: personalPolicy({ homeDir: homedir() }),
      onAgentsChanged: (apiAgents) => ref.chat?.setAdapters([...adapters, ...apiAgents]),
      broadcast,
    });
    const audit = providers.audit;

    // Cổng chính sách từng lệnh (127.0.0.1, cổng ngẫu nhiên). Mở không được thì vẫn chạy,
    // chỉ là không chặn được từng lệnh bên trong lượt.
    let gate: ToolGateServer | undefined;
    try {
      gate = await ToolGateServer.start();
    } catch (err) {
      console.error('[gate] không mở được cổng chính sách:', err);
    }
    app.on('will-quit', () => void gate?.close());

    // Bản Cá nhân: cắm bộ mặc định vào bốn ổ cắm của lõi (danh tính, chính sách, nhật ký,
    // bộ nhớ có chủ sở hữu + phạm vi — MemoryService mặc định dùng personalMemoryAccess).
    // Chính sách đã ghép thêm kiểm hãng model (model.use) và hạn mức chi phí — ADR-0009.
    const policy = providers.policy;
    let chat: ChatService | null = null;
    let plugins: PluginsSetup | null = null;
    const memory = await setupMemory({
      userData,
      identity,
      policy,
      audit,
      chat: () => {
        if (!chat) throw new Error('Lõi chat chưa sẵn sàng');
        return chat;
      },
      onChanged: (pending) => broadcast('mem:changed', { pending }),
      onStatus: (status) => broadcast('mem:status', status),
      toolsAvailable: () => plugins?.gateway != null,
    });
    app.on('will-quit', () => void memory.close());

    // App Store: cổng MCP chung (tool bộ nhớ + tool của plugin) và plugin host (ADR-0010).
    plugins = await setupPlugins({
      userData,
      identity,
      policy,
      audit,
      runtime: memory.runtime,
      chat: () => {
        if (!chat) throw new Error('Lõi chat chưa sẵn sàng');
        return chat;
      },
      broadcast,
    });
    app.on('will-quit', () => void plugins?.close());

    chat = new ChatService({
      adapters: [...adapters, ...providers.agents()],
      identity,
      policy,
      audit,
      ...(gate ? { gate } : {}),
      store: providers.wrapStore(createFileStore(join(userData, 'conversations.json'))),
      extensions: [memory.runtime, ...(plugins.gateway ? [plugins.gateway] : [])],
      fallbackOrder: (agentId) => providers.hub.fallbackAgents(agentId),
      onEvent: (event) => {
        providers.onChatEvent(event);
        broadcast('chat:event', event);
      },
    });
    ref.chat = chat;

    // Tự phát hiện thay đổi: so phiên bản + --help của từng CLI với lần khởi động trước.
    let cliChanges: CliChange[] = [];
    void detectCliChanges(adapters, createFingerprintStore(join(userData, 'cli-fingerprints.json')))
      .then((changes) => {
        cliChanges = changes;
        const actor = identity.current();
        for (const change of changes) {
          audit.record({
            at: new Date().toISOString(),
            actor: { id: actor.id, displayName: actor.displayName },
            agentId: change.agentId,
            type: 'cli_change',
            summary: describeChange(change),
          });
        }
        if (changes.length) broadcast('agents:changes', changes);
      })
      .catch((err: unknown) => console.error('[cli-watch]', err));

    registerIpc(core, chat, () => cliChanges, providers, {
      runtime: memory.runtime,
      mcpUrl: plugins.gateway?.url ?? null,
      plugins: plugins.handlers,
    });
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
