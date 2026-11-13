/**
 * Chạy một việc theo loại (việc nền, nhìn ảnh, kênh chat, embedding…) bằng chuỗi model
 * chính + dự phòng (ADR-0009). Mỗi lần chọn hãng đều hỏi ổ cắm chính sách (`model.use`);
 * hãng lỗi / hết hạn mức thì chuyển sang model kế tiếp, báo người dùng và ghi nhật ký.
 *
 * Lõi không biết file dữ liệu hãng: danh sách ứng viên do bên ngoài (ProviderHub) cung cấp.
 */
import { tmpdir } from 'node:os';
import type { AgentAdapter, AgentEvent } from '@nsa/adapter-sdk';
import type { AuditEntry, AuditLog, IdentityProvider, Policy, PolicyDecision } from './sockets.js';

export interface ModelCandidate {
  /** Mã agent (ví dụ `api:deepseek/deepseek-flash`). */
  agentId: string;
  providerId: string;
  model: string;
  /** Tên hiển thị trong thông báo. */
  label: string;
  paid: boolean;
}

export interface TaskAttemptError {
  agentId: string;
  message: string;
}

export interface TaskOutcome<T> {
  value: T;
  candidate: ModelCandidate;
  /** Thông báo cho người dùng (đã chuyển model dự phòng…). */
  notices: string[];
  failures: TaskAttemptError[];
}

export class ModelTaskError extends Error {
  readonly failures: TaskAttemptError[];
  constructor(message: string, failures: TaskAttemptError[]) {
    super(message);
    this.name = 'ModelTaskError';
    this.failures = failures;
  }
}

export interface ModelTaskRunnerOptions {
  identity: IdentityProvider;
  policy: Policy;
  audit?: AuditLog;
  /** Ứng viên theo thứ tự cho một loại việc. */
  candidates: (task: string) => (ModelCandidate & { adapter?: AgentAdapter })[];
  /** Mỗi lần dùng xong một model (để ghi chi phí). */
  onUsage?: (
    candidate: ModelCandidate,
    usage: { inputTokens: number; outputTokens: number; costUsd?: number },
  ) => void;
  /** Thông báo cho người dùng (đổi model dự phòng, bị chính sách chặn). */
  onNotice?: (message: string) => void;
  now?: () => Date;
}

type AuditBody = AuditEntry extends infer E
  ? E extends AuditEntry
    ? Omit<E, 'at' | 'actor'>
    : never
  : never;

export class ModelTaskRunner {
  readonly #o: ModelTaskRunnerOptions;

  constructor(options: ModelTaskRunnerOptions) {
    this.#o = options;
  }

  #log(body: AuditBody): void {
    if (!this.#o.audit) return;
    const actor = this.#o.identity.current();
    try {
      this.#o.audit.record({
        ...body,
        at: (this.#o.now?.() ?? new Date()).toISOString(),
        actor: { id: actor.id, displayName: actor.displayName },
      } as AuditEntry);
    } catch (err) {
      console.error('[audit] không ghi được nhật ký:', err);
    }
  }

  async #allowed(task: string, c: ModelCandidate): Promise<PolicyDecision> {
    let verdict: PolicyDecision;
    try {
      verdict = await this.#o.policy.check({
        actor: this.#o.identity.current(),
        action: {
          kind: 'model.use',
          agentId: c.agentId,
          providerId: c.providerId,
          model: c.model,
          task,
          paid: c.paid,
        },
        confirmed: false,
      });
    } catch (err) {
      verdict = { decision: 'deny', reason: `Lỗi khi kiểm chính sách: ${String(err)}` };
    }
    this.#log({
      agentId: c.agentId,
      type: 'policy',
      decision: verdict.decision,
      confirmed: false,
      ...(verdict.decision === 'allow' ? {} : { reason: verdict.reason }),
    });
    return verdict;
  }

  /**
   * Thử lần lượt từng ứng viên với `exec`. Ném lỗi `ModelTaskError` khi không ứng viên nào xong.
   * `exec` ném lỗi = ứng viên hỏng (chuyển sang ứng viên kế tiếp).
   */
  async runWith<T, C extends ModelCandidate>(
    task: string,
    candidates: C[],
    exec: (candidate: C, signal: AbortSignal | undefined) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<TaskOutcome<T>> {
    const notices: string[] = [];
    const failures: TaskAttemptError[] = [];
    const notice = (message: string): void => {
      notices.push(message);
      this.#o.onNotice?.(message);
    };
    let previous: C | undefined;
    for (const candidate of candidates) {
      if (signal?.aborted) break;
      // "Hỏi" không có người trả lời ở việc nền → coi như không được dùng.
      const verdict = await this.#allowed(task, candidate);
      if (verdict.decision !== 'allow') {
        failures.push({ agentId: candidate.agentId, message: `chính sách: ${verdict.reason}` });
        continue;
      }
      if (previous) {
        const reason = failures.at(-1)?.message ?? 'lỗi';
        this.#log({
          agentId: previous.agentId,
          type: 'fallback',
          kind: 'model',
          from: previous.agentId,
          to: candidate.agentId,
          reason,
        });
        notice(
          `${previous.label} không dùng được (${reason.split('\n')[0]}). Chuyển sang ${candidate.label}.`,
        );
      }
      previous = candidate;
      try {
        const value = await exec(candidate, signal);
        return { value, candidate, notices, failures };
      } catch (err) {
        failures.push({
          agentId: candidate.agentId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const detail = failures.map((f) => `${f.agentId}: ${f.message.split('\n')[0]}`).join('; ');
    throw new ModelTaskError(
      candidates.length === 0
        ? `Chưa có model nào cho việc "${task}". Mở Nhà cung cấp để thêm key.`
        : `Không model nào chạy được việc "${task}": ${detail}`,
      failures,
    );
  }

  /** Việc dạng văn bản (chắt lọc, tóm tắt, trả lời kênh chat): chạy qua adapter, lấy văn bản. */
  async runText(
    task: string,
    prompt: string,
    options: { signal?: AbortSignal; cwd?: string } = {},
  ): Promise<TaskOutcome<string>> {
    const candidates = this.#o
      .candidates(task)
      .filter((c): c is ModelCandidate & { adapter: AgentAdapter } => c.adapter !== undefined);
    this.#log({
      agentId: candidates[0]?.agentId ?? 'none',
      type: 'request',
      prompt,
      cwd: options.cwd ?? '',
      permission: 'read-only',
    });
    return this.runWith(
      task,
      candidates,
      (candidate, signal) =>
        new Promise<string>((resolve, reject) => {
          let text = '';
          const errors: string[] = [];
          const run = candidate.adapter.run(
            { prompt, cwd: options.cwd ?? tmpdir(), permission: 'read-only' },
            (event: AgentEvent) => {
              if (event.type === 'text') text += event.text;
              else if (event.type === 'error') errors.push(event.message);
              else if (event.type === 'usage') this.#o.onUsage?.(candidate, event);
              if (event.type !== 'text') {
                this.#log({ agentId: candidate.agentId, type: 'agent_event', event });
              }
            },
          );
          const onAbort = (): void => run.cancel();
          signal?.addEventListener('abort', onAbort, { once: true });
          void run.finished.then(() => {
            signal?.removeEventListener('abort', onAbort);
            if (text.trim()) {
              this.#log({ agentId: candidate.agentId, type: 'reply', text });
              resolve(text);
            } else {
              reject(new Error(errors.join('; ') || 'model không trả lời'));
            }
          });
        }),
      options.signal,
    );
  }
}
