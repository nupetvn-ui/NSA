import { app, ipcMain } from 'electron';
import type { IpcArgs, IpcChannel, IpcResult, NsaCore } from '@nsa/core';

type Handlers = {
  [C in IpcChannel]: (...args: IpcArgs<C>) => IpcResult<C> | Promise<IpcResult<C>>;
};

/** Đăng ký trình xử lý cho mọi kênh trong hợp đồng IPC — thiếu kênh nào TypeScript báo lỗi. */
export function registerIpc(core: NsaCore): void {
  const handlers: Handlers = {
    'core:ping': (message) => core.ping(message),
    'app:info': () => ({ name: app.getName(), version: app.getVersion() }),
  };

  for (const channel of Object.keys(handlers) as IpcChannel[]) {
    const handler = handlers[channel] as (...args: unknown[]) => unknown;
    ipcMain.handle(channel, (_event, ...args: unknown[]) => handler(...args));
  }
}
