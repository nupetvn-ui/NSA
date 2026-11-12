import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  IpcArgs,
  IpcChannel,
  IpcEventChannel,
  IpcEventContract,
  IpcResult,
  NsaBridge,
} from '@nsa/core';
import { isIpcChannel, isIpcEventChannel } from '@nsa/core';

// Chỉ lộ đúng hai hàm cho các kênh đã khai báo trong hợp đồng IPC;
// renderer không chạm được vào ipcRenderer hay API Node nào khác.
const bridge: NsaBridge = {
  invoke<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>> {
    if (!isIpcChannel(channel)) {
      return Promise.reject(new Error(`Kênh IPC không hợp lệ: ${String(channel)}`));
    }
    return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<C>>;
  },

  on<E extends IpcEventChannel>(channel: E, listener: (payload: IpcEventContract[E]) => void) {
    if (!isIpcEventChannel(channel))
      throw new Error(`Kênh sự kiện không hợp lệ: ${String(channel)}`);
    const wrapped = (_event: IpcRendererEvent, payload: IpcEventContract[E]): void =>
      listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('nsa', bridge);
