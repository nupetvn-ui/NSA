/**
 * Hợp đồng IPC giữa giao diện (renderer) và lõi NSA (tiến trình main).
 * Mỗi kênh khai báo kiểu tham số và kiểu kết quả; main, preload và renderer
 * đều dùng chung định nghĩa này nên sai kiểu sẽ bị TypeScript bắt ngay.
 */
import type { Conversation } from './chat.js';
import type { AgentInfo, ChatEvent, SendRequest, SendResult } from './chat-service.js';

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

/** Lệnh renderer gọi xuống main (yêu cầu → trả lời). */
export interface IpcContract {
  'core:ping': { args: [message: string]; result: PingResult };
  'app:info': { args: []; result: AppInfo };
  'agents:list': { args: []; result: AgentInfo[] };
  'chat:list': { args: []; result: Conversation[] };
  'chat:send': { args: [request: SendRequest]; result: SendResult };
  'chat:cancel': { args: [turnId: string]; result: void };
  'chat:delete': { args: [conversationId: string]; result: void };
  'dialog:pickFolder': { args: []; result: string | null };
}

/** Sự kiện main đẩy lên renderer. */
export interface IpcEventContract {
  'chat:event': ChatEvent;
}

export type IpcChannel = keyof IpcContract;
export type IpcArgs<C extends IpcChannel> = IpcContract[C]['args'];
export type IpcResult<C extends IpcChannel> = IpcContract[C]['result'];
export type IpcEventChannel = keyof IpcEventContract;

/** Danh sách kênh hợp lệ — preload chỉ cho phép gọi các kênh này. */
export const IPC_CHANNELS = [
  'core:ping',
  'app:info',
  'agents:list',
  'chat:list',
  'chat:send',
  'chat:cancel',
  'chat:delete',
  'dialog:pickFolder',
] as const satisfies readonly IpcChannel[];

export const IPC_EVENT_CHANNELS = ['chat:event'] as const satisfies readonly IpcEventChannel[];

// Bắt lỗi khi khai báo kênh trong contract mà quên thêm vào danh sách ở trên.
type Missing<A, B> = Exclude<A, B> extends never ? true : Exclude<A, B>;
const _allChannelsListed: Missing<IpcChannel, (typeof IPC_CHANNELS)[number]> = true;
const _allEventsListed: Missing<IpcEventChannel, (typeof IPC_EVENT_CHANNELS)[number]> = true;
void _allChannelsListed;
void _allEventsListed;

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && (IPC_CHANNELS as readonly string[]).includes(value);
}

export function isIpcEventChannel(value: unknown): value is IpcEventChannel {
  return typeof value === 'string' && (IPC_EVENT_CHANNELS as readonly string[]).includes(value);
}

/** API mà preload lộ ra cho renderer qua `window.nsa`. */
export interface NsaBridge {
  invoke<C extends IpcChannel>(channel: C, ...args: IpcArgs<C>): Promise<IpcResult<C>>;
  /** Nghe sự kiện từ main; trả về hàm huỷ đăng ký. */
  on<E extends IpcEventChannel>(
    channel: E,
    listener: (payload: IpcEventContract[E]) => void,
  ): () => void;
}
