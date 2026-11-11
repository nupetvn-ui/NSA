import { contextBridge, ipcRenderer } from 'electron';
import type { IpcArgs, IpcChannel, IpcResult, NsaBridge } from '@nsa/core';
import { isIpcChannel } from '@nsa/core';

// Chỉ lộ đúng một hàm `invoke` cho các kênh đã khai báo trong hợp đồng IPC;
// renderer không chạm được vào ipcRenderer hay API Node nào khác.
const bridge: NsaBridge = {
  invoke<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>> {
    if (!isIpcChannel(channel)) {
      return Promise.reject(new Error(`Kênh IPC không hợp lệ: ${String(channel)}`));
    }
    return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<C>>;
  },
};

contextBridge.exposeInMainWorld('nsa', bridge);
