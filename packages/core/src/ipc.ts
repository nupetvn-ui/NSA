/**
 * Hợp đồng IPC giữa giao diện (renderer) và lõi NSA (tiến trình main).
 * Mỗi kênh khai báo kiểu tham số và kiểu kết quả; main, preload và renderer
 * đều dùng chung định nghĩa này nên sai kiểu sẽ bị TypeScript bắt ngay.
 */
export interface PingResult {
  /** Luôn là 'pong' khi lõi trả lời. */
  reply: 'pong';
  /** Chuỗi gửi kèm, được lõi trả lại nguyên văn. */
  echo: string;
  /** Phiên bản lõi đang chạy. */
  coreVersion: string;
  /** Thời điểm lõi trả lời (ISO 8601). */
  at: string;
}

export interface AppInfo {
  name: string;
  version: string;
}

export interface IpcContract {
  'core:ping': { args: [message: string]; result: PingResult };
  'app:info': { args: []; result: AppInfo };
}

export type IpcChannel = keyof IpcContract;
export type IpcArgs<C extends IpcChannel> = IpcContract[C]['args'];
export type IpcResult<C extends IpcChannel> = IpcContract[C]['result'];

/** Danh sách kênh hợp lệ — preload chỉ cho phép gọi các kênh này. */
export const IPC_CHANNELS = ['core:ping', 'app:info'] as const satisfies readonly IpcChannel[];

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && (IPC_CHANNELS as readonly string[]).includes(value);
}

/** API mà preload lộ ra cho renderer qua `window.nsa`. */
export interface NsaBridge {
  invoke<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>>;
}
