import { useCallback, useEffect, useState } from 'react';
import type {
  PluginGrants,
  PluginIcon,
  PluginInfo,
  PluginSettings,
  PluginSource,
  PreparedInstall,
  RegistryEntry,
} from '@nsa/core';
import { ConfirmSheet } from './ConfirmSheet';
import { PluginScreen } from './PluginScreen';

type Mode =
  | { kind: 'grid' }
  | { kind: 'manage'; selected?: string }
  | { kind: 'open'; id: string; screen: string };

function cleanError(err: unknown): string {
  return String(err).replace(/^Error: Error invoking remote method '[^']+': (Error: )?/, '');
}

export function IconView({ icon, size = 44 }: { icon: PluginIcon; size?: number }) {
  return icon.kind === 'emoji' ? (
    <span className="plugin-emoji" style={{ fontSize: size * 0.62 }} aria-hidden="true">
      {icon.value}
    </span>
  ) : (
    <img src={icon.dataUrl} alt="" width={size} height={size} className="plugin-img" />
  );
}

/** Màn hình App Store: lưới app (ô vuông + tên), nút Quản lý ở góc; mở app thì hiện màn hình của nó. */
export function StoreView() {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'grid' });
  const [prepared, setPrepared] = useState<PreparedInstall | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => setPlugins(await window.nsa.invoke('plugins:list')), []);
  useEffect(() => {
    void window.nsa.invoke('plugins:list').then(setPlugins);
    return window.nsa.on('plugins:changed', setPlugins);
  }, []);

  async function act<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(cleanError(err));
      return undefined;
    }
  }

  /** Bắt đầu cài: main đọc + kiểm gói, rồi hộp xin quyền hiện ra. */
  async function prepare(source: PluginSource) {
    const result = await act(() => window.nsa.invoke('plugins:prepare', source));
    if (result) setPrepared(result);
  }

  if (mode.kind === 'open') {
    const plugin = plugins?.find((p) => p.id === mode.id);
    if (plugin) {
      return (
        <PluginScreen
          plugin={plugin}
          screenId={mode.screen}
          onBack={() => setMode({ kind: 'grid' })}
        />
      );
    }
  }

  const installed = plugins ?? [];
  const tiles = installed.filter((p) => p.enabled);

  return (
    <main className="chat store-screen">
      <header className="chat-head drag">
        <h1 className="chat-title">{mode.kind === 'manage' ? 'Quản lý app' : 'App Store'}</h1>
        {mode.kind === 'manage' ? (
          <button
            type="button"
            className="push-btn no-drag"
            onClick={() => setMode({ kind: 'grid' })}
          >
            Xong
          </button>
        ) : (
          <button
            type="button"
            className="push-btn no-drag"
            onClick={() => setMode({ kind: 'manage' })}
          >
            Quản lý
          </button>
        )}
      </header>
      <div className="messages store-body">
        {error && <div className="error-box">{error}</div>}
        {plugins === null && <p className="hint">Đang tải…</p>}

        {plugins !== null && mode.kind !== 'manage' && (
          <>
            {tiles.length === 0 ? (
              <div className="setup">
                <h2>Chưa có app nào</h2>
                <p className="hint">
                  Bấm <b>Quản lý</b> ở góc trên để cài app từ một thư mục hoặc gói plugin.
                </p>
              </div>
            ) : (
              <div className="app-grid">
                {tiles.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="app-tile"
                    title={p.description || p.name}
                    onClick={() =>
                      p.manifest.screens[0]
                        ? setMode({ kind: 'open', id: p.id, screen: p.manifest.screens[0].id })
                        : setMode({ kind: 'manage', selected: p.id })
                    }
                  >
                    <span className="app-icon">
                      <IconView icon={p.icon} />
                      {p.status !== 'running' && (
                        <span
                          className={`app-state ${p.status}`}
                          title={p.statusMessage ?? p.status}
                        />
                      )}
                    </span>
                    <span className="app-name">{p.name}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {plugins !== null && mode.kind === 'manage' && (
          <ManageTab
            plugins={installed}
            selected={mode.selected}
            onSelect={(id) => setMode({ kind: 'manage', ...(id ? { selected: id } : {}) })}
            onOpen={(p) =>
              p.manifest.screens[0] &&
              setMode({ kind: 'open', id: p.id, screen: p.manifest.screens[0].id })
            }
            prepare={prepare}
            act={act}
            reload={reload}
          />
        )}
      </div>

      {prepared && (
        <InstallSheet
          prepared={prepared}
          current={installed.find((p) => p.id === prepared.manifest.id)}
          onClose={() => setPrepared(null)}
          onInstalled={() => {
            setPrepared(null);
            void reload();
          }}
        />
      )}
    </main>
  );
}

// ---------------------------------------------------------------- Quản lý

function ManageTab({
  plugins,
  selected,
  onSelect,
  onOpen,
  prepare,
  act,
  reload,
}: {
  plugins: PluginInfo[];
  selected: string | undefined;
  onSelect: (id: string | undefined) => void;
  onOpen: (p: PluginInfo) => void;
  prepare: (source: PluginSource) => Promise<void>;
  act: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  reload: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<PluginSettings | null>(null);
  const [registry, setRegistry] = useState<RegistryEntry[] | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [registryDraft, setRegistryDraft] = useState('');

  useEffect(() => {
    void window.nsa.invoke('plugins:settings').then((s) => {
      setSettings(s);
      setRegistryDraft(s.registry);
    });
  }, []);

  useEffect(() => {
    if (!settings?.registry) return;
    let alive = true;
    window.nsa.invoke('plugins:registry').then(
      (entries) => {
        if (!alive) return;
        setRegistry(entries);
        setRegistryError(null);
      },
      (err: unknown) => {
        if (!alive) return;
        setRegistry(null);
        setRegistryError(cleanError(err));
      },
    );
    return () => {
      alive = false;
    };
  }, [settings?.registry, plugins.length]);

  const current = plugins.find((p) => p.id === selected) ?? plugins[0];

  return (
    <div className="manage-layout">
      <nav className="manage-list">
        <div className="section-label">Đã cài</div>
        {plugins.length === 0 && <p className="hint small pad">Chưa cài app nào.</p>}
        {plugins.map((p) => (
          <div
            key={p.id}
            className={`manage-item ${current?.id === p.id ? 'active' : ''}`}
            onClick={() => onSelect(p.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && onSelect(p.id)}
          >
            <span className="manage-icon">
              <IconView icon={p.icon} size={28} />
            </span>
            <span className="manage-name">
              {p.name}
              <span className="hint small">
                {' '}
                v{p.version}
                {!p.enabled
                  ? ' · tắt'
                  : p.status !== 'running'
                    ? ` · ${statusLabel(p.status)}`
                    : ''}
              </span>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={p.enabled}
              title={p.enabled ? 'Tắt' : 'Bật'}
              aria-label={`${p.enabled ? 'Tắt' : 'Bật'} ${p.name}`}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) =>
                void act(() => window.nsa.invoke('plugins:setEnabled', p.id, e.target.checked))
              }
            />
          </div>
        ))}

        <div className="section-label">Cài thêm</div>
        <div className="manage-actions">
          <button
            type="button"
            className="push-btn"
            onClick={() => void prepare({ kind: 'pick', what: 'file' })}
          >
            Cài từ gói (.nsapkg)…
          </button>
          <button
            type="button"
            className="push-btn"
            disabled={!settings?.developerMode}
            title={
              settings?.developerMode
                ? 'Cài từ thư mục plugin chưa ký'
                : 'Bật chế độ nhà phát triển để cài từ thư mục'
            }
            onClick={() => void prepare({ kind: 'pick', what: 'directory' })}
          >
            Cài từ thư mục…
          </button>
        </div>

        <div className="section-label">Kho</div>
        <div className="form-group">
          <div className="form-row column">
            <span className="form-label">Nguồn kho (đường dẫn hoặc URL của file chỉ mục)</span>
            <div className="inline-fields">
              <input
                className="text-input"
                value={registryDraft}
                placeholder="Chưa cấu hình"
                onChange={(e) => setRegistryDraft(e.target.value)}
              />
              <button
                type="button"
                className="push-btn"
                disabled={registryDraft === (settings?.registry ?? '')}
                onClick={() =>
                  void act(async () =>
                    setSettings(
                      await window.nsa.invoke('plugins:saveSettings', { registry: registryDraft }),
                    ),
                  )
                }
              >
                Lưu
              </button>
            </div>
          </div>
        </div>
        {registryError && <div className="error-box">{registryError}</div>}
        {registry?.map((e) => (
          <div key={e.id} className="registry-item">
            <div>
              <b>{e.name}</b> <span className="hint small">v{e.version}</span>
              {e.installed && <span className="hint small"> · đang cài v{e.installed}</span>}
              <div className="hint small">{e.description}</div>
              {!e.compatible && <div className="hint small warn-text">Cần NSA {e.nsa}</div>}
            </div>
            <button
              type="button"
              className="push-btn"
              disabled={!e.compatible || (!!e.installed && !e.updateAvailable)}
              onClick={() => void prepare({ kind: 'registry', id: e.id })}
            >
              {e.updateAvailable ? 'Cập nhật' : e.installed ? 'Đã cài' : 'Cài'}
            </button>
          </div>
        ))}

        <div className="section-label">Nhà phát triển</div>
        <label className="form-row dev-row">
          <span className="form-label">Chế độ nhà phát triển</span>
          <input
            type="checkbox"
            className="switch"
            checked={settings?.developerMode ?? false}
            onChange={(e) =>
              void act(async () =>
                setSettings(
                  await window.nsa.invoke('plugins:saveSettings', {
                    developerMode: e.target.checked,
                  }),
                ),
              )
            }
          />
        </label>
        <p className="hint small pad">
          Cho cài plugin <b>chưa ký</b> từ thư mục. NSA không bảo đảm plugin chưa ký an toàn — chỉ
          bật khi bạn tự viết plugin hoặc tin người viết.
        </p>
      </nav>

      <section className="manage-detail">
        {current ? (
          <PluginDetail
            key={current.id + current.version}
            plugin={current}
            act={act}
            reload={reload}
            onOpen={() => onOpen(current)}
            onRemoved={() => onSelect(undefined)}
          />
        ) : (
          <p className="hint">Chọn một app ở bên trái để xem quyền và quản lý.</p>
        )}
      </section>
    </div>
  );
}

function statusLabel(status: PluginInfo['status']): string {
  return {
    stopped: 'đã dừng',
    starting: 'đang khởi động',
    running: 'đang chạy',
    crashed: 'vừa sập, đang khởi động lại',
    failed: 'lỗi',
  }[status];
}

function SignatureBadge({ plugin }: { plugin: Pick<PluginInfo, 'signature' | 'publisher'> }) {
  switch (plugin.signature) {
    case 'trusted':
      return <span className="tag sig-ok">Đã ký · {plugin.publisher}</span>;
    case 'untrusted':
      return <span className="tag sig-warn">Ký bởi {plugin.publisher} (chưa tin cậy)</span>;
    case 'unsigned':
      return <span className="tag sig-warn">Chưa ký · nhà phát triển</span>;
    default:
      return <span className="tag sig-bad">Chữ ký không khớp</span>;
  }
}

function PluginDetail({
  plugin: p,
  act,
  reload,
  onOpen,
  onRemoved,
}: {
  plugin: PluginInfo;
  act: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  reload: () => Promise<void>;
  onOpen: () => void;
  onRemoved: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const want = p.manifest.permissions;

  const setGrants = (grants: PluginGrants) =>
    act(async () => {
      await window.nsa.invoke('plugins:updateGrants', p.id, grants);
      await reload();
    });

  async function chooseFolder(id: string, label: string) {
    const path = await window.nsa.invoke('plugins:pickFolder', label);
    if (path) await setGrants({ ...p.grants, folders: { ...p.grants.folders, [id]: path } });
  }

  const noPermissions =
    want.network.length === 0 &&
    want.folders.length === 0 &&
    !want.memory &&
    !want.notifications &&
    !want.model;

  return (
    <div className="plugin-detail">
      <div className="plugin-head">
        <span className="app-icon big">
          <IconView icon={p.icon} size={64} />
        </span>
        <div className="plugin-head-text">
          <h2>{p.name}</h2>
          <div className="hint">
            v{p.version}
            {p.author ? ` · ${p.author}` : ''} · id: {p.id}
          </div>
          <div className="tags">
            <SignatureBadge plugin={p} />
            <span className={`tag status-${p.status}`}>
              {p.enabled ? statusLabel(p.status) : 'tắt'}
            </span>
          </div>
        </div>
        <div className="plugin-head-buttons">
          {p.manifest.screens[0] && p.enabled && (
            <button type="button" className="push-btn primary" onClick={onOpen}>
              Mở
            </button>
          )}
          <button type="button" className="push-btn danger" onClick={() => setRemoving(true)}>
            Gỡ…
          </button>
        </div>
      </div>
      {p.description && <p>{p.description}</p>}
      {p.statusMessage && p.status !== 'running' && (
        <div className="error-box pre">{p.statusMessage}</div>
      )}
      {p.developer && (
        <div className="warn-box">
          Plugin này không có chữ ký tin cậy: NSA không bảo đảm nó an toàn. Nó vẫn bị giới hạn trong
          các quyền bên dưới.
        </div>
      )}

      <h3>Quyền</h3>
      {noPermissions && (
        <p className="hint">
          Plugin này không xin quyền nào: không mạng, không thư mục, không bộ nhớ.
        </p>
      )}
      <div className="form-group">
        {want.network.map((domain) => (
          <label key={domain} className="form-row">
            <span className="form-label">
              Truy cập mạng tới <b>{domain}</b>
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={p.grants.network.includes(domain)}
              onChange={(e) =>
                void setGrants({
                  ...p.grants,
                  network: e.target.checked
                    ? [...p.grants.network, domain]
                    : p.grants.network.filter((d) => d !== domain),
                })
              }
            />
          </label>
        ))}
        {want.folders.map((f) => (
          <div key={f.id} className="form-row">
            <span className="form-label">
              {f.access === 'readwrite' ? 'Đọc và ghi' : 'Đọc'} thư mục <b>{f.label}</b>
              <span className="hint small cwd"> {p.grants.folders[f.id] ?? 'chưa cấp'}</span>
            </span>
            <button
              type="button"
              className="push-btn"
              onClick={() => void chooseFolder(f.id, f.label)}
            >
              {p.grants.folders[f.id] ? 'Đổi…' : 'Chọn…'}
            </button>
            {p.grants.folders[f.id] && (
              <button
                type="button"
                className="push-btn"
                onClick={() => {
                  const folders = { ...p.grants.folders };
                  delete folders[f.id];
                  void setGrants({ ...p.grants, folders });
                }}
              >
                Thu hồi
              </button>
            )}
          </div>
        ))}
        {want.memory && (
          <label className="form-row">
            <span className="form-label">
              Đọc và đề xuất ghi vào nhánh nhớ riêng (qua hộp duyệt)
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={p.grants.memory}
              onChange={(e) => void setGrants({ ...p.grants, memory: e.target.checked })}
            />
          </label>
        )}
        {want.notifications && (
          <label className="form-row">
            <span className="form-label">Hiện thông báo</span>
            <input
              type="checkbox"
              className="switch"
              checked={p.grants.notifications}
              onChange={(e) => void setGrants({ ...p.grants, notifications: e.target.checked })}
            />
          </label>
        )}
        {want.model && (
          <label className="form-row">
            <span className="form-label">
              Nhờ NSA chạy model &quot;kênh chat&quot; (nội dung tin nhắn đi tới nhà cung cấp model)
            </span>
            <input
              type="checkbox"
              className="switch"
              checked={p.grants.model}
              onChange={(e) => void setGrants({ ...p.grants, model: e.target.checked })}
            />
          </label>
        )}
      </div>
      {p.manifest.warning && <div className="warn-box left">{p.manifest.warning}</div>}
      {p.secrets.length > 0 && (
        <>
          <h3>Bí mật (token, khoá)</h3>
          <p className="hint small">
            Giá trị cất trong kho khoá của hệ điều hành. Plugin KHÔNG đọc được: nó chỉ nhờ NSA điền
            vào lời gọi mạng tới đúng tên miền ghi bên dưới.
          </p>
          {p.secrets.map((s) => (
            <SecretRow key={s.id} plugin={p} secret={s} act={act} />
          ))}
        </>
      )}
      {!noPermissions && (
        <p className="hint small">
          Thu hồi quyền có hiệu lực ngay: plugin được khởi động lại với quyền mới.
        </p>
      )}

      {p.manifest.tools.length > 0 && (
        <>
          <h3>Tool cho agent</h3>
          <ul className="plain-list">
            {p.manifest.tools.map((t) => (
              <li key={t.name}>
                <code>{t.name}</code> — {t.description}{' '}
                {t.sensitive && <span className="tag sig-warn">nhạy cảm · luôn hỏi</span>}
                {t.readOnly && <span className="tag">chỉ đọc</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {p.jobs.length > 0 && (
        <>
          <h3>Việc chạy nền</h3>
          <ul className="plain-list">
            {p.jobs.map((j) => (
              <li key={j.id}>
                {j.title}
                {j.everySeconds ? ` · mỗi ${j.everySeconds} giây` : ''}
                {j.lastRun ? ` · lần cuối ${new Date(j.lastRun).toLocaleTimeString()}` : ''}
                {j.lastError && <span className="warn-text"> · lỗi: {j.lastError}</span>}{' '}
                <button
                  type="button"
                  className="link-btn"
                  disabled={p.status !== 'running'}
                  onClick={() => void act(() => window.nsa.invoke('plugins:runJob', p.id, j.id))}
                >
                  Chạy thử
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {removing && (
        <ConfirmSheet
          title={`Gỡ "${p.name}"?`}
          message="Plugin dừng ngay và bị xoá khỏi máy, kể cả dữ liệu riêng của nó. Các mục nó đã ghi vào bộ nhớ NSA được giữ lại."
          confirmLabel="Gỡ"
          onCancel={() => setRemoving(false)}
          onConfirm={() => {
            setRemoving(false);
            void act(async () => {
              await window.nsa.invoke('plugins:uninstall', p.id, true);
              onRemoved();
              await reload();
            });
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Hộp xin quyền khi cài

function InstallSheet({
  prepared,
  current,
  onClose,
  onInstalled,
}: {
  prepared: PreparedInstall;
  current: PluginInfo | undefined;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const want = prepared.manifest.permissions;
  const isNew = (text: string): boolean => prepared.newPermissions.includes(text);
  // Cập nhật: giữ quyền đã cấp, quyền mới xin thêm mặc định CHƯA cấp.
  const [grants, setGrants] = useState<PluginGrants>(() => ({
    network: want.network.filter((d) => (current ? current.grants.network.includes(d) : true)),
    folders: current ? { ...current.grants.folders } : {},
    memory: want.memory && (current ? current.grants.memory : true),
    notifications: want.notifications && (current ? current.grants.notifications : true),
    model: want.model && (current ? current.grants.model : true),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReason, setConfirmReason] = useState<string | null>(null);

  async function install(confirmed: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await window.nsa.invoke(
        'plugins:install',
        prepared.prepareId,
        grants,
        confirmed,
      );
      if (result.status === 'installed') onInstalled();
      else if (result.status === 'needs_confirmation') setConfirmReason(result.reason);
      else setError(result.reason);
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  }

  const noPermissions =
    want.network.length === 0 &&
    want.folders.length === 0 &&
    !want.memory &&
    !want.notifications &&
    !want.model;
  const m = prepared.manifest;

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="alert install-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-title"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="app-icon big">
          <IconView icon={prepared.icon} size={64} />
        </span>
        <h2 id="install-title">{prepared.upgradeFrom ? `Cập nhật ${m.name}` : `Cài ${m.name}?`}</h2>
        <div className="hint">
          v{m.version}
          {prepared.upgradeFrom ? ` (đang dùng v${prepared.upgradeFrom})` : ''}
          {m.author ? ` · ${m.author}` : ''}
        </div>
        <div className="tags center">
          <SignatureBadge
            plugin={{
              signature: prepared.signature,
              ...(prepared.publisher ? { publisher: prepared.publisher } : {}),
            }}
          />
        </div>
        {m.description && <p>{m.description}</p>}

        {prepared.blocked ? (
          <>
            <div className="error-box left">{prepared.blocked}</div>
            <div className="alert-buttons">
              <button type="button" className="alert-btn primary" onClick={onClose}>
                Đóng
              </button>
            </div>
          </>
        ) : (
          <>
            {prepared.warnings.map((w) => (
              <div key={w} className="warn-box left">
                {w}
              </div>
            ))}
            <div className="perm-list left">
              <div className="section-label">
                {noPermissions ? 'Không xin quyền nào' : 'Plugin xin các quyền sau'}
              </div>
              {want.network.map((d) => (
                <label key={d} className="perm-row">
                  <input
                    type="checkbox"
                    checked={grants.network.includes(d)}
                    onChange={(e) =>
                      setGrants({
                        ...grants,
                        network: e.target.checked
                          ? [...grants.network, d]
                          : grants.network.filter((x) => x !== d),
                      })
                    }
                  />
                  <span>
                    Truy cập mạng tới <b>{d}</b>
                    {isNew(`Truy cập mạng tới ${d}`) && <span className="tag sig-warn">mới</span>}
                  </span>
                </label>
              ))}
              {want.folders.map((f) => (
                <div key={f.id} className="perm-row">
                  <input type="checkbox" checked={!!grants.folders[f.id]} readOnly disabled />
                  <span>
                    {f.access === 'readwrite' ? 'Đọc và ghi' : 'Đọc'} thư mục <b>{f.label}</b>{' '}
                    <span className="hint small cwd">{grants.folders[f.id] ?? 'chưa chọn'}</span>
                  </span>
                  <button
                    type="button"
                    className="push-btn"
                    onClick={() =>
                      void window.nsa.invoke('plugins:pickFolder', f.label).then((path) => {
                        if (path)
                          setGrants({ ...grants, folders: { ...grants.folders, [f.id]: path } });
                      })
                    }
                  >
                    Chọn…
                  </button>
                </div>
              ))}
              {want.memory && (
                <label className="perm-row">
                  <input
                    type="checkbox"
                    checked={grants.memory}
                    onChange={(e) => setGrants({ ...grants, memory: e.target.checked })}
                  />
                  <span>
                    Đọc và đề xuất ghi vào nhánh nhớ riêng (qua hộp duyệt)
                    {isNew('Nhánh nhớ riêng') && <span className="tag sig-warn">mới</span>}
                  </span>
                </label>
              )}
              {want.notifications && (
                <label className="perm-row">
                  <input
                    type="checkbox"
                    checked={grants.notifications}
                    onChange={(e) => setGrants({ ...grants, notifications: e.target.checked })}
                  />
                  <span>
                    Hiện thông báo
                    {isNew('Hiện thông báo') && <span className="tag sig-warn">mới</span>}
                  </span>
                </label>
              )}
              {want.model && (
                <label className="perm-row">
                  <input
                    type="checkbox"
                    checked={grants.model}
                    onChange={(e) => setGrants({ ...grants, model: e.target.checked })}
                  />
                  <span>
                    Nhờ NSA chạy model &quot;kênh chat&quot; — nội dung tin nhắn được gửi tới nhà
                    cung cấp model bạn chọn
                    {isNew('Dùng model "kênh chat"') && <span className="tag sig-warn">mới</span>}
                  </span>
                </label>
              )}
              {m.secrets.length > 0 && (
                <p className="hint small left">
                  Plugin cần nhập: {m.secrets.map((s) => s.label).join('; ')}. Nhập sau khi cài ở
                  Quản lý — giá trị cất trong kho khoá của hệ điều hành, plugin không đọc được.
                </p>
              )}
            </div>
            {m.tools.some((t) => t.sensitive) && (
              <p className="hint small left">
                Thao tác nhạy cảm (
                {m.tools
                  .filter((t) => t.sensitive)
                  .map((t) => t.name)
                  .join(', ')}
                ) luôn hỏi bạn trước khi chạy.
              </p>
            )}
            <p className="hint small left">
              Bỏ chọn quyền nào thì plugin không có quyền đó. Có thể đổi lại bất cứ lúc nào ở màn
              hình Quản lý.
            </p>
            {error && <div className="error-box left">{error}</div>}
            <div className="alert-buttons">
              <button type="button" className="alert-btn" onClick={onClose} disabled={busy}>
                Huỷ
              </button>
              <button
                type="button"
                className="alert-btn primary"
                disabled={busy}
                onClick={() => void install(false)}
              >
                {prepared.upgradeFrom ? 'Cập nhật' : 'Cài'}
              </button>
            </div>
          </>
        )}
      </div>
      {confirmReason && (
        <ConfirmSheet
          title={prepared.riskWarning ? 'Bạn hiểu rủi ro chứ?' : 'Cài plugin chưa được tin cậy?'}
          message={confirmReason}
          confirmLabel={prepared.riskWarning ? 'Tôi hiểu, vẫn cài' : 'Vẫn cài'}
          onCancel={() => setConfirmReason(null)}
          onConfirm={() => {
            setConfirmReason(null);
            void install(true);
          }}
        />
      )}
    </div>
  );
}

/**
 * Một khe bí mật của plugin (token bot…). Ô nhập do NSA vẽ — KHÔNG nằm trong màn hình của plugin —
 * và giá trị đi thẳng vào kho khoá; ô không bao giờ hiện lại giá trị, chỉ bốn ký tự cuối.
 */
function SecretRow({
  plugin,
  secret,
  act,
}: {
  plugin: PluginInfo;
  secret: PluginInfo['secrets'][number];
  act: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
}) {
  const [value, setValue] = useState('');
  return (
    <div className="form-row secret-row">
      <span className="form-label">
        {secret.label}
        <span className="hint small"> · chỉ gửi tới {secret.hosts.join(', ')}</span>
        {secret.help && <span className="hint small"> · {secret.help}</span>}
      </span>
      <span className="secret-input">
        {secret.set && <span className="tag sig-ok">đã lưu {secret.hint}</span>}
        <input
          className="text-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={secret.set ? 'Dán giá trị mới để thay' : 'Dán vào đây'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          type="button"
          className="push-btn"
          disabled={value.trim() === ''}
          onClick={() =>
            void act(async () => {
              await window.nsa.invoke('plugins:setSecret', plugin.id, secret.id, value.trim());
              setValue('');
            })
          }
        >
          Lưu
        </button>
        {secret.set && (
          <button
            type="button"
            className="push-btn danger"
            onClick={() =>
              void act(async () => {
                await window.nsa.invoke('plugins:deleteSecret', plugin.id, secret.id);
              })
            }
          >
            Xoá
          </button>
        )}
      </span>
    </div>
  );
}
