import { BrowserWindow, app, dialog, ipcMain } from 'electron';
import type { ChatService, CliChange, IpcArgs, IpcChannel, IpcResult, NsaCore } from '@nsa/core';
import { getUpdateStatus, installUpdate } from './updater';

type Handlers = {
  [C in IpcChannel]: (...args: IpcArgs<C>) => IpcResult<C> | Promise<IpcResult<C>>;
};

/** Đăng ký trình xử lý cho mọi kênh trong hợp đồng IPC — thiếu kênh nào TypeScript báo lỗi. */
export function registerIpc(core: NsaCore, chat: ChatService, cliChanges: () => CliChange[]): void {
  const handlers: Handlers = {
    'core:ping': (message) => core.ping(message),
    'app:info': () => ({ name: app.getName(), version: app.getVersion() }),
    'app:updateStatus': () => getUpdateStatus(),
    'app:installUpdate': () => installUpdate(),
    'agents:list': () => chat.listAgents(),
    'chat:list': () => chat.listConversations(),
    'chat:send': (request) => chat.send(request),
    'chat:cancel': (turnId) => chat.cancel(turnId),
    'chat:delete': (conversationId) => chat.deleteConversation(conversationId),
    'chat:answerPermission': (permissionId, allowed) =>
      chat.answerPermission(String(permissionId), allowed === true),
    'agents:changes': () => cliChanges(),
    'dialog:pickFolder': async () => {
      const win = BrowserWindow.getFocusedWindow();
      const options = {
        title: 'Chọn thư mục làm việc cho agent',
        properties: ['openDirectory' as const],
      };
      const result = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  };

  for (const channel of Object.keys(handlers) as IpcChannel[]) {
    const handler = handlers[channel] as (...args: unknown[]) => unknown;
    ipcMain.handle(channel, (_event, ...args: unknown[]) => handler(...args));
  }
}
