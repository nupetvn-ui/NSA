import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { BrowserWindow, Notification, app, dialog, protocol } from 'electron';
import type {
  AuditLog,
  ChatService,
  IdentityProvider,
  IpcEventChannel,
  IpcEventContract,
  Policy,
  PluginsIpcContract,
} from '@nsa/core';
import { McpGateway, memoryToolSource } from '@nsa/mcp-gateway';
import type { MemoryRuntime } from '@nsa/memory';
import { PluginHost, createMemoryBridge, type TrustedPublisher } from '@nsa/plugin-host';
import { createEncryptedFileSecretStore, type OsCipher } from '@nsa/providers';
import type { ModelTaskStatus, PluginGrants } from '@nsa/plugin-sdk';

/** Giao thức riêng cho màn hình plugin: `nsa-plugin://<id>/<đường dẫn>`. Gọi TRƯỚC khi app sẵn sàng. */
export const PLUGIN_SCHEME = 'nsa-plugin';

export function registerPluginScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_SCHEME,
      // `standard` + `secure` để trang plugin có origin riêng theo từng plugin; không bật
      // fetch / CORS / service worker — màn hình chỉ nói chuyện với plugin qua window.nsa.
      privileges: { standard: true, secure: true },
    },
  ]);
}

/** Mã chèn vào đầu mỗi trang HTML của plugin: `window.nsa.call / on`, nối với giao diện qua postMessage. */
const BRIDGE = `<script>(function(){var pending=new Map(),n=0,handlers={};
window.addEventListener('message',function(e){if(e.source!==window.parent)return;var m=e.data;if(!m||m.__nsa!==1)return;
if(m.type==='result'){var p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.ok?p.res(m.value):p.rej(new Error(m.error));}
else if(m.type==='event'){(handlers[m.event]||[]).slice().forEach(function(h){h(m.data);});}});
window.nsa={call:function(method,params){return new Promise(function(res,rej){var id=++n;pending.set(id,{res:res,rej:rej});
window.parent.postMessage({__nsa:1,type:'call',id:id,method:method,params:params},'*');});},
on:function(ev,h){(handlers[ev]=handlers[ev]||[]).push(h);return function(){handlers[ev]=(handlers[ev]||[]).filter(function(x){return x!==h;});};}};
window.parent.postMessage({__nsa:1,type:'ready'},'*');})();</script>`;

const CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'";

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

export interface PluginsSetup {
  host: PluginHost;
  gateway: McpGateway | null;
  handlers: {
    [C in keyof PluginsIpcContract]: (
      ...args: PluginsIpcContract[C]['args']
    ) => PluginsIpcContract[C]['result'] | Promise<PluginsIpcContract[C]['result']>;
  };
  close: () => Promise<void>;
}

/**
 * Plugin host + cổng MCP của NSA: tool bộ nhớ và tool của mọi plugin đang bật, gắn cho agent qua
 * `attachMcp`; mọi lời gọi đi qua Policy + AuditLog (ADR-0010).
 */
export async function setupPlugins(options: {
  userData: string;
  identity: IdentityProvider;
  policy: Policy;
  audit: AuditLog;
  runtime: MemoryRuntime;
  /** Bộ mã hoá của hệ điều hành (Electron safeStorage): bí mật của plugin cũng cất ở đây. */
  cipher: OsCipher;
  /** Chạy model của việc "kênh chat" qua ModelTaskRunner (chính sách, chi phí, dự phòng — ADR-0009). */
  runText: (task: string, prompt: string) => Promise<string>;
  /** Việc "nhìn ảnh" / "embedding" / tình trạng model — cho plugin có quyền `model` (ADR-0014). */
  vision: (
    prompt: string,
    images: { mimeType: string; base64: string }[],
    system?: string,
  ) => Promise<string>;
  embed: (texts: string[]) => Promise<number[][]>;
  taskStatus: (task: 'background' | 'vision' | 'embedding') => ModelTaskStatus;
  /** Che mọi key API của app khỏi nội dung gửi model / nhật ký. */
  redact: (text: string) => string;
  chat: () => ChatService;
  broadcast: <E extends IpcEventChannel>(channel: E, payload: IpcEventContract[E]) => void;
}): Promise<PluginsSetup> {
  const { runtime } = options;
  const service = runtime.service;

  // ---- Cổng MCP. Mở không được thì vẫn chạy: agent chỉ không có tool của NSA.
  let gateway: McpGateway | null = null;
  try {
    gateway = await McpGateway.start({
      version: app.getVersion(),
      identity: options.identity,
      policy: options.policy,
      audit: options.audit,
      askUser: (context, description) =>
        context.turnId
          ? options.chat().askUser(context.turnId, context.agentId, description)
          : Promise.resolve(false),
    });
    gateway.addSource(memoryToolSource(service, () => runtime.agentToolsEnabled));
  } catch (err) {
    console.error('[gateway] không mở được cổng MCP:', err);
  }

  // ---- Cầu nối plugin ↔ NSA Mem: plugin chỉ thấy nhánh của chính nó.
  const bridge = createMemoryBridge(service);

  const ref: { host?: PluginHost } = {};
  const host = await PluginHost.open({
    dir: join(options.userData, 'plugins'),
    nsaVersion: app.getVersion(),
    identity: options.identity,
    policy: options.policy,
    audit: options.audit,
    trustedPublishers: loadTrustedPublishers(
      join(options.userData, 'plugins', 'trusted-publishers.json'),
    ),
    memory: bridge,
    // Token của plugin: kho khoá riêng (mã hoá bằng hệ điều hành), tách khỏi key API. Plugin không đọc được.
    secrets: createEncryptedFileSecretStore(
      join(options.userData, 'plugin-secrets.json'),
      options.cipher,
    ),
    model: (pluginId, prompt, o) =>
      options.runText(
        o.task ?? 'channel',
        o.system ? `${o.system}\n\n--- DỮ LIỆU ---\n${prompt}` : prompt,
      ),
    vision: (pluginId, prompt, images, o) => options.vision(prompt, images, o.system),
    embed: (pluginId, texts) => options.embed(texts),
    modelStatus: async (task) => options.taskStatus(task),
    confirm: (pluginId, text, signal) => confirmPluginAction(pluginId, text, signal),
    redact: options.redact,
    runtime: { execPath: process.execPath, electron: true },
    notify: (pluginId, n) => {
      if (Notification.isSupported()) {
        new Notification({
          title: n.title,
          ...(n.body ? { body: n.body } : {}),
          silent: false,
        }).show();
      }
      void pluginId;
    },
    onChange: () => options.broadcast('plugins:changed', ref.host?.list() ?? []),
    onUiEvent: (pluginId, event, data) =>
      options.broadcast('plugins:uiEvent', { pluginId, event, data }),
  });
  ref.host = host;
  gateway?.addSource(() => host.tools());

  // ---- Giao thức nsa-plugin:// phục vụ file tĩnh của màn hình plugin.
  protocol.handle(PLUGIN_SCHEME, (request) => {
    try {
      const url = new URL(request.url);
      const id = url.hostname;
      const path = decodeURIComponent(url.pathname);
      const file = host.assetPath(id, path);
      if (!file) return new Response('Không tìm thấy', { status: 404 });
      const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
      let body: Buffer | string = readFileSync(file);
      if (type.startsWith('text/html')) {
        const html = body.toString('utf8');
        body = /<head[^>]*>/i.test(html)
          ? html.replace(/<head[^>]*>/i, (m) => `${m}${BRIDGE}`)
          : `${BRIDGE}${html}`;
      }
      return new Response(body, {
        headers: {
          'content-type': type,
          'content-security-policy': CSP,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      });
    } catch {
      return new Response('Lỗi', { status: 500 });
    }
  });

  const handlers: PluginsSetup['handlers'] = {
    'plugins:list': () => host.list(),
    'plugins:settings': () => host.settings(),
    'plugins:saveSettings': (patch) => host.saveSettings(patch ?? {}),
    'plugins:prepare': async (source) => {
      if (source.kind === 'registry') return host.prepareFromRegistry(String(source.id));
      if (source.kind === 'path') return host.prepareFromFile(String(source.path));
      const win = BrowserWindow.getFocusedWindow();
      const dialogOptions =
        source.what === 'directory'
          ? {
              title: 'Chọn thư mục plugin (có nsa-plugin.json)',
              properties: ['openDirectory' as const],
            }
          : {
              title: 'Chọn gói plugin',
              properties: ['openFile' as const],
              filters: [{ name: 'Gói plugin NSA', extensions: ['nsapkg'] }],
            };
      const result = win
        ? await dialog.showOpenDialog(win, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      const chosen = result.canceled ? undefined : result.filePaths[0];
      return chosen ? host.prepareFromFile(chosen) : null;
    },
    'plugins:install': (prepareId, grants, confirmed) =>
      host.install(String(prepareId), cleanGrants(grants), confirmed === true),
    'plugins:setEnabled': (id, enabled) => host.setEnabled(String(id), enabled === true),
    'plugins:uninstall': (id, deleteData) =>
      host.uninstall(String(id), { deleteData: deleteData !== false }),
    'plugins:updateGrants': (id, grants) => host.updateGrants(String(id), cleanGrants(grants)),
    'plugins:runJob': (id, jobId) => host.runJob(String(id), String(jobId)),
    'plugins:setSecret': (id, secretId, value) =>
      host.setSecret(String(id), String(secretId), String(value)),
    'plugins:deleteSecret': (id, secretId) => host.deleteSecret(String(id), String(secretId)),
    'plugins:pickFolder': async (label) => {
      const win = BrowserWindow.getFocusedWindow();
      const dialogOptions = {
        title: `Chọn thư mục cho plugin: ${String(label).slice(0, 80)}`,
        properties: ['openDirectory' as const],
      };
      const result = win
        ? await dialog.showOpenDialog(win, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    'plugins:registry': () => host.registryEntries(),
    'plugins:ui': (id, method, params) => host.callUi(String(id), String(method), params),
  };

  return {
    host,
    gateway,
    handlers,
    close: async () => {
      await host.close();
      await gateway?.close();
    },
  };
}

/** Quyền từ giao diện → kiểu chắc chắn (host còn lọc lại theo điều plugin đã xin). */
function cleanGrants(value: unknown): PluginGrants {
  const g = (value ?? {}) as Partial<PluginGrants>;
  const folders: Record<string, string> = {};
  if (g.folders && typeof g.folders === 'object') {
    for (const [k, v] of Object.entries(g.folders)) if (typeof v === 'string') folders[k] = v;
  }
  return {
    network: Array.isArray(g.network)
      ? g.network.filter((d): d is string => typeof d === 'string')
      : [],
    folders,
    memory: g.memory === true,
    notifications: g.notifications === true,
    model: g.model === true,
    cli: Array.isArray(g.cli) ? g.cli.filter((id): id is string => typeof id === 'string') : [],
  };
}

/**
 * Hộp hỏi người dùng khi một plugin chạy nền xin làm thao tác nhạy cảm (xoá, mời ra khỏi nhóm,
 * gửi hàng loạt…). Hộp thoại của hệ điều hành; không trả lời kịp / đóng hộp = không đồng ý.
 */
async function confirmPluginAction(
  pluginId: string,
  text: string,
  signal: AbortSignal,
): Promise<boolean> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const options = {
    type: 'warning' as const,
    title: 'NSA — xác nhận thao tác nhạy cảm',
    message: `Plugin "${pluginId}" muốn làm một thao tác nhạy cảm`,
    detail: text.slice(0, 600),
    buttons: ['Từ chối', 'Cho phép'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    signal,
  };
  try {
    const result = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    return result.response === 1;
  } catch {
    return false;
  }
}

/** Khoá nhà phát hành tin cậy: file `plugins/trusted-publishers.json` (người dùng / IT thêm). */
function loadTrustedPublishers(file: string): TrustedPublisher[] {
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (t): t is TrustedPublisher =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as TrustedPublisher).keyId === 'string' &&
        typeof (t as TrustedPublisher).name === 'string' &&
        typeof (t as TrustedPublisher).publicKey === 'string',
    );
  } catch (err) {
    console.error('[plugins] không đọc được trusted-publishers.json:', err);
    return [];
  }
}
