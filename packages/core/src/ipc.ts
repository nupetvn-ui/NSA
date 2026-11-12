/**
 * Hợp đồng IPC giữa giao diện (renderer) và lõi NSA (tiến trình main).
 * Mỗi kênh khai báo kiểu tham số và kiểu kết quả; main, preload và renderer
 * đều dùng chung định nghĩa này nên sai kiểu sẽ bị TypeScript bắt ngay.
 */
import type { Conversation } from './chat.js';
import type { AgentInfo, ChatEvent, SendRequest, SendResult } from './chat-service.js';
import type { CliChange } from './cli-watch.js';
import type {
  DistillStatus,
  ImportCandidate,
  ImportSource,
  ImportSourceStatus,
  MemoryBranch,
  MemoryDraft,
  MemoryEntry,
  MemoryHistoryItem,
  MemoryProposal,
  MemorySearchHit,
  MemorySettings,
} from './memory.js';

/** Người dùng dạy trực tiếp (màn hình Bộ nhớ). */
export type MemoryTeachInput = Omit<MemoryDraft, 'source' | 'confidence'> & { confidence?: number };
/** Sửa một mục nhớ / sửa đề xuất trước khi nhận. */
export type MemoryPatch = Partial<Omit<MemoryDraft, 'source'>>;
export type MemoryBranchInput = Partial<Omit<MemoryBranch, 'path' | 'count'>>;

export interface MemoryInfo {
  /** Thư mục kho nhớ trên đĩa. */
  root: string;
  entries: number;
  pending: number;
  /** Có tìm theo vector chưa (giai đoạn 2: chưa). */
  vector: boolean;
  /** Địa chỉ server MCP bộ nhớ, nếu mở được. */
  mcpUrl: string | null;
}

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

/** Trạng thái tự cập nhật, hiển thị trên giao diện. */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string };

/** Lệnh renderer gọi xuống main (yêu cầu → trả lời). */
export interface IpcContract {
  'core:ping': { args: [message: string]; result: PingResult };
  'app:info': { args: []; result: AppInfo };
  'app:updateStatus': { args: []; result: UpdateStatus };
  'app:installUpdate': { args: []; result: void };
  'agents:list': { args: []; result: AgentInfo[] };
  'chat:list': { args: []; result: Conversation[] };
  'chat:send': { args: [request: SendRequest]; result: SendResult };
  'chat:cancel': { args: [turnId: string]; result: void };
  'chat:delete': { args: [conversationId: string]; result: void };
  /** Người dùng trả lời yêu cầu cho phép một lệnh giữa lượt. */
  'chat:answerPermission': { args: [permissionId: string, allowed: boolean]; result: void };
  /** Các CLI thay đổi so với lần khởi động trước (phiên bản, --help). */
  'agents:changes': { args: []; result: CliChange[] };
  'dialog:pickFolder': { args: []; result: string | null };
  // ---- NSA Mem ----
  'mem:info': { args: []; result: MemoryInfo };
  'mem:branches': { args: []; result: MemoryBranch[] };
  'mem:saveBranch': { args: [path: string, input: MemoryBranchInput]; result: MemoryBranch };
  'mem:list': { args: [branch?: string]; result: MemoryEntry[] };
  'mem:search': { args: [query: string]; result: MemorySearchHit[] };
  'mem:teach': { args: [input: MemoryTeachInput]; result: MemoryEntry };
  'mem:update': { args: [id: string, patch: MemoryPatch]; result: MemoryEntry };
  'mem:delete': { args: [id: string]; result: void };
  'mem:history': { args: [entryId?: string]; result: MemoryHistoryItem[] };
  'mem:undo': { args: [commit: string]; result: MemoryHistoryItem };
  'mem:proposals': { args: [status?: MemoryProposal['status']]; result: MemoryProposal[] };
  'mem:accept': { args: [proposalId: string, edits?: MemoryPatch]; result: MemoryEntry };
  'mem:reject': { args: [proposalId: string]; result: void };
  'mem:reindex': { args: []; result: number };
  'mem:settings': { args: []; result: MemorySettings };
  'mem:saveSettings': { args: [patch: Partial<MemorySettings>]; result: MemorySettings };
  'mem:status': { args: []; result: DistillStatus | null };
  /** Chắt lọc ngay một cuộc trò chuyện NSA thành đề xuất ghi nhớ. */
  'mem:distill': { args: [conversationId: string]; result: MemoryProposal[] };
  'mem:importSources': { args: []; result: ImportSourceStatus[] };
  'mem:importList': { args: [source: ImportSource]; result: ImportCandidate[] };
  /** Chỉ chạy khi người dùng bấm, sau khi đã xem trước danh sách. */
  'mem:import': { args: [source: ImportSource, ids: string[]]; result: MemoryProposal[] };
  'mem:openFolder': { args: []; result: void };
}

/** Sự kiện main đẩy lên renderer. */
export interface IpcEventContract {
  'chat:event': ChatEvent;
  'app:update': UpdateStatus;
  'agents:changes': CliChange[];
  /** Bộ nhớ hoặc hộp duyệt vừa thay đổi. */
  'mem:changed': { pending: number };
  'mem:status': DistillStatus;
}

export type IpcChannel = keyof IpcContract;
export type IpcArgs<C extends IpcChannel> = IpcContract[C]['args'];
export type IpcResult<C extends IpcChannel> = IpcContract[C]['result'];
export type IpcEventChannel = keyof IpcEventContract;

/** Danh sách kênh hợp lệ — preload chỉ cho phép gọi các kênh này. */
export const IPC_CHANNELS = [
  'core:ping',
  'app:info',
  'app:updateStatus',
  'app:installUpdate',
  'agents:list',
  'chat:list',
  'chat:send',
  'chat:cancel',
  'chat:delete',
  'chat:answerPermission',
  'agents:changes',
  'dialog:pickFolder',
  'mem:info',
  'mem:branches',
  'mem:saveBranch',
  'mem:list',
  'mem:search',
  'mem:teach',
  'mem:update',
  'mem:delete',
  'mem:history',
  'mem:undo',
  'mem:proposals',
  'mem:accept',
  'mem:reject',
  'mem:reindex',
  'mem:settings',
  'mem:saveSettings',
  'mem:status',
  'mem:distill',
  'mem:importSources',
  'mem:importList',
  'mem:import',
  'mem:openFolder',
] as const satisfies readonly IpcChannel[];

export const IPC_EVENT_CHANNELS = [
  'chat:event',
  'app:update',
  'agents:changes',
  'mem:changed',
  'mem:status',
] as const satisfies readonly IpcEventChannel[];

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
