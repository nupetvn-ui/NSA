import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import {
  AUTO_AGENT,
  type AppInfo,
  type DistillStatus,
  type PermissionLevel,
  type SendRequest,
} from '@nsa/core';
import { AgentsPanel } from './AgentsPanel';
import logo from '../../../resources/icon.png';
import { ConfirmSheet } from './ConfirmSheet';
import { ProvidersScreen } from './ProvidersScreen';
import { MemoryView } from './MemoryView';
import { StoreView } from './StoreView';
import { TurnView } from './TurnView';
import { UpdateBanner } from './UpdateBanner';
import { VendorLogo, vendorOfAgent } from './VendorLogo';
import { useChat } from './useChat';

export function App() {
  const {
    conversations,
    agents,
    checkingAgents,
    checkAgents,
    cliChanges,
    dismissChanges,
    send,
    cancel,
    answerPermission,
    remove,
  } = useChat();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  /** Agent người dùng bấm chọn; chưa chọn thì dùng agent đầu tiên đã sẵn sàng. */
  const [chosenAgentId, setAgentId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [newCwd, setNewCwd] = useState<string | null>(null);
  const [newPermission, setNewPermission] = useState<PermissionLevel>('read-only');
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  /** Yêu cầu đang chờ người dùng xác nhận (chính sách trả lời "hỏi"). */
  const [confirm, setConfirm] = useState<{ reason: string; request: SendRequest } | null>(null);
  const [view, setView] = useState<'chat' | 'memory' | 'providers' | 'store'>('chat');
  /** Số đề xuất ghi nhớ chờ duyệt + bộ đếm để màn hình Bộ nhớ tải lại. */
  const [memPending, setMemPending] = useState(0);
  const [memVersion, setMemVersion] = useState(0);
  const [memStatus, setMemStatus] = useState<DistillStatus | null>(null);
  const [distilling, setDistilling] = useState(false);
  /** Cảnh báo hạn mức chi phí / chuyển model dự phòng ở việc nền. */
  const [providerAlert, setProviderAlert] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void window.nsa.invoke('app:info').then(setInfo);
    void window.nsa.invoke('mem:info').then((i) => setMemPending(i.pending));
    void window.nsa.invoke('mem:status').then(setMemStatus);
    const offChanged = window.nsa.on('mem:changed', ({ pending }) => {
      setMemPending(pending);
      setMemVersion((v) => v + 1);
    });
    const offStatus = window.nsa.on('mem:status', setMemStatus);
    return () => {
      offChanged();
      offStatus();
    };
  }, []);

  // Thêm / xoá key, bật cặp CLI → danh sách agent trong chat đổi.
  useEffect(() => {
    const offChanged = window.nsa.on('providers:changed', () => void checkAgents());
    const offBudget = window.nsa.on('providers:budget', (a) =>
      setProviderAlert(
        a.level === 'over'
          ? `Đã vượt hạn mức chi phí tháng: ước tính ${a.spentUsd.toFixed(2)} / ${a.limitUsd} USD.`
          : `Sắp chạm hạn mức chi phí tháng: ước tính ${a.spentUsd.toFixed(2)} / ${a.limitUsd} USD.`,
      ),
    );
    const offNotice = window.nsa.on('providers:notice', setProviderAlert);
    return () => {
      offChanged();
      offBudget();
      offNotice();
    };
  }, [checkAgents]);

  /** Chắt lọc ngay cuộc trò chuyện đang mở thành đề xuất ghi nhớ. */
  async function distillActive() {
    if (!active || distilling) return;
    setDistilling(true);
    setSendError(null);
    try {
      await window.nsa.invoke('mem:distill', active.id);
    } catch (err) {
      setSendError(cleanError(err));
    } finally {
      setDistilling(false);
    }
  }

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const lastAgentId = active?.turns.at(-1)?.agentId;
  const agentId =
    chosenAgentId ??
    (agents?.find((a) => a.id === lastAgentId)?.ready ? lastAgentId : undefined) ??
    agents?.find((a) => a.ready)?.id ??
    agents?.[0]?.id ??
    'claude';

  const runningTurn = active?.turns.find((t) => t.status === 'running');
  const names = useMemo(
    () => Object.fromEntries((agents ?? []).map((a) => [a.id, a.name])),
    [agents],
  );
  const selectedAgent = agents?.find((a) => a.id === agentId);
  /** Model gọi thẳng qua API key (màn hình Nhà cung cấp). */
  const apiAgents = (agents ?? []).filter((a) => a.installed && a.id.startsWith('api:'));
  const selectedName =
    agentId === AUTO_AGENT ? 'agent NSA tự chọn' : (selectedAgent?.name ?? 'agent');

  // Tự cuộn xuống cuối khi có nội dung mới.
  const lastTurn = active?.turns.at(-1);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId, active?.turns.length, lastTurn?.parts, lastTurn?.status]);

  async function pickFolder() {
    const folder = await window.nsa.invoke('dialog:pickFolder');
    if (folder) setNewCwd(folder);
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const prompt = draft.trim();
    if (!prompt || sending || runningTurn) return;
    if (!active && !newCwd) {
      setSendError('Chọn thư mục làm việc trước khi gửi.');
      return;
    }
    await dispatch({
      agentId,
      prompt,
      ...(active
        ? { conversationId: active.id }
        : { cwd: newCwd ?? '', permission: newPermission }),
    });
  }

  /** Gửi qua lõi; lõi hỏi chính sách trước khi cho agent chạy. */
  async function dispatch(request: SendRequest) {
    setSending(true);
    setSendError(null);
    try {
      const result = await send(request);
      if (result.status === 'needs_confirmation') {
        setConfirm({ reason: result.reason, request });
        return;
      }
      if (result.status === 'denied') {
        setSendError(`Chính sách không cho phép: ${result.reason}`);
        return;
      }
      setActiveId(result.conversationId);
      // "Tự chọn" thì giữ nguyên; còn lại ghi nhớ agent đã thật sự nhận việc.
      if (request.agentId !== AUTO_AGENT) setAgentId(request.agentId);
      setDraft('');
      if (inputRef.current) {
        inputRef.current.value = '';
        autoGrow(inputRef.current);
      }
    } catch (err) {
      setSendError(cleanError(err));
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  function openConversation(id: string) {
    setView('chat');
    setActiveId(id);
    setAgentId(null);
    setSendError(null);
  }

  function startNew() {
    setView('chat');
    setActiveId(null);
    setSendError(null);
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="toolbar drag">
          <img src={logo} alt="" width={20} height={20} />
          <span className="brand-name">NSA</span>
          <span className="brand-version">{info ? `v${info.version}` : ''}</span>
          <button
            type="button"
            className="icon-btn no-drag"
            onClick={startNew}
            title="Cuộc trò chuyện mới"
            aria-label="Cuộc trò chuyện mới"
          >
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <path
                d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10M16 10v4.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 4 14.5V9M14.2 3.3l2.5 2.5L10 12.5 7 13l.5-3z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <nav className="conv-list">
          <button
            type="button"
            className={`nav-item ${view === 'store' ? 'active' : ''}`}
            onClick={() => setView('store')}
          >
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
              <path
                d="M3.5 3.5h5v5h-5zM11.5 3.5h5v5h-5zM3.5 11.5h5v5h-5zM11.5 11.5h5v5h-5z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
            <span>App Store</span>
          </button>
          <button
            type="button"
            className={`nav-item ${view === 'memory' ? 'active' : ''}`}
            onClick={() => setView('memory')}
          >
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
              <path
                d="M10 3.5c-1.6-1.3-4.6-.6-4.9 1.8C3.3 5.6 2.6 7.9 3.8 9.2c-1 1.4-.4 3.6 1.4 4 .2 2 2.6 3 4.8 1.8V3.5Zm0 0c1.6-1.3 4.6-.6 4.9 1.8 1.8.3 2.5 2.6 1.3 3.9 1 1.4.4 3.6-1.4 4-.2 2-2.6 3-4.8 1.8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
            <span>Bộ nhớ</span>
            {memPending > 0 && (
              <span className="badge" title="Đề xuất ghi nhớ chờ duyệt">
                {memPending}
              </span>
            )}
          </button>
          <button
            type="button"
            className={`nav-item ${view === 'providers' ? 'active' : ''}`}
            onClick={() => setView('providers')}
          >
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
              <path
                d="M7.5 11.5a3.5 3.5 0 1 1 3-1.7L17 16.3V18h-2v-1.5h-1.5V15H12l-1.6-1.6a3.5 3.5 0 0 1-2.9-1.9zM6 8.5h.01"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>Nhà cung cấp (API key)</span>
          </button>
          <div className="section-label">Cuộc trò chuyện</div>
          {conversations.length === 0 && <p className="hint pad">Chưa có cuộc trò chuyện nào.</p>}
          {conversations.map((c) => {
            const agentsUsed = [...new Set(c.turns.map((t) => t.agentId))];
            return (
              <div
                key={c.id}
                className={`conv-item ${c.id === activeId && view === 'chat' ? 'active' : ''}`}
                onClick={() => openConversation(c.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && openConversation(c.id)}
              >
                <div className="conv-title">{c.title}</div>
                <div className="conv-meta">
                  {agentsUsed.map((a) => (
                    <span key={a} className={`dot agent-${a}`} title={names[a] ?? a} />
                  ))}
                  <span>{folderName(c.cwd)}</span>
                  {c.turns.some((t) => t.status === 'running') && <span className="live">●</span>}
                </div>
                <button
                  type="button"
                  className="conv-del"
                  title="Xoá cuộc trò chuyện"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`Xoá "${c.title}"?`)) {
                      if (c.id === activeId) setActiveId(null);
                      void remove(c.id);
                    }
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </nav>

        {providerAlert && (
          <div className="update-banner">
            <div className="update-title">Nhà cung cấp</div>
            <div className="hint">{providerAlert}</div>
            <button type="button" className="link-btn" onClick={() => setProviderAlert(null)}>
              Đã hiểu
            </button>
          </div>
        )}

        <UpdateBanner />

        <AgentsPanel
          agents={agents}
          checking={checkingAgents}
          onCheck={() => void checkAgents()}
          changes={cliChanges}
          onDismissChanges={dismissChanges}
        />
      </aside>

      {view === 'store' ? (
        <StoreView />
      ) : view === 'memory' ? (
        <MemoryView agents={agents} status={memStatus} version={memVersion} />
      ) : view === 'providers' ? (
        <ProvidersScreen onClose={() => setView('chat')} />
      ) : (
        <main className="chat">
          <header className="chat-head drag">
            <h1 className="chat-title">{active ? active.title : 'Cuộc trò chuyện mới'}</h1>
            {active && (
              <div className="chat-sub">
                <button
                  type="button"
                  className="link-btn"
                  disabled={distilling || active.turns.length === 0}
                  onClick={() => void distillActive()}
                  title="Giao một agent đọc cuộc trò chuyện này và đề xuất điều đáng nhớ vào hộp duyệt"
                >
                  {distilling ? 'Đang chắt lọc…' : 'Ghi nhớ cuộc trò chuyện'}
                </button>
                <span className="cwd" title={active.cwd}>
                  {active.cwd}
                </span>
                <span className={`tag perm-${active.permission}`}>
                  {active.permission === 'edit' ? 'Được sửa file' : 'Chỉ đọc'}
                </span>
              </div>
            )}
          </header>

          <div className="messages" ref={scrollRef}>
            {!active && (
              <div className="setup">
                <img src={logo} alt="" width={64} height={64} />
                <h2>Giao việc cho agent</h2>
                <p className="hint">
                  Chọn thư mục dự án, chọn agent bên dưới rồi gõ yêu cầu. Có thể đổi agent giữa
                  chừng — NSA tự chuyển ngữ cảnh cho agent mới.
                </p>
                <div className="form-group">
                  <div className="form-row">
                    <span className="form-label">Thư mục</span>
                    <span className="cwd form-value" title={newCwd ?? ''}>
                      {newCwd ?? 'Chưa chọn'}
                    </span>
                    <button type="button" className="push-btn" onClick={() => void pickFolder()}>
                      {newCwd ? 'Đổi…' : 'Chọn…'}
                    </button>
                  </div>
                  <label className="form-row">
                    <span className="form-label">Cho sửa file</span>
                    <span className="form-value hint">
                      {newPermission === 'edit'
                        ? 'Agent được sửa file trong thư mục này'
                        : 'Chỉ đọc và lập kế hoạch'}
                    </span>
                    <input
                      type="checkbox"
                      className="switch"
                      checked={newPermission === 'edit'}
                      onChange={(e) => setNewPermission(e.target.checked ? 'edit' : 'read-only')}
                    />
                  </label>
                </div>
              </div>
            )}

            {active?.turns.map((turn) => (
              <TurnView
                key={turn.id}
                turn={turn}
                agentName={names[turn.agentId] ?? turn.agentId}
                onCancel={() => void cancel(turn.id)}
                onAnswer={(id, allowed) => void answerPermission(id, allowed)}
              />
            ))}
          </div>

          <form className="composer" onSubmit={(e) => void submit(e)}>
            <div className="composer-bar">
              <div className="segmented" role="radiogroup" aria-label="Chọn agent">
                <button
                  type="button"
                  role="radio"
                  aria-checked={agentId === AUTO_AGENT}
                  className={agentId === AUTO_AGENT ? 'on' : ''}
                  onClick={() => setAgentId(AUTO_AGENT)}
                  title="NSA chọn agent đủ năng lực cho việc này"
                >
                  Tự chọn
                </button>
                {(agents ?? [])
                  .filter((a) => a.installed && !a.id.startsWith('api:'))
                  .map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      role="radio"
                      aria-checked={a.id === agentId}
                      className={a.id === agentId ? 'on' : ''}
                      onClick={() => setAgentId(a.id)}
                      title={a.ready ? '' : (a.note ?? 'Chưa sẵn sàng')}
                    >
                      <span className={`status ${a.ready ? 'ok' : a.installed ? 'warn' : 'off'}`} />
                      <VendorLogo vendor={vendorOfAgent(a.id)} name={a.name} />
                      {a.name}
                    </button>
                  ))}
              </div>
              {apiAgents.length > 0 && (
                <select
                  className={`select model-select ${agentId.startsWith('api:') ? 'on' : ''}`}
                  value={agentId.startsWith('api:') ? agentId : ''}
                  onChange={(e) => e.target.value && setAgentId(e.target.value)}
                  title="Model gọi thẳng qua API key (chỉ trò chuyện, không sửa file)"
                >
                  <option value="">Model qua API…</option>
                  {apiAgents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              )}
              {selectedAgent && !selectedAgent.ready && (
                <span className="hint warn-text">{selectedAgent.note}</span>
              )}
            </div>
            {sendError && <div className="error-box">{sendError}</div>}
            <div className="input-field">
              <textarea
                value={draft}
                ref={inputRef}
                onChange={(e) => {
                  setDraft(e.target.value);
                  autoGrow(e.target);
                }}
                onKeyDown={onKeyDown}
                placeholder={`Nhắn cho ${selectedName}`}
                rows={1}
              />
              {runningTurn ? (
                <button
                  type="button"
                  className="round-btn stop"
                  onClick={() => void cancel(runningTurn.id)}
                  title="Dừng"
                  aria-label="Dừng"
                >
                  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                    <rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor" />
                  </svg>
                </button>
              ) : (
                <button
                  type="submit"
                  className="round-btn"
                  disabled={!draft.trim() || sending}
                  title="Gửi (Enter)"
                  aria-label="Gửi"
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                    <path
                      d="M8 13V3M3.5 7.5 8 3l4.5 4.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}
            </div>
            <div className="composer-hint hint">Enter để gửi · Shift+Enter xuống dòng</div>
          </form>
        </main>
      )}

      {confirm && (
        <ConfirmSheet
          title="Cho phép agent sửa file?"
          message={confirm.reason}
          confirmLabel="Cho phép"
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const request = { ...confirm.request, confirmed: true };
            setConfirm(null);
            void dispatch(request);
          }}
        />
      )}
    </div>
  );
}

/** Ô nhập cao dần theo nội dung, tối đa ~8 dòng. */
function autoGrow(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function cleanError(err: unknown): string {
  // Electron bọc lỗi từ main: "Error invoking remote method 'chat:send': Error: ..."
  return String(err).replace(/^Error: Error invoking remote method '[^']+': (Error: )?/, '');
}
