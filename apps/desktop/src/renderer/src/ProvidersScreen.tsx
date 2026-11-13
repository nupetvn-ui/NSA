import { useEffect, useMemo, useState } from 'react';
import type { ProviderSettingsPatch, ProvidersView, TaskKind, TaskTryResult } from '@nsa/core';

type ProviderView = ProvidersView['providers'][number];
type Tab = 'providers' | 'tasks' | 'cost';

const GROUPS: [ProviderView['group'], string][] = [
  ['major', 'Hãng lớn'],
  ['budget', 'Giá rẻ'],
  ['gateway', 'Cổng gom nhiều model'],
  ['local', 'Chạy trên máy (không cần key)'],
  ['custom', 'Tự khai báo'],
];

const CLI_LABEL = { claude: 'Claude Code', opencode: 'OpenCode', codex: 'Codex' } as const;
const STATUS_LABEL: Record<string, string> = {
  tested: 'đã chạy thật với hãng',
  'tested-fake': 'đã chạy thật với máy chủ giả',
  documented: 'theo tài liệu chính thức, chưa thử',
  unverified: 'chưa xác minh',
  unsupported: 'không ghép được',
};

function usd(n: number | null): string {
  if (n === null) return '?';
  return n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function cleanError(err: unknown): string {
  return String(err).replace(/^Error: Error invoking remote method '[^']+': (Error: )?/, '');
}

/** Màn hình Nhà cung cấp: dán key, kiểm tra, chọn model theo việc, xem chi phí (ADR-0008). */
export function ProvidersScreen({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<ProvidersView | null>(null);
  const [tab, setTab] = useState<Tab>('providers');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.nsa.invoke('providers:view').then(setView);
    return window.nsa.on('providers:changed', setView);
  }, []);

  /** Gọi main; lỗi hiện ở hộp đỏ thay vì làm hỏng màn hình. */
  async function act<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(cleanError(err));
      return undefined;
    }
  }

  const update = (patch: ProviderSettingsPatch) =>
    act(async () => setView(await window.nsa.invoke('providers:update', patch)));

  return (
    <main className="chat providers-screen">
      <header className="chat-head drag">
        <h1 className="chat-title">Nhà cung cấp</h1>
        <div className="segmented no-drag" role="tablist">
          {(
            [
              ['providers', 'Hãng & key'],
              ['tasks', 'Model theo việc'],
              ['cost', 'Chi phí'],
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
        <button type="button" className="push-btn no-drag" onClick={onClose}>
          Xong
        </button>
      </header>
      <div className="messages providers-body">
        {error && <div className="error-box">{error}</div>}
        {!view && <p className="hint">Đang tải…</p>}
        {view && !view.keystore && (
          <div className="error-box">
            Kho khoá của hệ điều hành không dùng được nên NSA không lưu key (không bao giờ lưu dạng
            thô). Hãng chạy trên máy vẫn dùng được.
          </div>
        )}
        {view && tab === 'providers' && (
          <ProvidersTab view={view} act={act} setView={setView} update={update} />
        )}
        {view && tab === 'tasks' && <TasksTab view={view} update={update} />}
        {view && tab === 'cost' && <CostTab view={view} update={update} />}
      </div>
    </main>
  );
}

// ---------------------------------------------------------------- Hãng & key

function ProvidersTab({
  view,
  act,
  setView,
  update,
}: {
  view: ProvidersView;
  act: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  setView: (v: ProvidersView) => void;
  update: (patch: ProviderSettingsPatch) => Promise<unknown>;
}) {
  const [selectedId, setSelected] = useState<string>(view.providers[0]?.id ?? '');
  const [addingCustom, setAddingCustom] = useState(false);
  const selected = view.providers.find((p) => p.id === selectedId);

  return (
    <div className="providers-layout">
      <nav className="provider-list">
        {GROUPS.map(([group, label]) => {
          const items = view.providers.filter((p) => p.group === group);
          if (!items.length && group !== 'custom') return null;
          return (
            <div key={group}>
              <div className="section-label">{label}</div>
              {items.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`provider-item ${p.id === selectedId && !addingCustom ? 'active' : ''}`}
                  onClick={() => {
                    setSelected(p.id);
                    setAddingCustom(false);
                  }}
                >
                  <span className={`status ${p.usable ? 'ok' : 'off'}`} />
                  <span className="provider-item-name">{p.name}</span>
                  {p.keyHint && <span className="hint small">{p.keyHint}</span>}
                </button>
              ))}
              {group === 'custom' && (
                <button
                  type="button"
                  className={`provider-item ${addingCustom ? 'active' : ''}`}
                  onClick={() => setAddingCustom(true)}
                >
                  <span className="provider-item-name">+ Thêm hãng khác…</span>
                </button>
              )}
            </div>
          );
        })}
        <p className="hint small pad">
          Dữ liệu hãng: bản {view.catalogVersion}, kiểm theo tài liệu chính thức ngày{' '}
          {view.catalogCheckedAt}.{view.catalogNote ? ` ${view.catalogNote}` : ''}
        </p>
      </nav>
      <section className="provider-detail">
        {addingCustom ? (
          <CustomForm
            onSave={async (provider) => {
              await update({ kind: 'custom', provider });
              setAddingCustom(false);
            }}
          />
        ) : selected ? (
          <ProviderDetail
            key={selected.id}
            provider={selected}
            act={act}
            setView={setView}
            update={update}
          />
        ) : null}
      </section>
    </div>
  );
}

function ProviderDetail({
  provider: p,
  act,
  setView,
  update,
}: {
  provider: ProviderView;
  act: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  setView: (v: ProvidersView) => void;
  update: (patch: ProviderSettingsPatch) => Promise<unknown>;
}) {
  const [key, setKey] = useState('');
  const [checking, setChecking] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>(p.fieldValues);
  const [extra, setExtra] = useState('');
  const [pairings, setPairings] = useState<string[]>([]);

  useEffect(() => {
    void window.nsa
      .invoke('providers:view')
      .then((v) => setPairings(v.pairings.map((x) => `${x.cli}+${x.model}`)));
  }, [p]);

  async function saveKey() {
    const value = key.trim();
    if (!value) return;
    // Key chỉ đi một chiều xuống main; ô nhập được xoá ngay, giao diện không giữ key.
    setKey('');
    const v = await act(() => window.nsa.invoke('providers:setKey', p.id, value));
    if (v) setView(v);
  }

  async function check() {
    setChecking(true);
    await act(() => window.nsa.invoke('providers:check', p.id));
    setChecking(false);
  }

  const chatModels = p.models.filter((m) => m.kind === 'chat');

  return (
    <div className="provider-card">
      <h2>{p.name}</h2>
      <div className="hint small">
        Chuẩn {p.standard === 'openai' ? 'OpenAI' : 'Anthropic'} ·{' '}
        <span className="cwd">{p.endpoints[p.standard]}</span>
      </div>

      <h3>Dữ liệu gửi đi đâu</h3>
      <div className="form-group">
        <div className="form-row">
          <span className="form-label">Máy chủ</span>
          <span className="form-value wrap">{p.data.serverLocation ?? 'Chưa xác minh'}</span>
        </div>
        <div className="form-row">
          <span className="form-label">Huấn luyện</span>
          <span className="form-value wrap">{p.data.training ?? 'Chưa xác minh'}</span>
        </div>
        <div className="form-row">
          <span className="form-label">Gói</span>
          <span className="form-value">
            {
              {
                free: 'Miễn phí',
                paid: 'Trả tiền',
                both: 'Có gói miễn phí và trả tiền',
                local: 'Chạy trên máy',
              }[p.data.tier]
            }
          </span>
        </div>
      </div>
      {p.data.warning && <div className="notice-box warn">{p.data.warning}</div>}
      {p.data.sources.length > 0 && (
        <details className="sources">
          <summary className="hint small">
            Nguồn ({p.data.sources.length} trang tài liệu chính thức)
          </summary>
          {p.data.sources.map((s) => (
            <a key={s} href={s} target="_blank" rel="noreferrer" className="hint small source-link">
              {s}
            </a>
          ))}
        </details>
      )}

      {p.keyRequired ? (
        <>
          <h3>API key</h3>
          <div className="form-group">
            <div className="form-row">
              <span className="form-label">Key đã lưu</span>
              <span className="form-value">{p.keyHint ?? 'Chưa có'}</span>
              {p.keyHint && (
                <button
                  type="button"
                  className="push-btn"
                  onClick={() => {
                    if (window.confirm(`Xoá key ${p.name} khỏi kho khoá?`)) {
                      void act(() => window.nsa.invoke('providers:deleteKey', p.id)).then(
                        (v) => v && setView(v),
                      );
                    }
                  }}
                >
                  Xoá key
                </button>
              )}
            </div>
            <form
              className="form-row"
              onSubmit={(e) => {
                e.preventDefault();
                void saveKey();
              }}
            >
              <span className="form-label">{p.keyHint ? 'Đổi key' : 'Dán key'}</span>
              <input
                className="text-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="Dán key vào đây"
              />
              <button type="submit" className="push-btn primary" disabled={!key.trim()}>
                Lưu
              </button>
            </form>
          </div>
          <p className="hint small">
            Key được mã hoá bằng kho khoá của Windows và chỉ gửi cho {p.name}.{' '}
            {p.keyUrl && (
              <a href={p.keyUrl} target="_blank" rel="noreferrer">
                Lấy key ở trang của hãng
              </a>
            )}
          </p>
        </>
      ) : p.group === 'local' ? (
        <div className="form-group">
          <label className="form-row">
            <span className="form-label">Dùng</span>
            <span className="form-value">
              Bật khi {p.name.replace(/\s*\(.*/, '')} đang chạy trên máy
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={p.enabled}
              onChange={(e) =>
                void update({ kind: 'enabled', providerId: p.id, enabled: e.target.checked })
              }
            />
          </label>
        </div>
      ) : null}

      {p.fields.length > 0 && (
        <div className="form-group">
          {p.fields.map((f) => (
            <div key={f.id} className="form-row">
              <span className="form-label">{f.label}</span>
              <input
                className="text-input"
                value={fields[f.id] ?? ''}
                placeholder={f.hint}
                onChange={(e) => setFields({ ...fields, [f.id]: e.target.value })}
                onBlur={() => void update({ kind: 'fields', providerId: p.id, fields })}
              />
            </div>
          ))}
        </div>
      )}

      <div className="check-row">
        <button
          type="button"
          className="push-btn"
          disabled={checking || (p.keyRequired && !p.keyHint)}
          onClick={() => void check()}
        >
          {checking ? 'Đang kiểm…' : 'Kiểm tra'}
        </button>
        {p.lastCheck && (
          <span className={p.lastCheck.ok ? 'ok-text' : 'err'}>
            {p.lastCheck.ok ? '✓ ' : '✗ '}
            {p.lastCheck.message}
          </span>
        )}
      </div>

      <h3>Model</h3>
      <table className="model-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Giá vào / ra (1 triệu token)</th>
            <th>Ảnh</th>
            <th>Gọi tool</th>
          </tr>
        </thead>
        <tbody>
          {p.models.map((m) => (
            <tr key={m.id} title={m.note ?? ''}>
              <td>
                {m.name}
                <div className="hint small">{m.id}</div>
              </td>
              <td>
                {m.kind === 'embedding'
                  ? `${usd(m.inputUsdPer1M)} (embedding)`
                  : `${usd(m.inputUsdPer1M)} / ${usd(m.outputUsdPer1M)}`}
                {m.freeTier && <span className="cap">có gói miễn phí</span>}
              </td>
              <td>{m.vision === null ? '?' : m.vision ? 'có' : 'không'}</td>
              <td>
                {m.toolCalling === 'stable' ? (
                  <span className="cap ok">ổn định</span>
                ) : m.toolCalling === 'documented' ? (
                  <span
                    className="cap"
                    title="Tài liệu nói hỗ trợ, NSA chưa thử — không được giao việc sửa file"
                  >
                    chưa thử
                  </span>
                ) : (
                  'không'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {(p.group === 'local' || p.group === 'gateway' || p.group === 'custom') && (
        <form
          className="check-row"
          onSubmit={(e) => {
            e.preventDefault();
            const models = [...p.models.map((m) => m.id), ...extra.split(/[,\s]+/)];
            setExtra('');
            void update({ kind: 'extraModels', providerId: p.id, models });
          }}
        >
          <input
            className="text-input"
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            placeholder="Thêm tên model (ví dụ qwen3-coder)"
          />
          <button type="submit" className="push-btn" disabled={!extra.trim()}>
            Thêm
          </button>
        </form>
      )}

      <h3>Dùng key này cho CLI có sẵn</h3>
      <p className="hint small">
        NSA chạy CLI với key của {p.name} theo từng lượt, không sửa cấu hình của CLI. Model chưa gọi
        tool ổn định thì CLI chỉ được đọc, không sửa file.
      </p>
      <div className="form-group">
        {p.cli.map((c) => (
          <div key={c.cli} className="form-row">
            <span className="form-label">{CLI_LABEL[c.cli]}</span>
            <span className="form-value wrap" title={c.note ?? ''}>
              {STATUS_LABEL[c.status]}
              {c.note ? ` — ${c.note}` : ''}
            </span>
            {c.allowed && chatModels.length > 0 && (
              <select
                className="select"
                value={chatModels.find((m) => pairings.includes(`${c.cli}+${m.ref}`))?.ref ?? ''}
                onChange={(e) => {
                  const current = chatModels.filter((m) => pairings.includes(`${c.cli}+${m.ref}`));
                  void (async () => {
                    for (const m of current)
                      await update({ kind: 'pairing', cli: c.cli, model: m.ref, on: false });
                    if (e.target.value)
                      await update({
                        kind: 'pairing',
                        cli: c.cli,
                        model: e.target.value,
                        on: true,
                      });
                    const v = await window.nsa.invoke('providers:view');
                    setPairings(v.pairings.map((x) => `${x.cli}+${x.model}`));
                  })();
                }}
                disabled={p.keyRequired && !p.keyHint}
              >
                <option value="">Tắt</option>
                {chatModels.map((m) => (
                  <option key={m.ref} value={m.ref}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        ))}
      </div>

      {p.group === 'custom' && (
        <button
          type="button"
          className="push-btn danger"
          onClick={() => {
            if (window.confirm(`Xoá "${p.name}" và key của nó?`)) {
              void update({ kind: 'removeCustom', providerId: p.id });
            }
          }}
        >
          Xoá hãng tự khai báo
        </button>
      )}
    </div>
  );
}

function CustomForm({
  onSave,
}: {
  onSave: (p: {
    id: string;
    name: string;
    standard: 'openai' | 'anthropic';
    baseUrl: string;
    models: string[];
  }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [standard, setStandard] = useState<'openai' | 'anthropic'>('openai');
  const [baseUrl, setBaseUrl] = useState('');
  const [models, setModels] = useState('');
  return (
    <form
      className="provider-card"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({
          id: '',
          name,
          standard,
          baseUrl,
          models: models.split(/[,\s]+/).filter(Boolean),
        });
      }}
    >
      <h2>Thêm hãng khác</h2>
      <p className="hint">
        Bất kỳ địa chỉ nào nói chuẩn OpenAI hoặc chuẩn Anthropic. Lưu xong thì dán key ở mục của
        hãng vừa thêm (nếu hãng cần key).
      </p>
      <div className="form-group">
        <div className="form-row">
          <span className="form-label">Tên</span>
          <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="form-row">
          <span className="form-label">Chuẩn</span>
          <div className="segmented">
            {(['openai', 'anthropic'] as const).map((s) => (
              <button
                key={s}
                type="button"
                className={standard === s ? 'on' : ''}
                onClick={() => setStandard(s)}
              >
                {s === 'openai' ? 'OpenAI' : 'Anthropic'}
              </button>
            ))}
          </div>
        </div>
        <div className="form-row">
          <span className="form-label">Địa chỉ</span>
          <input
            className="text-input"
            value={baseUrl}
            placeholder="https://api.vi-du.com/v1"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>
        <div className="form-row">
          <span className="form-label">Tên model</span>
          <input
            className="text-input"
            value={models}
            placeholder="model-a, model-b"
            onChange={(e) => setModels(e.target.value)}
          />
        </div>
      </div>
      <div className="check-row">
        <button type="submit" className="push-btn primary" disabled={!name || !baseUrl || !models}>
          Lưu
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- Model theo việc

function TasksTab({
  view,
  update,
}: {
  view: ProvidersView;
  update: (patch: ProviderSettingsPatch) => Promise<unknown>;
}) {
  const models = useMemo(
    () =>
      view.providers
        .filter((p) => p.usable)
        .flatMap((p) => p.models.map((m) => ({ ...m, providerName: p.name }))),
    [view],
  );
  const [trying, setTrying] = useState<TaskKind | null>(null);
  const [tried, setTried] = useState<Partial<Record<TaskKind, TaskTryResult>>>({});

  if (!models.length) {
    return <p className="hint">Chưa có hãng nào dùng được. Dán key ở thẻ "Hãng & key" trước.</p>;
  }

  return (
    <div className="tasks">
      <p className="hint">
        Mỗi loại việc có model chính và model dự phòng. Không chọn thì NSA tự xếp model rẻ trước.
        Hãng lỗi hoặc hết hạn mức thì NSA tự chuyển sang model kế tiếp và báo bạn.
      </p>
      {view.tasks.map((t) => {
        const fits = models.filter((m) =>
          t.task === 'embedding' ? m.kind === 'embedding' : m.kind === 'chat',
        );
        const set = (primary: string, fallbacks: string[]) =>
          void update({
            kind: 'task',
            task: t.task,
            setting: { ...(primary ? { primary } : {}), fallbacks },
          });
        return (
          <div key={t.task} className="form-group task-card">
            <div className="form-row">
              <span className="form-label wide">{t.label}</span>
              <select
                className="select"
                value={t.setting.primary ?? ''}
                onChange={(e) => set(e.target.value, t.setting.fallbacks)}
              >
                <option value="">NSA tự chọn</option>
                {fits.map((m) => (
                  <option key={m.ref} value={m.ref}>
                    {m.name} · {m.providerName}
                  </option>
                ))}
              </select>
              <select
                className="select"
                value=""
                onChange={(e) =>
                  e.target.value &&
                  set(t.setting.primary ?? '', [...t.setting.fallbacks, e.target.value])
                }
              >
                <option value="">+ Dự phòng…</option>
                {fits
                  .filter(
                    (m) => m.ref !== t.setting.primary && !t.setting.fallbacks.includes(m.ref),
                  )
                  .map((m) => (
                    <option key={m.ref} value={m.ref}>
                      {m.name} · {m.providerName}
                    </option>
                  ))}
              </select>
            </div>
            <div className="form-row column">
              <div className="chain">
                {t.chain.length === 0 && <span className="hint">Chưa có model phù hợp.</span>}
                {t.chain.map((c, i) => (
                  <span key={c.ref} className={`chain-item ${c.chosen ? 'chosen' : ''}`}>
                    {i + 1}. {c.name} <span className="hint small">({c.providerName})</span>
                    {t.setting.fallbacks.includes(c.ref) && (
                      <button
                        type="button"
                        className="link-btn"
                        title="Bỏ khỏi dự phòng"
                        onClick={() =>
                          set(
                            t.setting.primary ?? '',
                            t.setting.fallbacks.filter((r) => r !== c.ref),
                          )
                        }
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
              </div>
              {t.task !== 'embedding' && t.task !== 'main' && (
                <div className="check-row">
                  <button
                    type="button"
                    className="push-btn"
                    disabled={trying !== null || t.chain.length === 0}
                    onClick={() => {
                      setTrying(t.task);
                      void window.nsa
                        .invoke(
                          'providers:tryTask',
                          t.task,
                          'Tóm tắt trong một câu: NSA điều phối nhiều agent AI và nhớ những gì người dùng dạy.',
                        )
                        .then((r) => setTried((prev) => ({ ...prev, [t.task]: r })))
                        .finally(() => setTrying(null));
                    }}
                  >
                    {trying === t.task ? 'Đang chạy…' : 'Chạy thử'}
                  </button>
                  {tried[t.task] && (
                    <span className={tried[t.task]?.ok ? '' : 'err'}>
                      {tried[t.task]?.ok
                        ? `${tried[t.task]?.model}: ${tried[t.task]?.text ?? ''}`
                        : tried[t.task]?.error}
                    </span>
                  )}
                </div>
              )}
              {tried[t.task]?.notices.map((n) => (
                <div key={n} className="notice-box">
                  {n}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- Chi phí

function CostTab({
  view,
  update,
}: {
  view: ProvidersView;
  update: (patch: ProviderSettingsPatch) => Promise<unknown>;
}) {
  const b = view.budget;
  const [limit, setLimit] = useState(b.limitUsd === null ? '' : String(b.limitUsd));
  const ratio = b.limitUsd ? Math.min(1, b.spentUsd / b.limitUsd) : 0;
  const totalTokens = view.usage.reduce((s, u) => s + u.inputTokens + u.outputTokens, 0);
  return (
    <div className="cost">
      <div className="form-group">
        <div className="form-row">
          <span className="form-label wide">Tháng {b.month}</span>
          <span className="form-value">
            Ước tính {usd(b.spentUsd)}
            {b.limitUsd !== null ? ` / hạn mức ${usd(b.limitUsd)}` : ''} ·{' '}
            {totalTokens.toLocaleString('vi-VN')} token
            {b.incomplete ? ' · có model chưa biết giá nên tổng thật có thể cao hơn' : ''}
          </span>
        </div>
        {b.limitUsd !== null && (
          <div className="form-row">
            <div className={`progress budget-${b.level}`}>
              <div style={{ width: `${Math.round(ratio * 100)}%` }} />
            </div>
          </div>
        )}
        <form
          className="form-row"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(limit.replace(',', '.'));
            void update({ kind: 'budget', monthlyUsd: limit.trim() && n > 0 ? n : null });
          }}
        >
          <span className="form-label wide">Hạn mức tháng (USD)</span>
          <input
            className="text-input"
            inputMode="decimal"
            value={limit}
            placeholder="Không đặt"
            onChange={(e) => setLimit(e.target.value)}
          />
          <button type="submit" className="push-btn">
            Lưu
          </button>
        </form>
        <label className="form-row">
          <span className="form-label wide">Cảnh báo khi đạt</span>
          <select
            className="select"
            value={String(b.warnAt)}
            onChange={(e) =>
              void update({
                kind: 'budget',
                monthlyUsd: b.limitUsd,
                warnAt: Number(e.target.value),
              })
            }
          >
            {[0.5, 0.7, 0.8, 0.9].map((v) => (
              <option key={v} value={v}>
                {Math.round(v * 100)}% hạn mức
              </option>
            ))}
          </select>
        </label>
        <label className="form-row">
          <span className="form-label wide">Dừng khi vượt</span>
          <span className="form-value">Chặn gọi model trả phí khi đã vượt hạn mức</span>
          <input
            type="checkbox"
            className="switch"
            checked={b.stopAtLimit}
            onChange={(e) =>
              void update({ kind: 'budget', monthlyUsd: b.limitUsd, stopAtLimit: e.target.checked })
            }
          />
        </label>
      </div>
      <p className="hint small">
        Chi phí là ước tính từ bảng giá trong file dữ liệu (giá công bố của hãng), không phải hoá
        đơn. Gói thuê bao CLI không tính ở đây.
      </p>
      <table className="model-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Lượt</th>
            <th>Token vào</th>
            <th>Token ra</th>
            <th>Ước tính</th>
          </tr>
        </thead>
        <tbody>
          {view.usage.length === 0 && (
            <tr>
              <td colSpan={5} className="hint">
                Chưa dùng model qua API tháng này.
              </td>
            </tr>
          )}
          {view.usage.map((u) => (
            <tr key={u.ref}>
              <td>
                {u.modelName}
                <div className="hint small">{u.providerName}</div>
              </td>
              <td>{u.calls}</td>
              <td>{u.inputTokens.toLocaleString('vi-VN')}</td>
              <td>{u.outputTokens.toLocaleString('vi-VN')}</td>
              <td>
                {usd(u.costUsd)}
                {u.unpricedCalls > 0 && (
                  <span className="hint small"> (+{u.unpricedCalls} chưa biết giá)</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
