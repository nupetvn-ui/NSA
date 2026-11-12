import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type {
  AgentInfo,
  DistillStatus,
  MemoryBranch,
  MemoryEntry,
  MemoryHistoryItem,
  MemoryInfo,
  MemoryKind,
  MemoryProposal,
  MemorySearchHit,
  MemorySettings,
} from '@nsa/core';
import { ImportSheet } from './ImportSheet';

type Tab = 'entries' | 'inbox' | 'history' | 'settings';

const KIND_LABEL: Record<MemoryKind, string> = {
  fact: 'Sự thật',
  preference: 'Sở thích',
  rule: 'Quy tắc',
};

const SOURCE_LABEL: Record<string, string> = {
  manual: 'người dùng dạy',
  chat: 'từ chat',
  distill: 'chắt lọc',
  import: 'nhập lịch sử',
  agent: 'agent đề xuất',
};

interface Props {
  agents: AgentInfo[] | null;
  status: DistillStatus | null;
  /** Tăng mỗi khi lõi báo bộ nhớ thay đổi — để tải lại. */
  version: number;
}

/** Màn hình Bộ nhớ: cây nhánh, tìm, xem / sửa, hộp duyệt, lịch sử + hoàn tác, cài đặt. */
export function MemoryView({ agents, status, version }: Props) {
  const [tab, setTab] = useState<Tab>('entries');
  const [info, setInfo] = useState<MemoryInfo | null>(null);
  const [branches, setBranches] = useState<MemoryBranch[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [query, setQuery] = useState('');
  const [searchResult, setSearchResult] = useState<{
    query: string;
    hits: MemorySearchHit[];
  } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [teaching, setTeaching] = useState(false);
  const [proposals, setProposals] = useState<MemoryProposal[]>([]);
  const [history, setHistory] = useState<MemoryHistoryItem[]>([]);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    () =>
      Promise.all([
        window.nsa.invoke('mem:info'),
        window.nsa.invoke('mem:branches'),
        window.nsa.invoke('mem:list'),
        window.nsa.invoke('mem:proposals'),
        window.nsa.invoke('mem:history'),
      ]).then(
        ([i, b, e, p, h]) => {
          setInfo(i);
          setBranches(b);
          setEntries(e);
          setProposals(p);
          setHistory(h);
        },
        (err: unknown) => setError(cleanError(err)),
      ),
    [],
  );

  useEffect(() => {
    void reload();
  }, [reload, version]);

  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const timer = window.setTimeout(() => {
      void window.nsa.invoke('mem:search', q).then((hits) => setSearchResult({ query: q, hits }));
    }, 150);
    return () => window.clearTimeout(timer);
  }, [query, version]);
  // Ô tìm trống thì không hiện kết quả cũ.
  const hits = query.trim() && searchResult ? searchResult.hits : null;

  async function run<T>(task: () => Promise<T>): Promise<T | undefined> {
    setError(null);
    try {
      const result = await task();
      await reload();
      return result;
    } catch (err) {
      setError(cleanError(err));
      return undefined;
    }
  }

  const pending = proposals.filter((p) => p.status === 'pending');
  const branchTitles = useMemo(
    () => Object.fromEntries(branches.map((b) => [b.path, b.title])),
    [branches],
  );
  const shown: MemoryEntry[] = hits
    ? hits.map((h) => h.entry)
    : entries.filter((e) => !branch || e.branch === branch || e.branch.startsWith(`${branch}/`));
  const snippets = new Map(hits?.map((h) => [h.entry.id, h.snippet]));
  const current = entries.find((e) => e.id === selected) ?? null;

  return (
    <main className="chat memory">
      <header className="chat-head drag mem-head">
        <h1 className="chat-title">Bộ nhớ</h1>
        <div className="chat-sub">
          <span>
            {info ? `${info.entries} mục nhớ` : '…'} · dùng chung cho mọi agent
            {info && !info.vector ? ' · tìm theo từ khoá (chưa có tìm theo nghĩa)' : ''}
          </span>
        </div>
      </header>

      <div className="mem-toolbar">
        <div className="segmented" role="tablist" aria-label="Mục bộ nhớ">
          {(
            [
              ['entries', 'Mục nhớ'],
              ['inbox', `Hộp duyệt${pending.length ? ` (${pending.length})` : ''}`],
              ['history', 'Lịch sử'],
              ['settings', 'Cài đặt'],
            ] as [Tab, string][]
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? 'on' : ''}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button type="button" className="push-btn" onClick={() => setImporting(true)}>
          Nhập lịch sử chat…
        </button>
        <button
          type="button"
          className="push-btn primary"
          onClick={() => {
            setTab('entries');
            setTeaching(true);
            setSelected(null);
          }}
        >
          Dạy điều mới
        </button>
      </div>

      {status && (status.running || status.error || status.proposals !== undefined) && (
        <div className={`mem-status ${status.error ? 'err' : ''}`}>
          {status.running && (
            <span className="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          )}
          <span>
            {status.label}
            {status.running
              ? ' — agent đang đọc đoạn chat…'
              : status.error
                ? ` — lỗi: ${status.error}`
                : ` — ${status.proposals} đề xuất vào hộp duyệt`}
          </span>
        </div>
      )}
      {error && <div className="error-box mem-error">{error}</div>}

      {tab === 'entries' && (
        <div className="mem-body">
          <nav className="mem-branches" aria-label="Cây nhánh">
            <input
              className="mem-search"
              type="search"
              placeholder="Tìm trong bộ nhớ"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button
              type="button"
              className={`branch-item ${branch === null && !hits ? 'active' : ''}`}
              onClick={() => {
                setBranch(null);
                setQuery('');
              }}
            >
              <span>Tất cả</span>
              <span className="count">{entries.length}</span>
            </button>
            {branches
              .filter((b) => !b.hidden)
              .map((b) => (
                <button
                  key={b.path}
                  type="button"
                  className={`branch-item ${branch === b.path && !hits ? 'active' : ''}`}
                  style={{ paddingLeft: 10 + 14 * (b.path.split('/').length - 1) }}
                  onClick={() => {
                    setBranch(b.path);
                    setQuery('');
                  }}
                  title={b.description}
                >
                  <span>{b.title}</span>
                  <span className="count">{b.count}</span>
                </button>
              ))}
            <NewBranch
              branches={branches}
              onCreate={(path, title) =>
                void run(() => window.nsa.invoke('mem:saveBranch', path, { title }))
              }
            />
          </nav>

          <section className="mem-list">
            {hits && <div className="section-label">Kết quả tìm “{query.trim()}”</div>}
            {shown.length === 0 && (
              <p className="hint pad">
                {hits
                  ? 'Không tìm thấy mục nào.'
                  : 'Chưa có mục nhớ nào. Bấm “Dạy điều mới”, hoặc dặn agent “hãy nhớ…” khi chat.'}
              </p>
            )}
            {shown.map((e) => (
              <button
                key={e.id}
                type="button"
                className={`entry-item ${e.id === selected ? 'active' : ''}`}
                onClick={() => {
                  setSelected(e.id);
                  setTeaching(false);
                }}
              >
                <div className="entry-title">
                  {e.kind === 'rule' && <span className="tag kind-rule">Quy tắc</span>}
                  {e.sensitive && <span className="tag perm-edit">Nhạy cảm</span>}
                  <span>{e.title}</span>
                </div>
                <div className="entry-snippet">
                  {snippets.get(e.id) ? <Snippet text={snippets.get(e.id) ?? ''} /> : e.body}
                </div>
                <div className="entry-meta">
                  {branchTitles[e.branch] ?? e.branch} · {SOURCE_LABEL[e.source.kind]}
                  {e.source.agentId ? ` (${e.source.agentId})` : ''} · {shortDate(e.updated)}
                </div>
              </button>
            ))}
          </section>

          <section className="mem-detail">
            {teaching ? (
              <EntryEditor
                key="new"
                branches={branches}
                initial={{
                  branch: branch ?? 'nguoi-dung',
                  title: '',
                  body: '',
                  kind: 'fact',
                  sensitive: false,
                }}
                submitLabel="Ghi nhớ"
                onCancel={() => setTeaching(false)}
                onSubmit={async (draft) => {
                  const entry = await run(() => window.nsa.invoke('mem:teach', draft));
                  if (entry) {
                    setTeaching(false);
                    setSelected(entry.id);
                  }
                }}
              />
            ) : current ? (
              <EntryDetail
                key={current.id}
                entry={current}
                branches={branches}
                version={version}
                onSave={(patch) => run(() => window.nsa.invoke('mem:update', current.id, patch))}
                onDelete={async () => {
                  if (!window.confirm(`Xoá "${current.title}"? Có thể hoàn tác trong Lịch sử.`))
                    return;
                  await run(() => window.nsa.invoke('mem:delete', current.id));
                  setSelected(null);
                }}
                onUndo={(commit) => run(() => window.nsa.invoke('mem:undo', commit))}
              />
            ) : (
              <div className="mem-empty hint">
                <p>Chọn một mục để xem và sửa.</p>
                <p>
                  Mỗi mục là một file Markdown trong{' '}
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => void window.nsa.invoke('mem:openFolder')}
                  >
                    thư mục bộ nhớ
                  </button>
                  , có lịch sử để hoàn tác.
                </p>
              </div>
            )}
          </section>
        </div>
      )}

      {tab === 'inbox' && (
        <Inbox
          proposals={proposals}
          branches={branches}
          onAccept={(id, edits) => run(() => window.nsa.invoke('mem:accept', id, edits))}
          onReject={(id) => run(() => window.nsa.invoke('mem:reject', id))}
        />
      )}

      {tab === 'history' && (
        <section className="mem-scroll">
          <HistoryList
            items={history}
            onUndo={(commit) => run(() => window.nsa.invoke('mem:undo', commit))}
          />
        </section>
      )}

      {tab === 'settings' && (
        <SettingsPanel
          agents={agents}
          info={info}
          onReindex={() => run(() => window.nsa.invoke('mem:reindex'))}
        />
      )}

      {importing && <ImportSheet onClose={() => setImporting(false)} />}
    </main>
  );
}

// ------------------------------------------------------------ Mục nhớ

interface DraftFields {
  branch: string;
  title: string;
  body: string;
  kind: MemoryKind;
  sensitive: boolean;
}

function EntryEditor({
  branches,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  branches: MemoryBranch[];
  initial: DraftFields;
  submitLabel: string;
  onSubmit: (draft: DraftFields) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof DraftFields>(key: K, value: DraftFields[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  return (
    <form
      className="entry-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (!draft.body.trim() || busy) return;
        setBusy(true);
        void Promise.resolve(onSubmit(draft)).finally(() => setBusy(false));
      }}
    >
      <input
        className="text-field title-field"
        placeholder="Tiêu đề ngắn (tuỳ chọn)"
        value={draft.title}
        onChange={(e) => set('title', e.target.value)}
      />
      <textarea
        className="text-field body-field"
        placeholder="Điều cần nhớ, viết thành câu đầy đủ. Ví dụ: Tôi thích màu xanh lá."
        value={draft.body}
        onChange={(e) => set('body', e.target.value)}
        rows={6}
        autoFocus
      />
      <div className="form-group">
        <label className="form-row">
          <span className="form-label">Nhánh</span>
          <select
            className="form-value select"
            value={draft.branch}
            onChange={(e) => set('branch', e.target.value)}
          >
            {branches.map((b) => (
              <option key={b.path} value={b.path}>
                {b.title} ({b.path})
              </option>
            ))}
          </select>
        </label>
        <label className="form-row">
          <span className="form-label">Loại</span>
          <select
            className="form-value select"
            value={draft.kind}
            onChange={(e) => set('kind', e.target.value as MemoryKind)}
          >
            <option value="fact">Sự thật</option>
            <option value="preference">Sở thích</option>
            <option value="rule">Quy tắc cho agent</option>
          </select>
        </label>
        <label className="form-row">
          <span className="form-label">Nhạy cảm</span>
          <span className="form-value hint">Không tự chèn vào lời nhắn gửi agent</span>
          <input
            type="checkbox"
            className="switch"
            checked={draft.sensitive}
            onChange={(e) => set('sensitive', e.target.checked)}
          />
        </label>
      </div>
      <div className="editor-actions">
        {onCancel && (
          <button type="button" className="push-btn" onClick={onCancel}>
            Huỷ
          </button>
        )}
        <button type="submit" className="push-btn primary" disabled={!draft.body.trim() || busy}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function EntryDetail({
  entry,
  branches,
  version,
  onSave,
  onDelete,
  onUndo,
}: {
  entry: MemoryEntry;
  branches: MemoryBranch[];
  version: number;
  onSave: (patch: DraftFields) => Promise<unknown>;
  onDelete: () => void;
  onUndo: (commit: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState<MemoryHistoryItem[]>([]);
  useEffect(() => {
    void window.nsa.invoke('mem:history', entry.id).then(setHistory);
  }, [entry.id, entry.updated, version]);

  if (editing) {
    return (
      <EntryEditor
        branches={branches}
        initial={{
          branch: entry.branch,
          title: entry.title,
          body: entry.body,
          kind: entry.kind,
          sensitive: entry.sensitive,
        }}
        submitLabel="Lưu"
        onCancel={() => setEditing(false)}
        onSubmit={async (draft) => {
          await onSave(draft);
          setEditing(false);
        }}
      />
    );
  }
  return (
    <div className="entry-detail">
      <h2>{entry.title}</h2>
      <p className="entry-body">{entry.body}</p>
      <div className="form-group">
        <Row
          label="Nhánh"
          value={branches.find((b) => b.path === entry.branch)?.title ?? entry.branch}
        />
        <Row label="Loại" value={KIND_LABEL[entry.kind]} />
        <Row
          label="Nguồn gốc"
          value={`${SOURCE_LABEL[entry.source.kind]}${entry.source.agentId ? ` · ${entry.source.agentId}` : ''}${entry.source.ref ? ` · ${entry.source.ref}` : ''}`}
        />
        <Row label="Tin cậy" value={`${Math.round(entry.confidence * 100)}%`} />
        <Row
          label="Chủ sở hữu"
          value={`${entry.owner} · ${entry.scope === 'personal' ? 'cá nhân' : 'nhóm'}`}
        />
        <Row
          label="Ngày"
          value={`tạo ${shortDate(entry.created)} · sửa ${shortDate(entry.updated)}`}
        />
      </div>
      <div className="editor-actions">
        <button type="button" className="push-btn danger" onClick={onDelete}>
          Xoá
        </button>
        <button type="button" className="push-btn primary" onClick={() => setEditing(true)}>
          Sửa
        </button>
      </div>
      <div className="section-label flat mem-sub">Lịch sử của mục này</div>
      <HistoryList items={history} onUndo={onUndo} compact />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="form-row">
      <span className="form-label">{label}</span>
      <span className="form-value selectable">{value}</span>
    </div>
  );
}

function NewBranch({
  branches,
  onCreate,
}: {
  branches: MemoryBranch[];
  onCreate: (path: string, title: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [parent, setParent] = useState('');
  const [title, setTitle] = useState('');
  if (!open) {
    return (
      <button type="button" className="link-btn new-branch" onClick={() => setOpen(true)}>
        + Nhánh mới
      </button>
    );
  }
  const slug = slugify(title);
  return (
    <form
      className="new-branch-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!slug) return;
        onCreate(parent ? `${parent}/${slug}` : slug, title.trim());
        setOpen(false);
        setTitle('');
      }}
    >
      <input
        className="text-field"
        placeholder="Tên nhánh"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        autoFocus
      />
      <select className="text-field" value={parent} onChange={(e) => setParent(e.target.value)}>
        <option value="">(nhánh gốc)</option>
        {branches.map((b) => (
          <option key={b.path} value={b.path}>
            trong {b.title}
          </option>
        ))}
      </select>
      <div className="editor-actions">
        <button type="button" className="push-btn" onClick={() => setOpen(false)}>
          Huỷ
        </button>
        <button type="submit" className="push-btn primary" disabled={!slug}>
          Tạo
        </button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------ Hộp duyệt

function Inbox({
  proposals,
  branches,
  onAccept,
  onReject,
}: {
  proposals: MemoryProposal[];
  branches: MemoryBranch[];
  onAccept: (id: string, edits?: DraftFields) => Promise<unknown>;
  onReject: (id: string) => Promise<unknown>;
}) {
  const [showDecided, setShowDecided] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const pending = proposals.filter((p) => p.status === 'pending');
  const decided = proposals.filter((p) => p.status !== 'pending').slice(0, 50);
  return (
    <section className="mem-scroll">
      <p className="hint mem-intro">
        Đề xuất ghi nhớ từ agent, từ chắt lọc và từ nhập lịch sử vào đây. Điều chắc chắn, không mâu
        thuẫn được tự nhận theo quy tắc của từng nhánh; quy tắc hành vi, nhạy cảm hoặc mâu thuẫn thì
        chờ bạn duyệt.
      </p>
      {pending.length === 0 && <p className="hint pad">Không có đề xuất nào chờ duyệt.</p>}
      {pending.map((p) =>
        editing === p.id ? (
          <div key={p.id} className="proposal">
            <EntryEditor
              branches={branches}
              initial={{
                branch: p.draft.branch,
                title: p.draft.title,
                body: p.draft.body,
                kind: p.draft.kind,
                sensitive: p.draft.sensitive ?? false,
              }}
              submitLabel="Nhận bản đã sửa"
              onCancel={() => setEditing(null)}
              onSubmit={async (draft) => {
                await onAccept(p.id, draft);
                setEditing(null);
              }}
            />
          </div>
        ) : (
          <ProposalCard key={p.id} proposal={p} branches={branches}>
            <div className="editor-actions">
              <button type="button" className="push-btn" onClick={() => void onReject(p.id)}>
                Từ chối
              </button>
              <button type="button" className="push-btn" onClick={() => setEditing(p.id)}>
                Sửa rồi nhận
              </button>
              <button
                type="button"
                className="push-btn primary"
                onClick={() => void onAccept(p.id)}
              >
                Nhận
              </button>
            </div>
          </ProposalCard>
        ),
      )}
      {decided.length > 0 && (
        <button
          type="button"
          className="link-btn mem-toggle"
          onClick={() => setShowDecided((v) => !v)}
        >
          {showDecided ? 'Ẩn' : 'Xem'} {decided.length} đề xuất đã quyết định
        </button>
      )}
      {showDecided &&
        decided.map((p) => (
          <ProposalCard key={p.id} proposal={p} branches={branches}>
            <div className="hint">
              {p.status === 'accepted' ? 'Đã nhận' : 'Đã từ chối'}{' '}
              {p.decidedBy === 'auto' ? '(tự động)' : '(bạn)'} ·{' '}
              {shortDate(p.decidedAt ?? p.createdAt)}
            </div>
          </ProposalCard>
        ))}
    </section>
  );
}

function ProposalCard({
  proposal: p,
  branches,
  children,
}: {
  proposal: MemoryProposal;
  branches: MemoryBranch[];
  children: ReactNode;
}) {
  return (
    <div className={`proposal ${p.status}`}>
      <div className="entry-title">
        <span className="tag">{KIND_LABEL[p.draft.kind]}</span>
        <span>{p.draft.title}</span>
      </div>
      <p className="entry-body">{p.draft.body}</p>
      <div className="entry-meta">
        {branches.find((b) => b.path === p.draft.branch)?.title ?? p.draft.branch} ·{' '}
        {SOURCE_LABEL[p.draft.source.kind]}
        {p.draft.source.agentId ? ` (${p.draft.source.agentId})` : ''} · tin cậy{' '}
        {Math.round(p.draft.confidence * 100)}% · {shortDate(p.createdAt)}
      </div>
      {p.reasons.length > 0 && (
        <ul className="reasons">
          {p.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {p.conflicts.length > 0 && (
        <div className="conflicts">
          <div className="section-label flat">Mục đã có</div>
          {p.conflicts.map((c) => (
            <div key={c.id} className="conflict">
              <strong>{c.title}</strong>: {c.body}
            </div>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

// ------------------------------------------------------------ Lịch sử

const OP_LABEL: Record<MemoryHistoryItem['op'], string> = {
  create: 'Thêm',
  update: 'Sửa',
  delete: 'Xoá',
  revert: 'Hoàn tác',
  branch: 'Nhánh',
  init: 'Tạo kho',
};

function HistoryList({
  items,
  onUndo,
  compact,
}: {
  items: MemoryHistoryItem[];
  onUndo: (commit: string) => Promise<unknown>;
  compact?: boolean;
}) {
  if (items.length === 0) return <p className="hint pad">Chưa có thay đổi nào.</p>;
  return (
    <ul className={`history ${compact ? 'compact' : ''}`}>
      {items.map((h) => (
        <li key={h.commit}>
          <span className={`tag op-${h.op}`}>{OP_LABEL[h.op]}</span>
          <span className="history-summary">{h.summary}</span>
          <span className="hint">{shortDate(h.at)}</span>
          {h.undoable && (
            <button type="button" className="link-btn" onClick={() => void onUndo(h.commit)}>
              Hoàn tác
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------ Cài đặt

function SettingsPanel({
  agents,
  info,
  onReindex,
}: {
  agents: AgentInfo[] | null;
  info: MemoryInfo | null;
  onReindex: () => Promise<unknown>;
}) {
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [reindexed, setReindexed] = useState<string | null>(null);
  useEffect(() => {
    void window.nsa.invoke('mem:settings').then(setSettings);
  }, []);
  if (!settings) return null;
  const save = (patch: Partial<MemorySettings>) =>
    void window.nsa.invoke('mem:saveSettings', patch).then(setSettings);
  const d = settings.distill;
  const setDistill = (patch: Partial<MemorySettings['distill']>) =>
    save({ distill: { ...d, ...patch } });
  return (
    <section className="mem-scroll mem-settings">
      <div className="section-label flat">Cho agent dùng bộ nhớ</div>
      <div className="form-group">
        <label className="form-row">
          <span className="form-label wide">Tự chèn ngữ cảnh</span>
          <span className="form-value hint">Mục liên quan được thêm vào đầu mỗi lượt chat</span>
          <input
            type="checkbox"
            className="switch"
            checked={settings.inject.enabled}
            onChange={(e) => save({ inject: { ...settings.inject, enabled: e.target.checked } })}
          />
        </label>
        <label className="form-row">
          <span className="form-label wide">Tool mem_*</span>
          <span className="form-value hint">
            Agent hỗ trợ MCP được tìm, đọc và đề xuất ghi nhớ (Claude, Codex, OpenCode)
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={settings.agentTools}
            onChange={(e) => save({ agentTools: e.target.checked })}
          />
        </label>
      </div>

      <div className="section-label flat">Tự chắt lọc thành đề xuất ghi nhớ</div>
      <div className="form-group">
        <label className="form-row">
          <span className="form-label wide">Bật</span>
          <span className="form-value hint">Giao một agent đọc đoạn chat khi đạt ngưỡng</span>
          <input
            type="checkbox"
            className="switch"
            checked={d.enabled}
            onChange={(e) => setDistill({ enabled: e.target.checked })}
          />
        </label>
        <label className="form-row">
          <span className="form-label wide">Agent chắt lọc</span>
          <select
            className="form-value select"
            value={d.agentId}
            onChange={(e) => setDistill({ agentId: e.target.value })}
          >
            <option value="auto">Tự chọn</option>
            {(agents ?? [])
              .filter((a) => a.installed)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
        <label className="form-row">
          <span className="form-label wide">Sau mỗi</span>
          <input
            type="number"
            className="num-field"
            min={0}
            max={100}
            value={d.everyTurns}
            onChange={(e) => setDistill({ everyTurns: Number(e.target.value) })}
          />
          <span className="form-value hint">lượt chat (0 = tắt)</span>
        </label>
        <label className="form-row">
          <span className="form-label wide">Kết thúc sau</span>
          <input
            type="number"
            className="num-field"
            min={0}
            max={1440}
            value={d.idleMinutes}
            onChange={(e) => setDistill({ idleMinutes: Number(e.target.value) })}
          />
          <span className="form-value hint">phút không chat tiếp (0 = tắt)</span>
        </label>
        <label className="form-row">
          <span className="form-label wide">Khi bạn sửa lỗi</span>
          <span className="form-value hint">“sai rồi”, “không phải”… → chắt lọc ngay</span>
          <input
            type="checkbox"
            className="switch"
            checked={d.onCorrection}
            onChange={(e) => setDistill({ onCorrection: e.target.checked })}
          />
        </label>
        <label className="form-row">
          <span className="form-label wide">Khi bạn dặn nhớ</span>
          <span className="form-value hint">“hãy nhớ”, “từ nay”… → chắt lọc ngay</span>
          <input
            type="checkbox"
            className="switch"
            checked={d.onTeach}
            onChange={(e) => setDistill({ onTeach: e.target.checked })}
          />
        </label>
      </div>

      <div className="section-label flat">Lưu trữ</div>
      <div className="form-group">
        <div className="form-row">
          <span className="form-label wide">Thư mục</span>
          <span className="form-value cwd selectable" title={info?.root}>
            {info?.root}
          </span>
          <button
            type="button"
            className="push-btn"
            onClick={() => void window.nsa.invoke('mem:openFolder')}
          >
            Mở
          </button>
        </div>
        <div className="form-row">
          <span className="form-label wide">Chỉ mục tìm kiếm</span>
          <span className="form-value hint">
            SQLite FTS5, dựng lại được từ file Markdown{reindexed ? ` · ${reindexed}` : ''}
          </span>
          <button
            type="button"
            className="push-btn"
            onClick={() =>
              void onReindex().then((n) => setReindexed(`đã dựng lại ${String(n ?? 0)} mục`))
            }
          >
            Dựng lại
          </button>
        </div>
        <div className="form-row">
          <span className="form-label wide">Tìm theo nghĩa</span>
          <span className="form-value hint">
            {info?.vector ? 'Đang bật' : 'Chưa có ở bản này — chỉ tìm theo từ khoá'}
          </span>
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------ Tiện ích

function Snippet({ text }: { text: string }) {
  // FTS5 đánh dấu từ khớp bằng [ ].
  const parts = text.split(/(\[[^\]]*\])/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('[') && p.endsWith(']') ? <mark key={i}>{p.slice(1, -1)}</mark> : p,
      )}
    </>
  );
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
}

function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function cleanError(err: unknown): string {
  return String(err).replace(/^Error: Error invoking remote method '[^']+': (Error: )?/, '');
}
