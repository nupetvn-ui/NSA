import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  TraceDetail,
  TraceFilters,
  TraceIndexStatus,
  TraceKind,
  TraceQuery,
  TraceStatus,
  TraceStep,
  TraceSummary,
} from '@nsa/core';
import './traces.css';

const STATUS_LABEL: Record<TraceStatus, string> = {
  running: 'Đang chạy',
  ok: 'Xong',
  error: 'Lỗi',
  cancelled: 'Đã dừng',
  denied: 'Bị chặn',
};

const KIND_LABEL: Record<TraceKind, string> = {
  turn: 'Chat',
  task: 'Việc nền',
  plugin: 'Plugin',
  system: 'Hệ thống',
};

const STEP_ICON: Record<TraceStep['kind'], string> = {
  request: '▶',
  policy: '⚖',
  tool_call: '🔧',
  tool_result: '↩',
  permission: '✋',
  usage: '∑',
  notice: 'ℹ',
  error: '⚠',
  fallback: '⤵',
  mcp_tool: '🧩',
  plugin: '🧩',
  reply: '💬',
  done: '■',
  budget: '$',
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('vi-VN')} ${d.toLocaleTimeString('vi-VN')}`;
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 90 ? `${s.toFixed(1)} giây` : `${Math.round(s / 60)} phút`;
}

function fmtCost(cost: number | null): string {
  return cost === null ? '—' : `~$${cost.toFixed(cost < 0.01 ? 4 : 2)}`;
}

/** Ngày hôm nay theo UTC, `YYYY-MM-DD` — khớp cách nhật ký chia theo ngày. */
function today(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export function TracesView({
  initialTeamTaskId,
  onClose,
}: {
  /** Mở sẵn lọc theo một việc của đội (từ bảng việc nhảy sang). */
  initialTeamTaskId?: string;
  onClose?: () => void;
}) {
  const [items, setItems] = useState<TraceSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState<TraceFilters>({ agents: [], plugins: [] });
  const [status, setStatus] = useState<TraceIndexStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [agentId, setAgentId] = useState('');
  const [pluginId, setPluginId] = useState('');
  const [state, setState] = useState<'' | TraceStatus>('');
  const [kind, setKind] = useState<'' | TraceKind>('');
  const [range, setRange] = useState<'today' | '7d' | 'all'>('7d');
  const [limit, setLimit] = useState(100);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const query = useCallback((): TraceQuery => {
    return {
      ...(range === 'today' ? { from: today() } : range === '7d' ? { from: today(-6) } : {}),
      ...(agentId ? { agentId } : {}),
      ...(pluginId ? { pluginId } : {}),
      ...(state ? { status: state } : {}),
      ...(kind ? { kind } : {}),
      ...(text.trim() ? { text: text.trim() } : {}),
      ...(initialTeamTaskId ? { teamTaskId: initialTeamTaskId } : {}),
      limit,
    };
  }, [range, agentId, pluginId, state, kind, text, limit, initialTeamTaskId]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const [list, f, s] = await Promise.all([
        window.nsa.invoke('traces:list', query()),
        window.nsa.invoke('traces:filters'),
        window.nsa.invoke('traces:status'),
      ]);
      if (mine !== seq.current) return;
      setItems(list.items);
      setTotal(list.total);
      setFilters(f);
      setStatus(s);
      setError(null);
    } catch (err) {
      if (mine === seq.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [query]);

  // Tìm chữ: chờ người dùng gõ xong mới hỏi.
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), text ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [load, text]);

  // Có lượt đang chạy hoặc chỉ mục đang dựng: làm mới đều để theo dõi trực tiếp.
  const live = items.some((i) => i.status === 'running') || status?.state === 'indexing';
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void load(), 2500);
    return () => window.clearInterval(timer);
  }, [live, load]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    void window.nsa.invoke('traces:get', selected).then((d) => {
      if (!cancelled) setDetail(d);
    });
    return () => {
      cancelled = true;
    };
  }, [selected, items]);

  async function reindex(): Promise<void> {
    setLoading(true);
    try {
      await window.nsa.invoke('traces:reindex');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await load();
  }

  return (
    <main className="chat traces">
      <header className="chat-head drag mem-head">
        <h1 className="chat-title">Traces</h1>
        <div className="chat-sub">
          <span>
            Xem lại từng lượt chạy: ai ra lệnh, agent nào, gọi tool gì, chính sách quyết ra sao
            {status?.monthCostUsd != null
              ? ` · chi phí tháng này ${fmtCost(status.monthCostUsd)}`
              : ''}
          </span>
          {onClose && (
            <button type="button" className="link-btn" onClick={onClose}>
              Đóng
            </button>
          )}
        </div>
      </header>

      <div className="mem-toolbar traces-filters">
        <input
          type="search"
          className="traces-search"
          placeholder="Tìm theo chữ (lệnh, tool, kết quả, lỗi)…"
          aria-label="Tìm trong Traces"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <select
          aria-label="Khoảng ngày"
          value={range}
          onChange={(e) => setRange(e.target.value as typeof range)}
        >
          <option value="today">Hôm nay</option>
          <option value="7d">7 ngày qua</option>
          <option value="all">Tất cả</option>
        </select>
        <select
          aria-label="Lọc theo agent"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
        >
          <option value="">Mọi agent</option>
          {filters.agents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select
          aria-label="Lọc theo plugin"
          value={pluginId}
          onChange={(e) => setPluginId(e.target.value)}
        >
          <option value="">Mọi plugin</option>
          {filters.plugins.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          aria-label="Lọc theo trạng thái"
          value={state}
          onChange={(e) => setState(e.target.value as '' | TraceStatus)}
        >
          <option value="">Mọi trạng thái</option>
          {(Object.keys(STATUS_LABEL) as TraceStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select
          aria-label="Lọc theo loại"
          value={kind}
          onChange={(e) => setKind(e.target.value as '' | TraceKind)}
        >
          <option value="">Mọi loại</option>
          {(Object.keys(KIND_LABEL) as TraceKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button type="button" className="push-btn" onClick={() => void load()}>
          Làm mới
        </button>
        <button
          type="button"
          className="push-btn"
          onClick={() => void reindex()}
          title="Dựng lại chỉ mục từ file nhật ký gốc"
        >
          Dựng lại chỉ mục
        </button>
      </div>

      {error && (
        <p className="error-line" role="alert">
          {error}
        </p>
      )}
      {status?.state === 'indexing' && (
        <p className="hint pad">Đang dựng chỉ mục từ nhật ký… ({status.traces} lượt đã có)</p>
      )}

      <div className="traces-body">
        <section className="traces-list" aria-label="Danh sách lượt chạy">
          {loading && items.length === 0 && <p className="hint pad">Đang tải…</p>}
          {!loading && items.length === 0 && (
            <p className="hint pad">Chưa có lượt chạy nào khớp bộ lọc.</p>
          )}
          {items.map((t) => (
            <button
              type="button"
              key={t.id}
              className={`trace-row ${t.id === selected ? 'active' : ''}`}
              onClick={() => setSelected(t.id)}
            >
              <span className={`trace-dot ${t.status}`} title={STATUS_LABEL[t.status]} />
              <span className="trace-main">
                <span className="trace-title">{t.title || '(không có tiêu đề)'}</span>
                <span className="trace-meta">
                  {KIND_LABEL[t.kind]} · {t.agentIds.join(' → ') || t.agentId} ·{' '}
                  {fmtTime(t.startedAt)}
                </span>
              </span>
              <span className="trace-num">
                {fmtDuration(t.durationMs)}
                <br />
                {t.inputTokens + t.outputTokens > 0
                  ? `${t.inputTokens + t.outputTokens} token`
                  : ''}
              </span>
            </button>
          ))}
          {items.length < total && (
            <button type="button" className="push-btn" onClick={() => setLimit(limit + 100)}>
              Xem thêm ({total - items.length} lượt nữa)
            </button>
          )}
        </section>

        <section className="traces-detail" aria-label="Chi tiết lượt chạy">
          {(!detail || detail.id !== selected) && (
            <p className="hint pad">Chọn một lượt để xem từng bước.</p>
          )}
          {detail && detail.id === selected && <TraceDetailView detail={detail} />}
        </section>
      </div>
    </main>
  );
}

function TraceDetailView({ detail }: { detail: TraceDetail }) {
  return (
    <div className="trace-detail">
      <h2 className="trace-detail-title">{detail.title || '(không có tiêu đề)'}</h2>
      <dl className="trace-facts">
        <div>
          <dt>Trạng thái</dt>
          <dd className={`status-${detail.status}`}>{STATUS_LABEL[detail.status]}</dd>
        </div>
        <div>
          <dt>Ai ra lệnh</dt>
          <dd>{detail.actor}</dd>
        </div>
        <div>
          <dt>Agent</dt>
          <dd>{detail.agentIds.join(' → ') || detail.agentId}</dd>
        </div>
        <div>
          <dt>Thời lượng</dt>
          <dd>{fmtDuration(detail.durationMs)}</dd>
        </div>
        <div>
          <dt>Token (vào / ra)</dt>
          <dd>
            {detail.inputTokens} / {detail.outputTokens}
          </dd>
        </div>
        <div>
          <dt>Chi phí ước tính</dt>
          <dd>{fmtCost(detail.costUsd)}</dd>
        </div>
        <div>
          <dt>Tool đã gọi</dt>
          <dd>{detail.toolCalls}</dd>
        </div>
        <div>
          <dt>Lùi tầng / đổi agent</dt>
          <dd>{detail.fallbacks}</dd>
        </div>
      </dl>
      <ol className="trace-steps">
        {detail.steps.map((step) => (
          <StepRow key={step.seq} step={step} />
        ))}
      </ol>
    </div>
  );
}

const PREVIEW = 160;

function StepRow({ step }: { step: TraceStep }) {
  const [open, setOpen] = useState(false);
  const long = (step.detail?.length ?? 0) > PREVIEW || (step.detail?.includes('\n') ?? false);
  const tone =
    step.decision === 'deny' || step.ok === false || step.kind === 'error'
      ? 'bad'
      : step.decision === 'ask'
        ? 'warn'
        : step.kind === 'fallback'
          ? 'warn'
          : '';
  return (
    <li className={`trace-step ${tone}`}>
      <span className="trace-step-icon" aria-hidden="true">
        {STEP_ICON[step.kind]}
      </span>
      <div className="trace-step-body">
        <div className="trace-step-title">
          <span>{step.title}</span>
          <time dateTime={step.at}>{new Date(step.at).toLocaleTimeString('vi-VN')}</time>
        </div>
        {step.detail && (
          <>
            <pre className="trace-step-detail">
              {open || !long ? step.detail : `${step.detail.slice(0, PREVIEW)}…`}
            </pre>
            {long && (
              <button type="button" className="link-btn" onClick={() => setOpen(!open)}>
                {open ? 'Thu gọn' : 'Mở rộng'}
              </button>
            )}
            {step.truncated && open && (
              <span className="hint"> (đã cắt bớt khi lưu — nội dung quá dài)</span>
            )}
          </>
        )}
      </div>
    </li>
  );
}
