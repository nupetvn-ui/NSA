/**
 * Nối NSA Mem vào ChatService (phần mở rộng `ChatExtension` của lõi):
 * - chèn ngữ cảnh bộ nhớ vào đầu mỗi lượt;
 * - báo cho agent hỗ trợ MCP rằng có tool mem_search / mem_read / mem_propose (chính các tool
 *   nằm ở cổng MCP chung của NSA — `@nsa/mcp-gateway`);
 * - theo dõi ngưỡng và giao agent chắt lọc đoạn chat thành đề xuất vào hộp duyệt;
 * - nhập lịch sử chat khi người dùng bấm.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DEFAULT_MEMORY_SETTINGS,
  type ChatExtension,
  type Conversation,
  type DistillStatus,
  type ImportSource,
  type MemoryContext,
  type MemoryProposal,
  type MemorySettings,
  type TaskRequest,
  type TaskResult,
  type Turn,
} from '@nsa/core';
import {
  DistillScheduler,
  buildDistillPrompt,
  conversationTranscript,
  parseDistillOutput,
  type DistillReason,
  type Transcript,
} from './distill.js';
import type { ChatHistoryImporter } from './importers.js';
import type { MemoryService } from './service.js';

export interface MemoryRuntimeOptions {
  service: MemoryService;
  /**
   * Tool `mem_*` có đang được lộ cho agent qua cổng MCP không (cổng mở không được thì false:
   * agent chỉ nhận phần ngữ cảnh tự chèn, không được báo là có tool).
   */
  toolsAvailable?: () => boolean;
  importer: ChatHistoryImporter;
  /** File cấu hình bộ nhớ (ngưỡng chắt lọc…). */
  settingsFile: string;
  /** Thư mục trống cho agent chắt lọc chạy (chỉ đọc). */
  workDir: string;
  runTask: (request: TaskRequest) => Promise<TaskResult>;
  conversations: () => Conversation[];
  onStatus?: (status: DistillStatus) => void;
  now?: () => Date;
}

const REASONS: Record<DistillReason, string> = {
  correction: 'người dùng sửa lỗi agent',
  teach: 'người dùng dặn nhớ',
  turns: 'đủ số lượt',
  idle: 'cuộc trò chuyện đã kết thúc',
  manual: 'người dùng bấm',
};

export class MemoryRuntime implements ChatExtension {
  readonly service: MemoryService;
  readonly importer: ChatHistoryImporter;
  readonly #options: MemoryRuntimeOptions;
  readonly #scheduler: DistillScheduler;
  #settings: MemorySettings;
  #progress: Record<string, number>;
  #status: DistillStatus | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: MemoryRuntimeOptions) {
    this.#options = options;
    this.service = options.service;
    this.importer = options.importer;
    this.#settings = loadSettings(options.settingsFile);
    this.#progress = this.#loadProgress();
    this.#scheduler = new DistillScheduler({
      settings: () => this.#settings.distill,
      progress: () => this.#progress,
      onTrigger: (id, reason) => void this.distillConversation(id, reason).catch(() => undefined),
    });
  }

  // ------------------------------------------------------------ Cấu hình

  settings(): MemorySettings {
    return structuredClone(this.#settings);
  }

  saveSettings(patch: Partial<MemorySettings>): MemorySettings {
    this.#settings = normalizeSettings({
      ...this.#settings,
      ...patch,
      distill: { ...this.#settings.distill, ...(patch.distill ?? {}) },
      inject: { ...this.#settings.inject, ...(patch.inject ?? {}) },
    });
    writeJson(this.#options.settingsFile, this.#settings);
    return this.settings();
  }

  status(): DistillStatus | null {
    return this.#status;
  }

  #setStatus(status: Omit<DistillStatus, 'at'>): void {
    this.#status = { ...status, at: (this.#options.now ?? (() => new Date()))().toISOString() };
    this.#options.onStatus?.(this.#status);
  }

  // ------------------------------------------------------------ ChatExtension

  contextFor(input: { prompt: string; mcp: boolean }): MemoryContext | null {
    if (!this.#settings.inject.enabled) return null;
    return this.service.contextFor(input.prompt, {
      maxChars: this.#settings.inject.maxChars,
      tools: input.mcp && this.#settings.agentTools && (this.#options.toolsAvailable?.() ?? true),
    });
  }

  /** Tool `mem_*` có nên lộ cho agent không (người dùng có thể tắt trong màn hình Bộ nhớ). */
  get agentToolsEnabled(): boolean {
    return this.#settings.agentTools;
  }

  turnStarted(conversation: Conversation): void {
    this.#scheduler.turnStarted(conversation.id);
  }

  turnFinished(conversation: Conversation, turn: Turn): void {
    if (turn.status === 'cancelled') return;
    this.#scheduler.turnFinished(conversation);
  }

  // ------------------------------------------------------------ Chắt lọc

  #progressFile(): string {
    return join(this.service.root, '.nsa', 'distill-progress.json');
  }

  #loadProgress(): Record<string, number> {
    try {
      const data = JSON.parse(readFileSync(this.#progressFile(), 'utf8')) as unknown;
      return typeof data === 'object' && data !== null ? (data as Record<string, number>) : {};
    } catch {
      return {};
    }
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Chắt lọc các lượt chưa chắt lọc của một cuộc trò chuyện NSA. */
  distillConversation(
    conversationId: string,
    reason: DistillReason = 'manual',
  ): Promise<MemoryProposal[]> {
    return this.#serial(async () => {
      const conversation = this.#options.conversations().find((c) => c.id === conversationId);
      if (!conversation) throw new Error('Không tìm thấy cuộc trò chuyện');
      const done = conversation.turns.filter((t) => t.status !== 'running');
      // Bấm tay thì chắt lọc lại cả cuộc trò chuyện; tự động thì chỉ phần mới.
      const from = reason === 'manual' ? 0 : (this.#progress[conversationId] ?? 0);
      if (done.length <= from) return [];
      const transcript = conversationTranscript({ ...conversation, turns: done }, from);
      const proposals = await this.#distill(
        transcript,
        'distill',
        `Chắt lọc "${conversation.title}" (${REASONS[reason]})`,
      );
      this.#progress[conversationId] = done.length;
      writeJson(this.#progressFile(), this.#progress);
      return proposals;
    });
  }

  /** Nhập các phiên đã chọn (sau khi người dùng xem trước và bấm). */
  importSessions(source: ImportSource, ids: string[]): Promise<MemoryProposal[]> {
    return this.#serial(async () => {
      const all: MemoryProposal[] = [];
      for (const [i, id] of ids.entries()) {
        const transcript = this.importer.transcript(source, id);
        all.push(
          ...(await this.#distill(
            transcript,
            'import',
            `Nhập ${i + 1}/${ids.length}: "${transcript.title}"`,
          )),
        );
      }
      return all;
    });
  }

  async #distill(
    transcript: Transcript,
    kind: 'distill' | 'import',
    label: string,
  ): Promise<MemoryProposal[]> {
    this.#setStatus({ running: true, label });
    try {
      if (transcript.messages.length === 0) {
        this.#setStatus({ running: false, label, proposals: 0 });
        return [];
      }
      const prompt = buildDistillPrompt(
        transcript,
        this.service.listBranches(),
        this.service.listEntries(),
      );
      mkdirSync(this.#options.workDir, { recursive: true });
      const result = await this.#options.runTask({
        agentId: this.#settings.distill.agentId || 'auto',
        prompt,
        cwd: this.#options.workDir,
        purpose: kind === 'import' ? 'nhập lịch sử chat vào bộ nhớ' : 'chắt lọc bộ nhớ',
      });
      const drafts = parseDistillOutput(result.text, {
        kind,
        agentId: result.agentId,
        ref: transcript.ref,
      });
      const proposals: MemoryProposal[] = [];
      for (const draft of drafts) {
        try {
          proposals.push(await this.service.propose(draft));
        } catch (err) {
          console.error('[memory] bỏ qua đề xuất lỗi:', err);
        }
      }
      this.#setStatus({ running: false, label, proposals: proposals.length });
      return proposals;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.#setStatus({ running: false, label, error });
      throw err;
    }
  }

  dispose(): void {
    this.#scheduler.dispose();
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function normalizeSettings(raw: Partial<MemorySettings> | undefined): MemorySettings {
  const d = DEFAULT_MEMORY_SETTINGS;
  const distill = { ...d.distill, ...(raw?.distill ?? {}) };
  const inject = { ...d.inject, ...(raw?.inject ?? {}) };
  return {
    distill: {
      enabled: distill.enabled !== false,
      agentId: typeof distill.agentId === 'string' && distill.agentId ? distill.agentId : 'auto',
      everyTurns: clampInt(distill.everyTurns, 0, 100, d.distill.everyTurns),
      idleMinutes: clampInt(distill.idleMinutes, 0, 24 * 60, d.distill.idleMinutes),
      onCorrection: distill.onCorrection !== false,
      onTeach: distill.onTeach !== false,
    },
    inject: {
      enabled: inject.enabled !== false,
      maxChars: clampInt(inject.maxChars, 500, 20_000, d.inject.maxChars),
    },
    agentTools: raw?.agentTools !== false,
  };
}

function loadSettings(file: string): MemorySettings {
  try {
    return normalizeSettings(JSON.parse(readFileSync(file, 'utf8')) as Partial<MemorySettings>);
  } catch {
    return normalizeSettings(undefined);
  }
}
