/**
 * Biến các dòng nhật ký (`AuditEntry`) thành "lượt chạy" xem lại được. Hàm thuần: không đọc file,
 * không biết SQLite — để test dễ và để chỉ mục có thể dựng lại bất cứ lúc nào.
 */
import type {
  AuditEntry,
  TraceKind,
  TraceStatus,
  TraceStep,
  TraceStepKind,
  TraceSummary,
} from '@nsa/core';

/** Giới hạn lưu cho phần nội dung của một bước (ký tự). Dài hơn thì cắt và đánh dấu. */
export const DETAIL_LIMIT = 8_000;
const TITLE_LIMIT = 140;

export interface TraceState {
  summary: TraceSummary;
  /** Văn bản để tìm kiếm (đã gập dấu, chữ thường). */
  search: string;
  /** Số bước đã có — để đánh số tiếp. */
  nextSeq: number;
  /** Đã có câu trả lời của agent (để lượt có lỗi nhỏ nhưng vẫn trả lời được tính là xong). */
  replied: boolean;
}

export type Redact = (text: string) => string;

const SEARCH_LIMIT = 24_000;

/** Gập dấu tiếng Việt + chữ thường: "Khách" khớp "khach". */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function cut(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Khoá gom dòng nhật ký thành một lượt; null nếu dòng này không thuộc Traces. */
export function traceKeyOf(
  entry: AuditEntry,
  standaloneId: () => string,
): { id: string; kind: TraceKind } | null {
  if (entry.turnId) {
    return { id: `t:${entry.turnId}`, kind: entry.conversationId ? 'turn' : 'task' };
  }
  switch (entry.type) {
    case 'plugin':
      // Vòng đời bình thường (cài, bật, tắt, gỡ, cấp quyền, bí mật) không phải "lượt chạy".
      return ['job', 'action', 'model', 'crash', 'denied'].includes(entry.op)
        ? { id: standaloneId(), kind: 'plugin' }
        : null;
    case 'mcp_tool':
      return { id: standaloneId(), kind: entry.source === 'plugin' ? 'plugin' : 'system' };
    case 'budget':
      return { id: standaloneId(), kind: 'system' };
    case 'fallback':
      return entry.kind === 'model' ? { id: standaloneId(), kind: 'system' } : null;
    default:
      return null;
  }
}

export function newState(id: string, kind: TraceKind, entry: AuditEntry): TraceState {
  const summary: TraceSummary = {
    id,
    kind,
    startedAt: entry.at,
    endedAt: entry.at,
    durationMs: 0,
    title: '',
    status: 'running',
    actor: entry.actor.displayName,
    agentId: entry.agentId,
    agentIds: [],
    pluginIds: [],
    ...(entry.conversationId ? { conversationId: entry.conversationId } : {}),
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    errors: 0,
    fallbacks: 0,
    policyFlags: 0,
  };
  return { summary, search: '', nextSeq: 0, replied: false };
}

interface StepInput {
  kind: TraceStepKind;
  title: string;
  detail?: string;
  decision?: 'allow' | 'ask' | 'deny';
  ok?: boolean;
  ms?: number;
}

function addStep(
  state: TraceState,
  entry: AuditEntry,
  input: StepInput,
  redact: Redact,
  out: TraceStep[],
): void {
  let detail = input.detail === undefined ? undefined : redact(input.detail);
  let truncated = false;
  if (detail !== undefined && detail.length > DETAIL_LIMIT) {
    detail = detail.slice(0, DETAIL_LIMIT);
    truncated = true;
  }
  const title = redact(input.title);
  const step: TraceStep = {
    seq: state.nextSeq++,
    at: entry.at,
    kind: input.kind,
    agentId: entry.agentId,
    title,
    ...(detail ? { detail } : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(input.decision ? { decision: input.decision } : {}),
    ...(input.ok === undefined ? {} : { ok: input.ok }),
    ...(input.ms === undefined ? {} : { ms: input.ms }),
  };
  out.push(step);
  if (state.search.length < SEARCH_LIMIT) {
    state.search += `\n${fold(title)} ${detail ? fold(detail.slice(0, 2_000)) : ''}`;
  }
}

function uniquePush(list: string[], value: string | undefined): void {
  if (value && !list.includes(value)) list.push(value);
}

/**
 * Đưa một dòng nhật ký vào trạng thái của lượt; trả về các bước mới sinh ra. Mọi chữ lưu lại đều
 * đi qua `redact` (bộ che key sẵn có) — bí mật không vào được chỉ mục.
 */
export function applyEntry(state: TraceState, entry: AuditEntry, redact: Redact): TraceStep[] {
  const steps: TraceStep[] = [];
  const s = state.summary;
  const add = (input: StepInput): void => addStep(state, entry, input, redact, steps);

  s.endedAt = entry.at;
  s.durationMs = Math.max(0, Date.parse(entry.at) - Date.parse(s.startedAt)) || 0;
  s.agentId = entry.agentId;
  uniquePush(s.agentIds, entry.agentId);
  if (entry.conversationId) s.conversationId = entry.conversationId;
  const teamTaskId = (entry as { teamTaskId?: string }).teamTaskId;
  if (teamTaskId) s.teamTaskId = teamTaskId;

  switch (entry.type) {
    case 'request': {
      s.title = redact(cut(entry.prompt, TITLE_LIMIT));
      s.startedAt = entry.at;
      add({
        kind: 'request',
        title: `${entry.actor.displayName} ra lệnh cho ${entry.agentId}`,
        detail: `${entry.prompt}\n\nThư mục: ${entry.cwd}\nQuyền: ${entry.permission}`,
      });
      break;
    }
    case 'policy': {
      if (entry.decision !== 'allow') s.policyFlags++;
      const what = entry.tool ? `lệnh ${entry.tool.name}` : 'lượt chạy';
      const verb =
        entry.decision === 'allow'
          ? entry.confirmed
            ? 'cho phép (người dùng đã bấm)'
            : 'cho phép'
          : entry.decision === 'ask'
            ? 'hỏi người dùng'
            : 'chặn';
      add({
        kind: 'policy',
        title: `Chính sách ${verb} ${what}`,
        detail: [entry.tool?.input, entry.reason].filter(Boolean).join('\n') || undefined,
        decision: entry.decision,
      } as StepInput);
      if (!entry.tool && s.status === 'running') {
        // Lượt bị chặn / chờ xác nhận ngay từ cổng chạy: sau đó không có sự kiện nào của agent.
        if (entry.decision === 'deny') s.status = 'denied';
        else if (entry.decision === 'ask') s.status = 'cancelled';
      }
      break;
    }
    case 'agent_event': {
      const ev = entry.event;
      switch (ev.type) {
        case 'tool_call':
          s.toolCalls++;
          add({
            kind: 'tool_call',
            title: `Gọi ${ev.name}: ${cut(ev.input, 100)}`,
            detail: ev.input,
          });
          break;
        case 'tool_result':
          add({
            kind: 'tool_result',
            title: ev.isError ? 'Kết quả: lỗi' : 'Kết quả',
            detail: ev.output,
            ok: !ev.isError,
          });
          if (ev.isError) s.errors++;
          break;
        case 'ask_permission':
          add({ kind: 'permission', title: 'Hỏi người dùng', detail: ev.description });
          break;
        case 'permission_result':
          add({
            kind: 'permission',
            title: ev.allowed ? 'Người dùng cho phép' : 'Người dùng từ chối',
            ...(ev.reason ? { detail: ev.reason } : {}),
            ok: ev.allowed,
          });
          break;
        case 'usage': {
          s.inputTokens += Math.max(0, Math.round(ev.inputTokens));
          s.outputTokens += Math.max(0, Math.round(ev.outputTokens));
          if (typeof ev.costUsd === 'number') s.costUsd = (s.costUsd ?? 0) + ev.costUsd;
          add({
            kind: 'usage',
            title: `Token: vào ${ev.inputTokens}, ra ${ev.outputTokens}${
              typeof ev.costUsd === 'number' ? `, ~$${ev.costUsd.toFixed(4)}` : ''
            }`,
          });
          break;
        }
        case 'notice':
          add({ kind: 'notice', title: cut(ev.message, 160), detail: ev.message });
          break;
        case 'error':
          s.errors++;
          add({
            kind: 'error',
            title: `Lỗi: ${cut(ev.message, 140)}`,
            detail: ev.message,
            ok: false,
          });
          break;
        case 'done': {
          s.status = ev.cancelled ? 'cancelled' : s.errors > 0 && !state.replied ? 'error' : 'ok';
          add({ kind: 'done', title: ev.cancelled ? 'Đã dừng' : 'Xong' });
          break;
        }
        case 'session':
          break;
      }
      break;
    }
    case 'reply': {
      state.replied = true;
      add({ kind: 'reply', title: `Trả lời: ${cut(entry.text, 120)}`, detail: entry.text });
      break;
    }
    case 'fallback': {
      s.fallbacks++;
      const label =
        entry.kind === 'tier' ? 'Lùi tầng' : entry.kind === 'agent' ? 'Đổi agent' : 'Đổi model';
      add({
        kind: 'fallback',
        title: `${label}: ${entry.from} → ${entry.to}`,
        detail: entry.reason,
      });
      if (s.kind === 'system') {
        s.title = `${label} ${entry.from} → ${entry.to}`;
        s.status = 'ok';
      }
      break;
    }
    case 'mcp_tool': {
      uniquePush(s.pluginIds, entry.pluginId);
      s.toolCalls++;
      if (entry.decision !== 'allow') s.policyFlags++;
      if (entry.ok === false) s.errors++;
      const verb =
        entry.decision === 'deny'
          ? 'bị chặn'
          : entry.decision === 'ask' && !entry.confirmed
            ? 'bị từ chối'
            : entry.ok === false
              ? 'lỗi'
              : 'chạy';
      add({
        kind: 'mcp_tool',
        title: `Tool ${entry.pluginId ? `${entry.pluginId}.` : ''}${entry.tool} ${verb}`,
        detail: [entry.reason, entry.error].filter(Boolean).join('\n') || undefined,
        decision: entry.decision,
        ...(entry.ok === undefined ? {} : { ok: entry.ok }),
        ...(entry.ms === undefined ? {} : { ms: entry.ms }),
      } as StepInput);
      if (!s.title) s.title = `Tool ${entry.pluginId ?? entry.source}: ${entry.tool}`;
      if (s.kind !== 'turn' && s.kind !== 'task') {
        s.status = entry.decision === 'deny' ? 'denied' : entry.ok === false ? 'error' : 'ok';
        if (entry.ms !== undefined) s.durationMs = entry.ms;
      }
      break;
    }
    case 'plugin': {
      uniquePush(s.pluginIds, entry.pluginId);
      if (entry.decision !== 'allow') s.policyFlags++;
      add({
        kind: 'plugin',
        title: `Plugin ${entry.pluginId}: ${entry.op}`,
        ...(entry.detail ? { detail: entry.detail } : {}),
        decision: entry.decision,
      });
      if (!s.title)
        s.title = `Plugin ${entry.pluginId}: ${entry.op}${entry.detail ? ` — ${cut(entry.detail, 100)}` : ''}`;
      const failed = entry.op === 'crash' || /lỗi/i.test(entry.detail ?? '');
      if (s.kind === 'plugin') {
        s.status =
          entry.decision === 'deny' || entry.op === 'denied' ? 'denied' : failed ? 'error' : 'ok';
        if (failed) s.errors++;
      }
      break;
    }
    case 'budget': {
      add({
        kind: 'budget',
        title: `Hạn mức tháng: ${entry.level === 'over' ? 'vượt' : 'gần chạm'} ($${entry.spentUsd.toFixed(2)} / $${entry.limitUsd.toFixed(2)})`,
      });
      s.title = s.title || `Hạn mức chi phí ${entry.level === 'over' ? 'đã vượt' : 'gần chạm'}`;
      s.status = entry.level === 'over' ? 'error' : 'ok';
      break;
    }
    default:
      break;
  }
  s.title = redact(s.title);
  return steps;
}

export const TERMINAL_STATUSES: TraceStatus[] = ['ok', 'error', 'cancelled', 'denied'];
