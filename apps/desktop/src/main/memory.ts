import { join } from 'node:path';
import type {
  AuditLog,
  ChatService,
  DistillStatus,
  IdentityProvider,
  ImportSource,
  MemoryKind,
  MemoryPatch,
  MemoryTeachInput,
  Policy,
} from '@nsa/core';
import { ChatHistoryImporter, McpHttpServer, MemoryRuntime, MemoryService } from '@nsa/memory';

/**
 * NSA Mem trong app desktop: kho nhớ ở thư mục dữ liệu người dùng (`%APPDATA%\NSA\memory`),
 * server MCP bộ nhớ trên 127.0.0.1, và phần mở rộng cắm vào ChatService.
 */
export async function setupMemory(options: {
  userData: string;
  identity: IdentityProvider;
  policy: Policy;
  audit: AuditLog;
  /** ChatService tạo sau (nó cần runtime làm phần mở rộng) — lấy qua hàm. */
  chat: () => ChatService;
  onChanged: (pending: number) => void;
  onStatus: (status: DistillStatus) => void;
}): Promise<{ runtime: MemoryRuntime; mcp: McpHttpServer | null; close: () => Promise<void> }> {
  let runtime: MemoryRuntime | null = null;
  const service = await MemoryService.open({
    root: join(options.userData, 'memory'),
    identity: options.identity,
    policy: options.policy,
    audit: options.audit,
    onChange: () => options.onChanged(runtime?.service.listProposals('pending').length ?? 0),
  });

  // Mở không được thì vẫn chạy: agent chỉ nhận phần ngữ cảnh tự chèn, không có tool mem_*.
  let mcp: McpHttpServer | null = null;
  try {
    mcp = await McpHttpServer.start({ name: 'nsa_mem', version: '0.2.0', tools: service.tools() });
  } catch (err) {
    console.error('[memory] không mở được server MCP bộ nhớ:', err);
  }

  runtime = new MemoryRuntime({
    service,
    ...(mcp ? { mcp } : {}),
    importer: new ChatHistoryImporter({ conversations: () => options.chat().listConversations() }),
    settingsFile: join(options.userData, 'memory-settings.json'),
    workDir: join(options.userData, 'memory-work'),
    runTask: (request) => options.chat().runTask(request),
    conversations: () => options.chat().listConversations(),
    onStatus: options.onStatus,
  });

  return {
    runtime,
    mcp,
    close: async () => {
      runtime?.dispose();
      await mcp?.close();
      service.close();
    },
  };
}

// ------------------------------------------------------------ Kiểm tham số từ giao diện

const KINDS: MemoryKind[] = ['fact', 'preference', 'rule'];
const SOURCES: ImportSource[] = ['nsa', 'claude', 'codex', 'opencode'];

function text(value: unknown, field: string, max = 20_000): string {
  if (typeof value !== 'string') throw new Error(`Thiếu ${field}`);
  return value.slice(0, max);
}

export function cleanTeach(input: unknown): MemoryTeachInput {
  const r = (input ?? {}) as Record<string, unknown>;
  return {
    branch: text(r['branch'], 'nhánh', 300),
    title: text(r['title'] ?? '', 'tiêu đề', 300),
    body: text(r['body'], 'nội dung'),
    kind: KINDS.includes(r['kind'] as MemoryKind) ? (r['kind'] as MemoryKind) : 'fact',
    ...(typeof r['subject'] === 'string' && r['subject'] ? { subject: r['subject'] } : {}),
    ...(typeof r['confidence'] === 'number' ? { confidence: r['confidence'] } : {}),
    sensitive: r['sensitive'] === true,
    ...(Array.isArray(r['tags']) ? { tags: r['tags'].map(String).slice(0, 20) } : {}),
  };
}

export function cleanPatch(input: unknown): MemoryPatch {
  const r = (input ?? {}) as Record<string, unknown>;
  const patch: MemoryPatch = {};
  if (typeof r['branch'] === 'string') patch.branch = r['branch'].slice(0, 300);
  if (typeof r['title'] === 'string') patch.title = r['title'].slice(0, 300);
  if (typeof r['body'] === 'string') patch.body = r['body'].slice(0, 20_000);
  if (KINDS.includes(r['kind'] as MemoryKind)) patch.kind = r['kind'] as MemoryKind;
  if (typeof r['subject'] === 'string') patch.subject = r['subject'];
  if (typeof r['confidence'] === 'number') patch.confidence = r['confidence'];
  if (typeof r['sensitive'] === 'boolean') patch.sensitive = r['sensitive'];
  if (Array.isArray(r['tags'])) patch.tags = r['tags'].map(String).slice(0, 20);
  return patch;
}

export function cleanSource(value: unknown): ImportSource {
  if (!SOURCES.includes(value as ImportSource)) throw new Error('Nguồn nhập không hợp lệ');
  return value as ImportSource;
}

export function cleanIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Danh sách phiên không hợp lệ');
  return value.map(String).slice(0, 50);
}

export function cleanCommit(value: unknown): string {
  const commit = String(value);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('Mã thay đổi không hợp lệ');
  return commit;
}
