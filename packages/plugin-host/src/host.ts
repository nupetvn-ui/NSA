/**
 * Plugin host: cài (từ thư mục hoặc gói `.nsapkg`), bật / tắt / gỡ, cập nhật, cấp và thu hồi
 * quyền — tất cả khi app đang chạy, không cần khởi động lại. Mỗi plugin chạy trong một tiến
 * trình riêng (`process.ts`); mọi thứ plugin đòi từ bên ngoài (mạng, bộ nhớ, thông báo, cấu hình)
 * đi qua host và bị kiểm theo quyền người dùng đã cấp. Xem ADR-0010.
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { AuditEntry, AuditLog, IdentityProvider, Policy, PolicyAction } from '@nsa/core';
import type { GatewayTool } from '@nsa/mcp-gateway';
import {
  compareVersions,
  domainAllowed,
  gatewayToolName,
  MANIFEST_FILE,
  formatManifestErrors,
  isCompatible,
  parseVersion,
  SECRET_PLACEHOLDER_SOURCE,
  validateManifest,
  type InstallResult,
  type MemoryHit,
  type MemoryNote,
  type MemoryProposeResult,
  type PluginGrants,
  type PluginIcon,
  type PluginInfo,
  type PluginManifest,
  type PluginSecretInfo,
  type PluginSettings,
  type PluginStatus,
  type PreparedInstall,
  type RegistryEntry,
  type SignatureStatus,
} from '@nsa/plugin-sdk';
import {
  collectDirectory,
  extractFiles,
  readManifestFromFiles,
  readPackage,
  verifyPackage,
  type TrustedPublisher,
  type Verification,
} from './pack.js';
import {
  defaultResolver,
  matchAllow,
  minimalEnv,
  runCli,
  validateArgs,
  type CliResolver,
} from './cli-run.js';
import { PluginProcess, type ReadyInfo } from './process.js';
import { RUNNER_SOURCE } from './runner-source.js';
import { PluginRegistry } from './registry.js';

/** Cầu nối tới NSA Mem — do app cắm vào, host không biết gì về kho nhớ. */
export interface PluginMemoryBridge {
  /** Tạo (ẩn) nhánh của plugin và mọi nhánh cha nếu chưa có. */
  ensureBranch(path: string, title: string): Promise<void>;
  search(branch: string, query: string, limit: number): Promise<MemoryHit[]>;
  read(branch: string, id: string): Promise<MemoryNote | null>;
  /** Mục nhớ đã duyệt trong nhánh (kể cả nhánh con), mới nhất trước. */
  list(branch: string, limit: number): Promise<MemoryNote[]>;
  propose(
    branch: string,
    pluginId: string,
    input: {
      title: string;
      body: string;
      kind?: 'fact' | 'preference' | 'rule';
      subject?: string;
      confidence?: number;
    },
  ): Promise<MemoryProposeResult>;
}

/** Kho khoá cho bí mật của plugin — cùng hình dạng `SecretStore` của gói providers. */
export interface PluginSecretStore {
  available(): boolean;
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): void;
  has(name: string): boolean;
  hint(name: string): string | undefined;
}

export interface PluginHostOptions {
  /** Tìm chương trình cho quyền `cli` (mặc định: PATH). Test thay bằng `node fake.js`. */
  cliResolver?: CliResolver;
  /** Kho khoá của hệ điều hành. Không có thì plugin có khe bí mật sẽ báo "chưa nhập". */
  secrets?: PluginSecretStore;
  /** Chạy model của việc "kênh chat" (qua ModelTaskRunner của app: chính sách, chi phí, dự phòng). */
  model?: (pluginId: string, prompt: string, options: { system?: string }) => Promise<string>;
  /** Hỏi người dùng (hộp thoại) khi chính sách trả "hỏi" cho hành động nền. Hết hạn = từ chối. */
  confirm?: (pluginId: string, text: string, signal: AbortSignal) => Promise<boolean>;
  /** Che thêm các chuỗi bí mật khác của app (key API…) khỏi nội dung gửi model / nhật ký. */
  redact?: (text: string) => string;
  /** Thư mục gốc của plugin host: `<userData>/plugins`. */
  dir: string;
  /** Phiên bản NSA đang chạy (kiểm tương thích). */
  nsaVersion: string;
  identity: IdentityProvider;
  policy: Policy;
  audit?: AuditLog;
  /** Khoá nhà phát hành NSA tin cậy. */
  trustedPublishers?: TrustedPublisher[];
  memory?: PluginMemoryBridge;
  notify?: (pluginId: string, notification: { title: string; body?: string }) => void;
  /** Danh sách plugin / trạng thái đổi — giao diện tải lại. */
  onChange?: () => void;
  /** Plugin gửi sự kiện cho màn hình của nó. */
  onUiEvent?: (pluginId: string, event: string, data: unknown) => void;
  /** Chương trình chạy plugin (mặc định `process.execPath`). Trong Electron: `electron: true`. */
  runtime?: { execPath?: string; electron?: boolean };
  /** Thời hạn mỗi lần gọi tool (ms, mặc định 30 giây). */
  toolTimeoutMs?: number;
  jobTimeoutMs?: number;
  startTimeoutMs?: number;
  /** Chu kỳ kiểm tra plugin còn sống (ms, mặc định 15 giây; 0 = tắt). */
  heartbeatMs?: number;
  maxMemoryMb?: number;
  now?: () => Date;
}

interface PluginRecord {
  enabled: boolean;
  version: string;
  signature: SignatureStatus;
  publisher?: string;
  developer: boolean;
  grants: PluginGrants;
  installedAt: string;
}

interface StateFile {
  settings: PluginSettings;
  plugins: Record<string, PluginRecord>;
}

interface Entry {
  id: string;
  manifest: PluginManifest;
  record: PluginRecord;
  icon: PluginIcon;
  status: PluginStatus;
  statusMessage?: string;
  process: PluginProcess | null;
  ready: ReadyInfo | null;
  restarts: number[];
  timers: NodeJS.Timeout[];
  jobs: Map<
    string,
    { lastRun?: string; lastError?: string; running: boolean; done?: Promise<void> }
  >;
  configLock: Promise<void>;
  generation: number;
  /** Số lời gọi tool nhạy cảm đang chạy theo tên — cổng MCP đã hỏi người dùng rồi. */
  sensitiveInFlight: Map<string, number>;
}

interface Pending {
  files: Record<string, string>;
  manifest: PluginManifest;
  verification: Verification;
  expires: number;
}

const DEFAULT_SETTINGS: PluginSettings = { developerMode: false, registry: '' };
const FETCH_LIMIT = 10 * 1024 * 1024;
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
]);

export class PluginHost {
  readonly dir: string;
  readonly #o: PluginHostOptions;
  readonly #entries = new Map<string, Entry>();
  readonly #pending = new Map<string, Pending>();
  #state: StateFile;
  #runnerPath = '';
  #heartbeat: NodeJS.Timeout | null = null;
  #closed = false;

  private constructor(options: PluginHostOptions, state: StateFile) {
    this.#o = options;
    this.dir = options.dir;
    this.#state = state;
  }

  static async open(options: PluginHostOptions): Promise<PluginHost> {
    mkdirSync(join(options.dir, 'installed'), { recursive: true });
    mkdirSync(join(options.dir, 'data'), { recursive: true });
    mkdirSync(join(options.dir, 'runtime'), { recursive: true });
    const host = new PluginHost(options, loadState(join(options.dir, 'state.json')));
    // Runner nằm ngoài thư mục cài của mọi plugin; ghi lại mỗi lần mở để luôn đúng phiên bản.
    host.#runnerPath = join(options.dir, 'runtime', 'runner.mjs');
    writeFileSync(host.#runnerPath, RUNNER_SOURCE, 'utf8');
    for (const [id, record] of Object.entries(host.#state.plugins)) {
      try {
        const manifest = host.#loadManifest(id);
        host.#entries.set(id, host.#newEntry(id, manifest, record));
      } catch (err) {
        console.error(`[plugins] bỏ qua "${id}": ${String(err)}`);
        delete host.#state.plugins[id];
      }
    }
    host.#saveState();
    for (const entry of host.#entries.values()) {
      if (entry.record.enabled) void host.#start(entry);
    }
    const beat = options.heartbeatMs ?? 15_000;
    if (beat > 0) {
      host.#heartbeat = setInterval(() => host.#checkAlive(), beat);
      host.#heartbeat.unref();
    }
    return host;
  }

  // ------------------------------------------------------------ Đọc

  list(): PluginInfo[] {
    return [...this.#entries.values()]
      .map((e) => this.#info(e))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): PluginInfo | null {
    const entry = this.#entries.get(id);
    return entry ? this.#info(entry) : null;
  }

  settings(): PluginSettings {
    return { ...this.#state.settings };
  }

  saveSettings(patch: Partial<PluginSettings>): PluginSettings {
    this.#state.settings = {
      developerMode:
        typeof patch.developerMode === 'boolean'
          ? patch.developerMode
          : this.#state.settings.developerMode,
      registry:
        typeof patch.registry === 'string' ? patch.registry.trim() : this.#state.settings.registry,
    };
    this.#saveState();
    this.#changed();
    return this.settings();
  }

  #info(e: Entry): PluginInfo {
    return {
      id: e.id,
      name: e.manifest.name,
      description: e.manifest.description,
      version: e.manifest.version,
      author: e.manifest.author,
      icon: e.icon,
      enabled: e.record.enabled,
      status: e.status,
      ...(e.statusMessage ? { statusMessage: e.statusMessage } : {}),
      signature: e.record.signature,
      ...(e.record.publisher ? { publisher: e.record.publisher } : {}),
      developer: e.record.developer,
      manifest: e.manifest,
      grants: structuredClone(e.record.grants),
      jobs: e.manifest.jobs.map((j) => {
        const state = e.jobs.get(j.id);
        return {
          id: j.id,
          title: j.title,
          ...(j.everySeconds ? { everySeconds: j.everySeconds } : {}),
          ...(state?.lastRun ? { lastRun: state.lastRun } : {}),
          ...(state?.lastError ? { lastError: state.lastError } : {}),
        };
      }),
      secrets: this.#secretInfos(e),
      installedAt: e.record.installedAt,
    };
  }

  #secretInfos(e: Entry): PluginSecretInfo[] {
    const store = this.#o.secrets;
    return e.manifest.secrets.map((s) => {
      const name = secretName(e.id, s.id);
      const hint = store?.hint(name);
      return {
        id: s.id,
        label: s.label,
        help: s.help,
        hosts: s.hosts,
        where: s.where,
        set: store?.has(name) ?? false,
        ...(hint ? { hint } : {}),
      };
    });
  }

  // ------------------------------------------------------------ Cài đặt

  /** Đọc gói / thư mục, kiểm manifest + chữ ký + phiên bản, rồi chờ người dùng xem quyền và xác nhận. */
  prepareFromDirectory(dir: string): PreparedInstall {
    const files = collectDirectory(dir);
    return this.#prepare(files, { status: 'unsigned' });
  }

  prepareFromPackage(bytes: Buffer): PreparedInstall {
    const pkg = readPackage(bytes);
    return this.#prepare(pkg.files, verifyPackage(pkg, this.#o.trustedPublishers ?? []));
  }

  prepareFromFile(path: string): PreparedInstall {
    if (statSync(path).isDirectory()) return this.prepareFromDirectory(path);
    return this.prepareFromPackage(readFileSync(path));
  }

  #prepare(files: Record<string, string>, verification: Verification): PreparedInstall {
    const manifest = readManifestFromFiles(files);
    const existing = this.#entries.get(manifest.id);
    const warnings: string[] = [];
    let blocked: string | undefined;
    const developerMode = this.#state.settings.developerMode;

    const edition = this.#o.identity.current().edition;
    if (manifest.editions.length > 0 && !manifest.editions.includes(edition)) {
      blocked = `Plugin "${manifest.name}" chỉ có ở bản ${manifest.editions.join(' / ')}; bạn đang dùng bản ${edition}.`;
    } else if (verification.status === 'tampered') {
      blocked =
        'Gói đã bị sửa sau khi được ký (hoặc chữ ký hỏng). NSA từ chối cài để bảo vệ bạn — hãy tải lại gói từ nguồn gốc.';
    } else if (!isCompatible(manifest, this.#o.nsaVersion)) {
      blocked = `Plugin cần NSA phiên bản ${manifest.nsa}, bạn đang dùng ${this.#o.nsaVersion}. Hãy cập nhật NSA hoặc dùng bản plugin khác.`;
    } else if (verification.status === 'unsigned') {
      if (!developerMode) {
        blocked =
          'Plugin chưa được ký. Chỉ cài được khi bật chế độ nhà phát triển (Quản lý → Chế độ nhà phát triển).';
      } else {
        warnings.push(
          'Plugin CHƯA ĐƯỢC KÝ: NSA không biết ai viết nó và không bảo đảm nó an toàn. Chỉ cài nếu bạn tự viết hoặc tin người viết.',
        );
      }
    } else if (verification.status === 'untrusted') {
      if (!developerMode) {
        blocked = `Plugin được ký bởi "${verification.publisher ?? '?'}" — nhà phát hành này chưa được NSA tin cậy. Chỉ cài được khi bật chế độ nhà phát triển.`;
      } else {
        warnings.push(
          `Chữ ký đúng nhưng nhà phát hành "${verification.publisher ?? '?'}" chưa được NSA tin cậy. Chỉ cài nếu bạn tin họ.`,
        );
      }
    }

    const prepareId = randomBytes(8).toString('hex');
    this.#sweepPending();
    this.#pending.set(prepareId, {
      files,
      manifest,
      verification,
      expires: Date.now() + 10 * 60_000,
    });
    if (this.#pending.size > 8) {
      const oldest = this.#pending.keys().next().value;
      if (oldest) this.#pending.delete(oldest);
    }
    if (manifest.warning) warnings.unshift(manifest.warning);
    const prepared: PreparedInstall = {
      prepareId,
      ...(manifest.warning ? { riskWarning: manifest.warning } : {}),
      manifest,
      icon: iconFor(manifest, files),
      signature: verification.status,
      ...(verification.publisher ? { publisher: verification.publisher } : {}),
      ...(existing ? { upgradeFrom: existing.manifest.version } : {}),
      newPermissions: existing ? newPermissions(existing.manifest, manifest) : [],
      warnings,
      ...(blocked ? { blocked } : {}),
    };
    return prepared;
  }

  #sweepPending(): void {
    const now = Date.now();
    for (const [id, p] of this.#pending) if (p.expires < now) this.#pending.delete(id);
  }

  /**
   * Cài thật. `grants` là phần quyền người dùng đồng ý (tập con của điều plugin xin). Chính sách
   * trả "hỏi" → `needs_confirmation`; giao diện hỏi lại rồi gọi lại với `confirmed: true`.
   */
  async install(
    prepareId: string,
    grants: Partial<PluginGrants>,
    confirmed = false,
  ): Promise<InstallResult> {
    this.#sweepPending();
    const pending = this.#pending.get(prepareId);
    if (!pending)
      return { status: 'denied', reason: 'Phiên cài đã hết hạn — hãy chọn lại plugin.' };
    const { manifest, files, verification } = pending;
    const existing = this.#entries.get(manifest.id);
    if (verification.status === 'tampered') {
      return { status: 'denied', reason: 'Gói đã bị sửa sau khi ký — từ chối cài.' };
    }
    if (!isCompatible(manifest, this.#o.nsaVersion)) {
      return {
        status: 'denied',
        reason: `Plugin cần NSA ${manifest.nsa}, bạn đang dùng ${this.#o.nsaVersion}.`,
      };
    }
    const edition = this.#o.identity.current().edition;
    if (manifest.editions.length > 0 && !manifest.editions.includes(edition)) {
      return {
        status: 'denied',
        reason: `Plugin này chỉ có ở bản ${manifest.editions.join(' / ')}; bạn đang dùng bản ${edition}.`,
      };
    }
    if (manifest.warning && !confirmed) {
      return { status: 'needs_confirmation', reason: manifest.warning };
    }
    const clean = this.#cleanGrants(manifest, grants);
    const op = existing ? 'update' : 'install';
    const verdict = await this.#check(
      {
        kind: 'plugin.manage',
        op,
        pluginId: manifest.id,
        version: manifest.version,
        signature:
          verification.status === 'trusted'
            ? 'trusted'
            : verification.status === 'untrusted'
              ? 'untrusted'
              : 'unsigned',
        developerMode: this.#state.settings.developerMode,
        permissions: describePermissions(manifest, clean),
      },
      confirmed,
    );
    if (verdict.decision === 'deny') {
      this.#audit({
        op: 'denied',
        pluginId: manifest.id,
        version: manifest.version,
        decision: 'deny',
        detail: verdict.reason,
      });
      return { status: 'denied', reason: verdict.reason };
    }
    if (verdict.decision === 'ask') return { status: 'needs_confirmation', reason: verdict.reason };

    if (existing) await this.#stop(existing);
    const finalDir = this.#installDir(manifest.id);
    const tmpDir = `${finalDir}.tmp-${randomBytes(4).toString('hex')}`;
    try {
      extractFiles(files, tmpDir);
      rmSync(finalDir, { recursive: true, force: true });
      renameSync(tmpDir, finalDir);
    } catch (err) {
      rmSync(tmpDir, { recursive: true, force: true });
      throw err;
    }
    mkdirSync(this.#dataDir(manifest.id), { recursive: true });

    const record: PluginRecord = {
      enabled: true,
      version: manifest.version,
      signature: verification.status,
      ...(verification.publisher ? { publisher: verification.publisher } : {}),
      developer: verification.status !== 'trusted',
      grants: clean,
      installedAt: existing?.record.installedAt ?? this.#now().toISOString(),
    };
    this.#state.plugins[manifest.id] = record;
    this.#saveState();
    const entry = this.#newEntry(manifest.id, manifest, record);
    this.#entries.set(manifest.id, entry);
    this.#pending.delete(prepareId);
    this.#audit({
      op: existing ? 'update' : 'install',
      pluginId: manifest.id,
      version: manifest.version,
      decision: 'allow',
      detail: `chữ ký: ${verification.status}; quyền: ${describePermissions(manifest, clean).join('; ') || 'không'}`,
    });
    await this.#ensureMemoryBranch(entry);
    this.#changed();
    await this.#start(entry);
    return { status: 'installed', plugin: this.#info(entry) };
  }

  #cleanGrants(manifest: PluginManifest, given: Partial<PluginGrants>): PluginGrants {
    const want = manifest.permissions;
    const folders: Record<string, string> = {};
    for (const f of want.folders) {
      const path = given.folders?.[f.id];
      if (typeof path !== 'string' || path === '') continue;
      const abs = resolve(path);
      if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
      folders[f.id] = abs;
    }
    return {
      network: (given.network ?? []).filter((d) => want.network.includes(d)),
      folders,
      memory: want.memory && given.memory === true,
      notifications: want.notifications && given.notifications === true,
      model: want.model && given.model === true,
      cli: (given.cli ?? []).filter((id) => want.cli.some((c) => c.id === id)),
    };
  }

  async #check(action: PolicyAction, confirmed: boolean) {
    try {
      return await this.#o.policy.check({ actor: this.#o.identity.current(), action, confirmed });
    } catch (err) {
      return { decision: 'deny' as const, reason: `Lỗi khi kiểm chính sách: ${String(err)}` };
    }
  }

  // ------------------------------------------------------------ Bật / tắt / gỡ / quyền

  async setEnabled(id: string, enabled: boolean): Promise<PluginInfo> {
    const entry = this.#need(id);
    if (enabled) {
      const verdict = await this.#check(
        {
          kind: 'plugin.manage',
          op: 'enable',
          pluginId: id,
          version: entry.manifest.version,
          signature:
            entry.record.signature === 'trusted'
              ? 'trusted'
              : entry.record.signature === 'untrusted'
                ? 'untrusted'
                : 'unsigned',
          developerMode: this.#state.settings.developerMode,
          permissions: [],
        },
        true,
      );
      if (verdict.decision !== 'allow') {
        this.#audit({
          op: 'denied',
          pluginId: id,
          decision: verdict.decision,
          detail: 'reason' in verdict ? verdict.reason : '',
        });
        throw new Error(
          `Chính sách không cho bật plugin: ${'reason' in verdict ? verdict.reason : ''}`,
        );
      }
    }
    entry.record.enabled = enabled;
    this.#saveState();
    this.#audit({
      op: enabled ? 'enable' : 'disable',
      pluginId: id,
      version: entry.manifest.version,
      decision: 'allow',
    });
    if (enabled) await this.#start(entry);
    else await this.#stop(entry);
    this.#changed();
    return this.#info(entry);
  }

  /** Gỡ hẳn. `deleteData`: xoá cả dữ liệu riêng của plugin (mặc định có). Mục nhớ của nó trong NSA Mem được giữ. */
  async uninstall(id: string, options: { deleteData?: boolean } = {}): Promise<void> {
    const entry = this.#need(id);
    await this.#stop(entry);
    this.#entries.delete(id);
    delete this.#state.plugins[id];
    this.#saveState();
    for (const s of entry.manifest.secrets) this.#o.secrets?.delete(secretName(id, s.id));
    rmSync(this.#installDir(id), { recursive: true, force: true });
    if (options.deleteData !== false) rmSync(this.#dataDir(id), { recursive: true, force: true });
    this.#audit({
      op: 'uninstall',
      pluginId: id,
      version: entry.manifest.version,
      decision: 'allow',
    });
    this.#changed();
  }

  /** Cấp / thu hồi quyền. Quyền của tiến trình cố định lúc khởi động nên plugin được khởi động lại. */
  async updateGrants(id: string, grants: Partial<PluginGrants>): Promise<PluginInfo> {
    const entry = this.#need(id);
    entry.record.grants = this.#cleanGrants(entry.manifest, grants);
    this.#saveState();
    this.#audit({
      op: 'grant',
      pluginId: id,
      decision: 'allow',
      detail:
        describePermissions(entry.manifest, entry.record.grants).join('; ') ||
        'đã thu hồi hết quyền',
    });
    await this.#ensureMemoryBranch(entry);
    if (entry.record.enabled) {
      await this.#stop(entry);
      await this.#start(entry);
    }
    this.#changed();
    return this.#info(entry);
  }

  #need(id: string): Entry {
    const entry = this.#entries.get(id);
    if (!entry) throw new Error(`Chưa cài plugin "${id}".`);
    return entry;
  }

  // ------------------------------------------------------------ Tiến trình

  #spec(entry: Entry) {
    const { manifest, record } = entry;
    const folders = Object.entries(record.grants.folders).map(([fid, path]) => ({
      path,
      write: manifest.permissions.folders.find((f) => f.id === fid)?.access === 'readwrite',
    }));
    return {
      pluginId: entry.id,
      version: manifest.version,
      entry: join(this.#installDir(entry.id), manifest.main ?? ''),
      installDir: this.#installDir(entry.id),
      dataDir: this.#dataDir(entry.id),
      runnerPath: this.#runnerPath,
      folders,
      grants: {
        folders: record.grants.folders,
        memory: record.grants.memory,
        model: record.grants.model === true,
        cli: record.grants.cli ?? [],
      },
      execPath: this.#o.runtime?.execPath ?? process.execPath,
      electron: this.#o.runtime?.electron ?? false,
      maxMemoryMb: this.#o.maxMemoryMb ?? 256,
      startTimeoutMs: this.#o.startTimeoutMs ?? 15_000,
    };
  }

  async #start(entry: Entry): Promise<void> {
    if (this.#closed || entry.process || entry.status === 'starting') return;
    const generation = ++entry.generation;
    if (!entry.manifest.main) {
      // Plugin chỉ có màn hình tĩnh — không có tiến trình.
      entry.status = 'running';
      this.#changed();
      return;
    }
    entry.status = 'starting';
    delete entry.statusMessage;
    this.#changed();
    const proc = new PluginProcess(this.#spec(entry), {
      request: (method, params) => this.#serve(entry, method, params),
      log: (level, message) => {
        if (level === 'error' || level === 'warn') console.error(`[plugin ${entry.id}] ${message}`);
      },
      emit: (event, data) => this.#o.onUiEvent?.(entry.id, event, data),
      exited: (reason) => this.#onExited(entry, proc, generation, reason),
    });
    entry.process = proc;
    try {
      const ready = await proc.start();
      if (generation !== entry.generation) return; // đã bị tắt trong lúc khởi động
      const missing = entry.manifest.tools
        .filter((t) => !ready.tools.includes(t.name))
        .map((t) => t.name);
      if (missing.length > 0) {
        throw new Error(`Manifest khai báo tool mà plugin không cài đặt: ${missing.join(', ')}.`);
      }
      entry.ready = ready;
      entry.status = 'running';
      this.#scheduleJobs(entry, generation);
    } catch (err) {
      if (generation !== entry.generation) return;
      await proc.stop().catch(() => undefined);
      entry.process = null;
      entry.status = 'failed';
      entry.statusMessage = err instanceof Error ? err.message : String(err);
      this.#audit({
        op: 'crash',
        pluginId: entry.id,
        decision: 'allow',
        detail: `không khởi động được: ${entry.statusMessage.split('\n')[0] ?? ''}`,
      });
    }
    this.#changed();
  }

  async #stop(entry: Entry): Promise<void> {
    entry.generation++;
    for (const t of entry.timers) clearInterval(t);
    entry.timers = [];
    const proc = entry.process;
    entry.process = null;
    entry.ready = null;
    entry.status = 'stopped';
    delete entry.statusMessage;
    if (proc) await proc.stop();
  }

  /** Tiến trình tự thoát / sập: ghi nhật ký, khởi động lại có giãn cách; sập liên tục thì dừng hẳn. */
  #onExited(entry: Entry, proc: PluginProcess, generation: number, reason: string): void {
    if (this.#closed || entry.process !== proc || generation !== entry.generation) return;
    entry.process = null;
    entry.ready = null;
    for (const t of entry.timers) clearInterval(t);
    entry.timers = [];
    const now = Date.now();
    entry.restarts = entry.restarts.filter((t) => now - t < 60_000);
    entry.restarts.push(now);
    this.#audit({
      op: 'crash',
      pluginId: entry.id,
      decision: 'allow',
      detail: reason.split('\n')[0] ?? reason,
    });
    if (entry.restarts.length > 3 || !entry.record.enabled) {
      entry.status = 'failed';
      entry.statusMessage = `Plugin sập liên tục nên NSA đã dừng nó. ${reason}`;
      this.#changed();
      return;
    }
    entry.status = 'crashed';
    entry.statusMessage = reason;
    this.#changed();
    const delay = 500 * 2 ** (entry.restarts.length - 1);
    const timer = setTimeout(() => {
      if (!this.#closed && entry.record.enabled && entry.generation === generation) {
        entry.status = 'stopped';
        void this.#start(entry);
      }
    }, delay);
    timer.unref();
  }

  /** Plugin treo (vòng lặp vô hạn…) thì không trả lời ping → giết, vòng đời xử lý như sập. */
  #checkAlive(): void {
    for (const entry of this.#entries.values()) {
      const proc = entry.process;
      if (!proc || entry.status !== 'running') continue;
      void proc.ping(10_000).catch(() => proc.kill());
    }
  }

  // ------------------------------------------------------------ Việc nền

  #scheduleJobs(entry: Entry, generation: number): void {
    for (const job of entry.manifest.jobs) {
      if (!entry.ready?.jobs.includes(job.id)) continue;
      const run = (): void => {
        if (generation === entry.generation)
          void this.#runJob(entry.id, job.id, false).catch(() => undefined);
      };
      if (job.runOnStart) setTimeout(run, 50).unref();
      if (job.everySeconds) {
        const timer = setInterval(run, job.everySeconds * 1000);
        timer.unref();
        entry.timers.push(timer);
      }
    }
  }

  /**
   * Chạy một việc nền ngay (nút "Chạy thử", test). Nếu việc đó đang chạy (ví dụ lượt tự chạy khi
   * vừa bật plugin) thì CHỜ nó xong rồi chạy lượt của mình — trước đây trả về ngay như đã chạy,
   * nên người gọi tưởng dữ liệu mới đã được xử lý (test chập chờn ~10%). Lượt theo lịch thì vẫn bỏ
   * qua khi lượt trước chưa xong.
   */
  runJob(id: string, jobId: string): Promise<void> {
    return this.#runJob(id, jobId, true);
  }

  async #runJob(id: string, jobId: string, waitIfRunning: boolean): Promise<void> {
    const entry = this.#need(id);
    const job = entry.manifest.jobs.find((j) => j.id === jobId);
    if (!job) throw new Error(`Plugin không có việc nền "${jobId}".`);
    const proc = entry.process;
    if (!proc || entry.status !== 'running') throw new Error('Plugin đang không chạy.');
    const state = entry.jobs.get(jobId) ?? { running: false };
    entry.jobs.set(jobId, state);
    while (state.running) {
      if (!waitIfRunning) return;
      await state.done?.catch(() => undefined);
    }
    state.running = true;
    let finish: () => void = () => undefined;
    state.done = new Promise<void>((r) => (finish = r));
    try {
      await proc.call('job', { name: jobId }, this.#o.jobTimeoutMs ?? 5 * 60_000);
      delete state.lastError;
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
      this.#audit({
        op: 'job',
        pluginId: id,
        decision: 'allow',
        detail: `việc "${jobId}" lỗi: ${state.lastError}`,
      });
    } finally {
      state.running = false;
      state.lastRun = this.#now().toISOString();
      finish();
      this.#changed();
    }
  }

  // ------------------------------------------------------------ Tool cho cổng MCP

  /**
   * Tool của mọi plugin đang bật — cổng MCP hỏi lại mỗi lần agent liệt kê tool. Plugin vừa sập /
   * bị ngắt vì treo và đang chờ khởi động lại VẪN được liệt kê: lời gọi sẽ chờ nó chạy lại
   * (`#whenRunning`) thay vì báo "không có tool" (lỗi chập chờn trên CI). Chỉ plugin đã bị dừng hẳn
   * (`failed`) mới biến mất.
   */
  tools(): GatewayTool[] {
    const tools: GatewayTool[] = [];
    for (const entry of this.#entries.values()) {
      if (!entry.record.enabled || entry.status === 'failed') continue;
      for (const tool of entry.manifest.tools) {
        tools.push({
          name: gatewayToolName(entry.id, tool.name),
          description: `[${entry.manifest.name}] ${tool.description}`,
          inputSchema: tool.inputSchema,
          readOnly: tool.readOnly,
          sensitive: tool.sensitive,
          source: 'plugin',
          pluginId: entry.id,
          call: (args, context) => this.#callTool(entry, tool.name, args, context),
        });
      }
    }
    return tools;
  }

  async #callTool(
    entry: Entry,
    tool: string,
    args: Record<string, unknown>,
    context: { agentId: string; conversationId?: string },
  ): Promise<string> {
    const proc = await this.#whenRunning(entry);
    // Tool nhạy cảm tới được đây nghĩa là cổng MCP đã hỏi người dùng rồi — ghi lại để `gate` khỏi hỏi lần hai.
    const sensitive = entry.manifest.tools.find((t) => t.name === tool)?.sensitive === true;
    if (sensitive) entry.sensitiveInFlight.set(tool, (entry.sensitiveInFlight.get(tool) ?? 0) + 1);
    try {
      const value = await proc.call(
        'tool',
        {
          name: tool,
          args,
          caller: {
            agentId: context.agentId,
            ...(context.conversationId ? { conversationId: context.conversationId } : {}),
          },
        },
        this.#o.toolTimeoutMs ?? 30_000,
      );
      return typeof value === 'string' ? value : JSON.stringify(value);
    } finally {
      if (sensitive)
        entry.sensitiveInFlight.set(tool, (entry.sensitiveInFlight.get(tool) ?? 1) - 1);
    }
  }

  /** Plugin vừa sập / đang khởi động lại thì chờ một lúc (tối đa 6 giây) thay vì báo lỗi ngay. */
  async #whenRunning(entry: Entry): Promise<PluginProcess> {
    const end = Date.now() + 6000;
    for (;;) {
      if (!entry.record.enabled) break;
      if (entry.process?.alive && entry.status === 'running') return entry.process;
      if (entry.status === 'failed' || entry.status === 'stopped' || Date.now() > end) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const firstLine = (entry.statusMessage ?? '').split(/\r?\n/)[0] ?? '';
    const why = firstLine ? `: ${firstLine}` : '.';
    throw new Error(`Plugin "${entry.id}" đang không chạy${why}`);
  }

  /** Màn hình của plugin gọi hàm trong plugin. */
  async callUi(id: string, method: string, params: unknown): Promise<unknown> {
    const entry = this.#need(id);
    const proc = entry.process;
    if (!entry.record.enabled || !proc || entry.status !== 'running') {
      throw new Error('Plugin đang không chạy.');
    }
    if (!entry.ready?.ui.includes(method))
      throw new Error(`Plugin không có hàm màn hình "${method}".`);
    return proc.call('ui', { name: method, params }, this.#o.toolTimeoutMs ?? 30_000);
  }

  /** File tĩnh của màn hình plugin (HTML, JS, ảnh) — dùng cho giao thức `nsa-plugin://`. */
  assetPath(id: string, relative: string): string | null {
    const entry = this.#entries.get(id);
    if (!entry || !entry.record.enabled) return null;
    const root = resolve(this.#installDir(id));
    const target = resolve(root, relative.replace(/^\/+/, ''));
    if (!target.startsWith(root + sep) || !existsSync(target) || !statSync(target).isFile())
      return null;
    return target;
  }

  // ------------------------------------------------------------ Phục vụ yêu cầu của plugin

  async #serve(entry: Entry, method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    const grants = entry.record.grants;
    const deny = (what: string): never => {
      const message = `NSA: plugin "${entry.id}" chưa được cấp quyền ${what}.`;
      this.#audit({ op: 'denied', pluginId: entry.id, decision: 'deny', detail: message });
      throw new Error(message);
    };
    switch (method) {
      case 'fetch':
        return this.#brokerFetch(entry, p as unknown as FetchParams);
      case 'config.get':
        return (await this.#config(entry))[String(p['key'])] ?? null;
      case 'config.all':
        return this.#config(entry);
      case 'config.set':
        return this.#setConfig(entry, String(p['key']), p['value']);
      case 'notify': {
        if (!grants.notifications) return deny('thông báo');
        const title = String(p['title'] ?? '').slice(0, 120);
        if (!title) throw new Error('Thông báo cần có tiêu đề.');
        this.#o.notify?.(entry.id, { title, body: String(p['body'] ?? '').slice(0, 400) });
        return null;
      }
      case 'secret.has': {
        const slot = entry.manifest.secrets.find((s) => s.id === String(p['id']));
        return slot ? (this.#o.secrets?.has(secretName(entry.id, slot.id)) ?? false) : false;
      }
      case 'gate':
        return this.#gate(entry, p as unknown as GateParams);
      case 'cli.run':
        return this.#cliRun(entry, p);
      case 'model.complete':
        return this.#complete(entry, p);
      case 'memory.search':
      case 'memory.list':
      case 'memory.read':
      case 'memory.propose': {
        const root = this.#memoryBranch(entry);
        if (!grants.memory || !root || !this.#o.memory) return deny('nhớ (NSA Mem)');
        const sub = subBranchOf(p['subBranch']);
        const branch = sub ? `${root}/${sub}` : root;
        if (method === 'memory.search') {
          return this.#o.memory.search(
            branch,
            String(p['query'] ?? ''),
            Math.min(20, Number(p['limit']) || 8),
          );
        }
        if (method === 'memory.list') {
          return this.#o.memory.list(branch, Math.min(50, Number(p['limit']) || 20));
        }
        if (method === 'memory.read') {
          const note = await this.#o.memory.read(branch, String(p['id'] ?? ''));
          if (!note) throw new Error('Không có mục nhớ này trong nhánh của plugin.');
          return note;
        }
        if (sub) {
          await this.#o.memory.ensureBranch(branch, sub.split('/').at(-1) ?? sub);
        }
        const kind = p['kind'];
        return this.#o.memory.propose(branch, entry.id, {
          title: String(p['title'] ?? ''),
          body: String(p['body'] ?? ''),
          ...(kind === 'fact' || kind === 'preference' || kind === 'rule' ? { kind } : {}),
          ...(typeof p['subject'] === 'string' ? { subject: p['subject'] } : {}),
          ...(typeof p['confidence'] === 'number' ? { confidence: p['confidence'] } : {}),
        });
      }
      default:
        throw new Error(`Yêu cầu không hiểu: ${method}`);
    }
  }

  async #brokerFetch(entry: Entry, p: FetchParams): Promise<unknown> {
    const deniedBy = (message: string): never => {
      this.#audit({ op: 'denied', pluginId: entry.id, decision: 'deny', detail: message });
      throw new Error(message);
    };
    let method = (p.method || 'GET').toUpperCase();
    let body: Buffer | undefined = p.body ? Buffer.from(p.body, 'base64') : undefined;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(p.headers ?? {})) {
      if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = String(v);
    }
    // Lệnh "lưu giá trị từ phản hồi vào khe bí mật" (xoay vòng token): `x-nsa-capture: khe=truong,khe2=a.b`.
    const captureHeader = Object.keys(headers).find((k) => k.toLowerCase() === 'x-nsa-capture');
    const capture = captureHeader ? parseCapture(headers[captureHeader] ?? '') : [];
    if (captureHeader) delete headers[captureHeader];

    // ---- Bí mật: plugin chỉ viết {{secret:khe}}; lõi thay giá trị thật, chỉ tới tên miền được gắn với khe.
    const used = new Map<string, ManifestSecretRef>();
    const secretValues = new Map<string, string>();
    const bodyText = body && body.includes('{{secret:') ? body.toString('utf8') : undefined;
    const wherever = (text: string, where: 'url' | 'header' | 'body'): void => {
      for (const m of text.matchAll(new RegExp(SECRET_PLACEHOLDER_SOURCE, 'g'))) {
        const id = m[1] as string;
        const slot = entry.manifest.secrets.find((s) => s.id === id);
        if (!slot)
          deniedBy(`NSA: plugin "${entry.id}" dùng bí mật "${id}" mà manifest không khai báo.`);
        if (!slot?.where.includes(where)) {
          deniedBy(
            `NSA: bí mật "${id}" của plugin "${entry.id}" không được đặt trong ${where === 'url' ? 'URL' : where === 'header' ? 'header' : 'nội dung gửi'}.`,
          );
        }
        const value = this.#o.secrets?.get(secretName(entry.id, id));
        if (!value) {
          throw new Error(
            `Chưa nhập "${slot?.label ?? id}" cho plugin "${entry.id}". Mở App Store → Quản lý → ${entry.manifest.name} để nhập.`,
          );
        }
        used.set(id, slot as ManifestSecretRef);
        secretValues.set(id, value);
      }
    };
    const urlHead = p.url.split(/[?#]/)[0] ?? '';
    const urlTail = p.url.slice(urlHead.length);
    if (urlTail.includes('{{secret:')) {
      deniedBy(`NSA: bí mật chỉ được đặt trong phần đường dẫn của URL, không đặt trong query.`);
    }
    wherever(urlHead, 'url');
    for (const v of Object.values(headers)) wherever(v, 'header');
    if (bodyText) wherever(bodyText, 'body');
    const fill = (text: string, encode: boolean): string =>
      text.replace(new RegExp(SECRET_PLACEHOLDER_SOURCE, 'g'), (_m, id: string) => {
        const value = secretValues.get(id) ?? '';
        return encode && !/^[A-Za-z0-9._~:-]+$/.test(value) ? encodeURIComponent(value) : value;
      });

    let preUrl: URL;
    try {
      preUrl = new URL(p.url);
    } catch {
      throw new Error(
        `Địa chỉ không hợp lệ: ${p.url.replace(new RegExp(SECRET_PLACEHOLDER_SOURCE, 'g'), '…')}`,
      );
    }
    let url: URL;
    try {
      url = new URL(fill(p.url, true));
    } catch {
      throw new Error('Địa chỉ không hợp lệ sau khi điền bí mật.');
    }
    if (used.size > 0 && url.hostname !== preUrl.hostname) {
      deniedBy(`NSA: bí mật không được nằm trong phần tên miền của URL.`);
    }
    for (const k of Object.keys(headers)) headers[k] = fill(headers[k] ?? '', false);
    if (bodyText && body) body = Buffer.from(fill(bodyText, false), 'utf8');

    // Việc ghi dữ liệu bằng bí mật của plugin (gửi tin…) là hành động ra ngoài: đi qua Policy + AuditLog
    // dù plugin có tự gọi `gate` hay không.
    if (used.size > 0 && method !== 'GET' && method !== 'HEAD') {
      await this.#authorize(entry, {
        action: `http.${method.toLowerCase()}`,
        sensitive: false,
        target: preUrl.hostname,
        summary: `${method} ${preUrl.hostname}${safeDecode(preUrl.pathname).replace(new RegExp(SECRET_PLACEHOLDER_SOURCE, 'g'), '«khoá»')}`,
      });
    }

    for (let hop = 0; hop <= 5; hop++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`Chỉ gọi được http / https (nhận được ${url.protocol}).`);
      }
      if (!domainAllowed(url.hostname, entry.record.grants.network)) {
        deniedBy(`NSA: plugin "${entry.id}" chưa được cấp quyền mạng tới "${url.hostname}".`);
      }
      for (const slot of used.values()) {
        if (!slot.hosts.includes(url.hostname.toLowerCase())) {
          deniedBy(
            `NSA: bí mật "${slot.id}" không được gửi tới "${url.hostname}" (chỉ ${slot.hosts.join(', ')}).`,
          );
        }
      }
      const response = await fetch(url, {
        method,
        headers,
        ...(body && method !== 'GET' && method !== 'HEAD' ? { body: new Uint8Array(body) } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        url = new URL(location, url); // vòng sau kiểm lại tên miền đích
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === 'POST')
        ) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }
      let bytes = await readLimited(response);
      const captured: string[] = [];
      if (capture.length > 0 && response.ok) {
        try {
          const json = JSON.parse(bytes.toString('utf8')) as unknown;
          for (const { slot, path } of capture) {
            const def = entry.manifest.secrets.find((s) => s.id === slot);
            if (!def || !def.hosts.includes(url.hostname.toLowerCase())) continue;
            const value = takePath(json, path);
            if (typeof value === 'string' && value.trim() && !/\s/.test(value)) {
              this.#o.secrets?.set(secretName(entry.id, slot), value);
              secretValues.set(slot, value);
              captured.push(slot);
            }
          }
          bytes = Buffer.from(JSON.stringify(json), 'utf8');
        } catch {
          /* phản hồi không phải JSON: không lưu gì */
        }
      }
      if (captured.length > 0) {
        this.#audit({
          op: 'secret',
          pluginId: entry.id,
          decision: 'allow',
          detail: `cập nhật từ phản hồi của ${url.hostname}: ${captured.join(', ')}`,
        });
      }
      // Che mọi giá trị bí mật còn sót trong phản hồi (máy chủ đôi khi in lại token / header).
      const clean = (text: string): string => scrubSecrets(text, [...secretValues.values()]);
      const text = bytes.toString('utf8');
      const scrubbed = clean(text);
      if (scrubbed !== text) bytes = Buffer.from(scrubbed, 'utf8');
      return {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()].map(([k, v]) => [k, clean(v)]),
        body: bytes.toString('base64'),
      };
    }
    throw new Error('Chuyển hướng quá nhiều lần.');
  }

  // ------------------------------------------------------------ Bí mật, hành động, model

  /** Tất cả giá trị bí mật của plugin này + bí mật khác của app — để che khỏi nhật ký / nội dung gửi model. */
  #redact(entry: Entry, text: string): string {
    const own = entry.manifest.secrets
      .map((s) => this.#o.secrets?.get(secretName(entry.id, s.id)))
      .filter((v): v is string => !!v);
    const cleaned = scrubSecrets(text, own);
    return this.#o.redact ? this.#o.redact(cleaned) : cleaned;
  }

  /** Người dùng nhập / xoá giá trị một khe bí mật (từ màn hình Quản lý do NSA vẽ). */
  setSecret(id: string, secretId: string, value: string): PluginInfo {
    const entry = this.#need(id);
    const slot = entry.manifest.secrets.find((s) => s.id === secretId);
    if (!slot) throw new Error(`Plugin không có khe bí mật "${secretId}".`);
    if (!this.#o.secrets) throw new Error('Kho khoá của hệ điều hành không dùng được.');
    this.#o.secrets.set(secretName(id, secretId), value);
    this.#audit({
      op: 'secret',
      pluginId: id,
      decision: 'allow',
      detail: `đặt "${secretId}" (${this.#o.secrets.hint(secretName(id, secretId)) ?? '••••'})`,
    });
    this.#changed();
    return this.#info(entry);
  }

  deleteSecret(id: string, secretId: string): PluginInfo {
    const entry = this.#need(id);
    if (!entry.manifest.secrets.some((s) => s.id === secretId)) {
      throw new Error(`Plugin không có khe bí mật "${secretId}".`);
    }
    this.#o.secrets?.delete(secretName(id, secretId));
    this.#audit({ op: 'secret', pluginId: id, decision: 'allow', detail: `xoá "${secretId}"` });
    this.#changed();
    return this.#info(entry);
  }

  /**
   * Hành động ra ngoài của plugin: Policy → (hỏi người dùng nếu cần) → AuditLog. Ném lỗi nếu bị
   * chặn / bị từ chối. Mã plugin không được làm hành động đó khi lỗi này được ném.
   */
  async #authorize(entry: Entry, req: GateParams): Promise<void> {
    const sensitive = req.sensitive === true;
    const action = String(req.action ?? '').slice(0, 60) || 'action';
    const target = req.target === undefined ? undefined : String(req.target).slice(0, 120);
    const summary = this.#redact(entry, String(req.summary ?? '')).slice(0, 300);
    // Tool nhạy cảm đã được cổng MCP hỏi người dùng rồi → không hỏi lần hai.
    const viaGateway =
      sensitive && typeof req.tool === 'string' && (entry.sensitiveInFlight.get(req.tool) ?? 0) > 0;
    const act: PolicyAction = {
      kind: 'plugin.action',
      pluginId: entry.id,
      action,
      sensitive,
      ...(target ? { target } : {}),
      summary,
    };
    let verdict = await this.#check(act, viaGateway);
    let asked = viaGateway;
    if (verdict.decision === 'ask') {
      const answer = await this.#askUser(entry, verdict.reason);
      asked = true;
      verdict = answer
        ? await this.#check(act, true)
        : { decision: 'deny', reason: 'Người dùng không đồng ý (hoặc không trả lời kịp).' };
    }
    const detail = `${action}${target ? ` → ${target}` : ''}: ${summary}${asked ? ' [đã xác nhận]' : ''}`;
    if (verdict.decision !== 'allow') {
      const reason = 'reason' in verdict ? verdict.reason : '';
      this.#audit({
        op: 'action',
        pluginId: entry.id,
        decision: verdict.decision,
        detail: `${detail} — bị chặn: ${reason}`,
      });
      throw new Error(`Chính sách không cho phép: ${reason}`);
    }
    this.#audit({ op: 'action', pluginId: entry.id, decision: 'allow', detail });
  }

  /**
   * Chạy chương trình dòng lệnh hộ plugin: quyền `cli` đã cấp → lệnh con nằm trong `allow` → tham số
   * hợp lệ → Policy (+ hỏi nếu nhạy cảm) → chạy không qua shell. Mọi lần chạy vào nhật ký.
   */
  async #cliRun(entry: Entry, p: Record<string, unknown>): Promise<unknown> {
    const def = entry.manifest.permissions.cli.find((c) => c.id === String(p['id']));
    const refuse = (why: string): never => {
      const message = `NSA: plugin "${entry.id}" ${why}`;
      this.#audit({ op: 'denied', pluginId: entry.id, decision: 'deny', detail: message });
      throw new Error(message);
    };
    if (!def || !(entry.record.grants.cli ?? []).includes(def.id)) {
      return refuse('chưa được cấp quyền chạy chương trình này.');
    }
    const bad = validateArgs(p['args'], def.denyFlags);
    if (bad) return refuse(`gọi ${def.command} sai: ${bad}`);
    const args = p['args'] as string[];
    const rule = matchAllow(def.allow, args);
    if (!rule) {
      return refuse(
        `không được chạy "${def.command} ${args.slice(0, 3).join(' ')}" (ngoài danh sách lệnh đã khai).`,
      );
    }
    const prefix = args.slice(0, rule.args.length).join(' ');
    await this.#authorize(entry, {
      action: `cli.${def.id}`,
      sensitive: rule.sensitive,
      target: def.command,
      summary: `${def.command} ${prefix}`,
      ...(typeof p['tool'] === 'string' ? { tool: p['tool'] } : {}),
    });
    const resolved = (this.#o.cliResolver ?? defaultResolver)(def.command);
    if ('error' in resolved) {
      return {
        code: null,
        stdout: '',
        stderr: '',
        error: `${resolved.error} ${def.install}`.trim(),
      };
    }
    const options = (p['options'] ?? {}) as { timeoutMs?: number };
    const timeoutMs = Math.min(120_000, Math.max(1_000, Number(options.timeoutMs) || 60_000));
    return runCli(resolved, args, { timeoutMs, env: minimalEnv() });
  }

  async #askUser(entry: Entry, text: string): Promise<boolean> {
    const confirm = this.#o.confirm;
    if (!confirm) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    try {
      return await confirm(entry.id, this.#redact(entry, text), controller.signal);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async #gate(entry: Entry, req: GateParams): Promise<null> {
    await this.#authorize(entry, req);
    return null;
  }

  async #complete(entry: Entry, p: Record<string, unknown>): Promise<string> {
    if (!entry.record.grants.model || !this.#o.model) {
      this.#audit({
        op: 'denied',
        pluginId: entry.id,
        decision: 'deny',
        detail: `NSA: plugin "${entry.id}" chưa được cấp quyền dùng model.`,
      });
      throw new Error(`NSA: plugin "${entry.id}" chưa được cấp quyền dùng model.`);
    }
    const options = (p['options'] ?? {}) as { system?: string; maxChars?: number };
    const prompt = this.#redact(entry, String(p['prompt'] ?? '')).slice(0, 24_000);
    const system = options.system
      ? this.#redact(entry, String(options.system)).slice(0, 8_000)
      : '';
    if (!prompt.trim()) throw new Error('Nội dung gửi model trống.');
    this.#audit({
      op: 'model',
      pluginId: entry.id,
      decision: 'allow',
      detail: `việc "kênh chat": ${prompt.length + system.length} ký tự`,
    });
    const text = await withTimeout(
      this.#o.model(entry.id, prompt, system ? { system } : {}),
      90_000,
      'Model không trả lời trong 90 giây.',
    );
    return this.#redact(entry, text).slice(0, Math.min(8_000, Number(options.maxChars) || 8_000));
  }

  // ------------------------------------------------------------ Cấu hình riêng của plugin

  async #config(entry: Entry): Promise<Record<string, unknown>> {
    try {
      const data = JSON.parse(
        readFileSync(join(this.#dataDir(entry.id), 'config.json'), 'utf8'),
      ) as unknown;
      return typeof data === 'object' && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  #setConfig(entry: Entry, key: string, value: unknown): Promise<null> {
    const run = async (): Promise<null> => {
      const all = await this.#config(entry);
      if (value === undefined || value === null) delete all[key];
      else all[key] = value;
      const file = join(this.#dataDir(entry.id), 'config.json');
      writeFileSync(`${file}.tmp`, JSON.stringify(all, null, 2), 'utf8');
      renameSync(`${file}.tmp`, file);
      return null;
    };
    const next = entry.configLock.then(run, run);
    entry.configLock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // ------------------------------------------------------------ Nhánh nhớ của plugin

  #memoryBranch(entry: Entry): string | null {
    return entry.manifest.memory ? `plugin/${entry.id}/${entry.manifest.memory.branch}` : null;
  }

  async #ensureMemoryBranch(entry: Entry): Promise<void> {
    const branch = this.#memoryBranch(entry);
    if (!branch || !entry.record.grants.memory || !this.#o.memory) return;
    try {
      await this.#o.memory.ensureBranch(
        branch,
        `${entry.manifest.name}: ${entry.manifest.memory?.title ?? ''}`,
      );
    } catch (err) {
      console.error(`[plugins] không tạo được nhánh nhớ của "${entry.id}":`, err);
    }
  }

  // ------------------------------------------------------------ Kho

  registry(): PluginRegistry | null {
    const location = this.#state.settings.registry;
    return location ? new PluginRegistry(location) : null;
  }

  /** Danh sách trong kho (nếu có) kèm cờ tương thích / có bản mới. */
  async registryEntries(): Promise<RegistryEntry[]> {
    const registry = this.registry();
    if (!registry) return [];
    const entries = await registry.list();
    return entries.map((e) => {
      const installed = this.#entries.get(e.id)?.manifest.version;
      const a = parseVersion(e.version);
      const b = installed ? parseVersion(installed) : null;
      return {
        ...e,
        compatible: this.#compatible(e.nsa),
        ...(installed ? { installed } : {}),
        updateAvailable: !!(a && b && compareVersions(a, b) > 0),
      };
    });
  }

  #compatible(range: string): boolean {
    return isCompatible({ nsa: range }, this.#o.nsaVersion);
  }

  async prepareFromRegistry(id: string): Promise<PreparedInstall> {
    const registry = this.registry();
    if (!registry) throw new Error('Chưa cấu hình nguồn kho plugin.');
    const entry = (await registry.list()).find((e) => e.id === id);
    if (!entry) throw new Error(`Kho không có plugin "${id}".`);
    return this.prepareFromPackage(await registry.fetchPackage(entry));
  }

  // ------------------------------------------------------------ Vòng đời

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    await Promise.all([...this.#entries.values()].map((e) => this.#stop(e).catch(() => undefined)));
  }

  // ------------------------------------------------------------ Tiện ích

  #installDir(id: string): string {
    return join(this.dir, 'installed', id);
  }

  #dataDir(id: string): string {
    return join(this.dir, 'data', id);
  }

  #loadManifest(id: string): PluginManifest {
    const raw = readFileSync(join(this.#installDir(id), MANIFEST_FILE), 'utf8');
    const result = validateManifest(JSON.parse(raw));
    if (!result.ok) throw new Error(formatManifestErrors(result.errors));
    return result.manifest;
  }

  #newEntry(id: string, manifest: PluginManifest, record: PluginRecord): Entry {
    mkdirSync(this.#dataDir(id), { recursive: true });
    let icon: PluginIcon;
    try {
      icon = iconFromDir(manifest, this.#installDir(id));
    } catch {
      icon = { kind: 'emoji', value: '🧩' };
    }
    return {
      id,
      manifest,
      record,
      icon,
      status: 'stopped',
      process: null,
      ready: null,
      restarts: [],
      timers: [],
      jobs: new Map(),
      configLock: Promise.resolve(),
      generation: 0,
      sensitiveInFlight: new Map(),
    };
  }

  #saveState(): void {
    const file = join(this.dir, 'state.json');
    writeFileSync(`${file}.tmp`, JSON.stringify(this.#state, null, 2), 'utf8');
    renameSync(`${file}.tmp`, file);
  }

  #changed(): void {
    try {
      this.#o.onChange?.();
    } catch (err) {
      console.error('[plugins] onChange lỗi:', err);
    }
  }

  #now(): Date {
    return (this.#o.now ?? (() => new Date()))();
  }

  #audit(
    body: Omit<Extract<AuditEntry, { type: 'plugin' }>, 'type' | 'at' | 'actor' | 'agentId'>,
  ): void {
    if (!this.#o.audit) return;
    const actor = this.#o.identity.current();
    try {
      this.#o.audit.record({
        type: 'plugin',
        at: this.#now().toISOString(),
        actor: { id: actor.id, displayName: actor.displayName },
        agentId: 'plugin-host',
        ...body,
      });
    } catch (err) {
      console.error('[plugins] không ghi được nhật ký:', err);
    }
  }
}

interface FetchParams {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface GateParams {
  action: string;
  sensitive?: boolean;
  target?: string;
  summary: string;
  tool?: string;
}

type ManifestSecretRef = PluginManifest['secrets'][number];

/** Tên khoá trong kho khoá của hệ điều hành cho một khe bí mật. */
export function secretName(pluginId: string, slot: string): string {
  return `plugin:${pluginId}:${slot}`;
}

const SUB_BRANCH = /^[a-z0-9][a-z0-9_-]{0,47}(\/[a-z0-9][a-z0-9_-]{0,47}){0,2}$/;

/** Nhánh nhớ con hợp lệ (không `..`, không rỗng, tối đa 3 cấp) hoặc `null`; sai dạng thì ném lỗi. */
function subBranchOf(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !SUB_BRANCH.test(value)) {
    throw new Error(
      'subBranch không hợp lệ: chỉ chữ thường, số, "-", "_", tối đa 3 cấp ngăn bởi "/".',
    );
  }
  return value;
}

function parseCapture(header: string): { slot: string; path: string }[] {
  return header
    .split(',')
    .map((part) => part.trim().split('='))
    .filter((kv): kv is [string, string] => kv.length === 2 && !!kv[0] && !!kv[1])
    .map(([slot, path]) => ({ slot: slot.trim(), path: path.trim() }));
}

/** Lấy giá trị theo đường dẫn `a.b` trong JSON và thay bằng dấu che; trả giá trị cũ. */
function takePath(json: unknown, path: string): unknown {
  const parts = path.split('.');
  let node = json as Record<string, unknown> | undefined;
  for (const part of parts.slice(0, -1)) {
    const next = node?.[part];
    if (typeof next !== 'object' || next === null) return undefined;
    node = next as Record<string, unknown>;
  }
  const last = parts.at(-1) as string;
  const value = node?.[last];
  if (node && typeof value === 'string') node[last] = '[đã lưu vào kho khoá]';
  return value;
}

/** Các dạng một bí mật có thể xuất hiện trong văn bản (thô, URL-encode, base64, JSON). */
export function secretForms(secret: string): string[] {
  return [
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret).toString('base64'),
    JSON.stringify(secret).slice(1, -1),
  ].filter((v, i, a) => a.indexOf(v) === i);
}

/** Che mọi bí mật đã biết trong một chuỗi bằng «•••». */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 6) continue;
    for (const form of secretForms(secret)) {
      if (out.includes(form)) out = out.split(form).join('«bí mật»');
    }
  }
  return out;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

async function readLimited(response: Response): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > FETCH_LIMIT) {
      void reader.cancel();
      throw new Error('Phản hồi lớn hơn 10 MB.');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function loadState(file: string): StateFile {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<StateFile>;
    const plugins = raw.plugins ?? {};
    // Bản ghi cũ (trước giai đoạn 4) chưa có `model`.
    for (const record of Object.values(plugins)) {
      if (record.grants) {
        record.grants.model = record.grants.model === true;
        record.grants.cli = Array.isArray(record.grants.cli) ? record.grants.cli : [];
      }
    }
    return {
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
      plugins,
    };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, plugins: {} };
  }
}

/** Câu đọc được cho từng quyền (hiện trong hộp xin quyền, ghi vào nhật ký và chính sách). */
export function describePermissions(manifest: PluginManifest, grants?: PluginGrants): string[] {
  const want = manifest.permissions;
  const out: string[] = [];
  for (const d of want.network) {
    if (!grants || grants.network.includes(d)) out.push(`Truy cập mạng tới ${d}`);
  }
  for (const f of want.folders) {
    if (!grants || grants.folders[f.id]) {
      out.push(`${f.access === 'readwrite' ? 'Đọc và ghi' : 'Đọc'} thư mục "${f.label}"`);
    }
  }
  if (want.memory && (!grants || grants.memory))
    out.push('Đọc và đề xuất ghi vào nhánh nhớ riêng của plugin');
  if (want.notifications && (!grants || grants.notifications)) out.push('Hiện thông báo');
  for (const c of want.cli) {
    if (!grants || grants.cli.includes(c.id)) {
      const names = c.allow.map((a) => a.args.join(' ') + (a.sensitive ? ' (nhạy cảm)' : ''));
      out.push(
        `Chạy chương trình "${c.label}" (${c.command}) trên máy bạn, chỉ các lệnh: ${names.join('; ')}`,
      );
    }
  }
  if (want.model && (!grants || grants.model)) {
    out.push(
      'Nhờ NSA chạy model "kênh chat" (nội dung tin nhắn được gửi tới nhà cung cấp model bạn chọn)',
    );
  }
  for (const s of manifest.secrets)
    out.push(
      `Dùng bí mật "${s.label}" khi gọi ${s.hosts.join(', ')} (plugin không đọc được giá trị)`,
    );
  return out;
}

/** Quyền mà bản mới xin thêm so với bản đang cài. */
function newPermissions(oldM: PluginManifest, newM: PluginManifest): string[] {
  const out: string[] = [];
  for (const d of newM.permissions.network) {
    if (!oldM.permissions.network.includes(d)) out.push(`Truy cập mạng tới ${d}`);
  }
  for (const f of newM.permissions.folders) {
    const before = oldM.permissions.folders.find((o) => o.id === f.id);
    if (!before || (before.access === 'read' && f.access === 'readwrite')) {
      out.push(`${f.access === 'readwrite' ? 'Đọc và ghi' : 'Đọc'} thư mục "${f.label}"`);
    }
  }
  if (newM.permissions.memory && !oldM.permissions.memory) out.push('Nhánh nhớ riêng');
  if (newM.permissions.notifications && !oldM.permissions.notifications) out.push('Hiện thông báo');
  if (newM.permissions.model && !oldM.permissions.model) out.push('Dùng model "kênh chat"');
  for (const c of newM.permissions.cli) {
    const before = oldM.permissions.cli.find((o) => o.id === c.id);
    if (!before || c.allow.length > before.allow.length) out.push(`Chạy chương trình "${c.label}"`);
  }
  for (const s of newM.secrets) {
    if (!oldM.secrets.some((o) => o.id === s.id)) out.push(`Bí mật "${s.label}"`);
  }
  return out;
}

function mime(path: string): string {
  return /\.png$/i.test(path) ? 'image/png' : 'image/svg+xml';
}

function iconFor(manifest: PluginManifest, files: Record<string, string>): PluginIcon {
  if (manifest.icon.startsWith('emoji:')) return { kind: 'emoji', value: manifest.icon.slice(6) };
  const data = files[manifest.icon];
  if (!data || data.length > 400_000) return { kind: 'emoji', value: '🧩' };
  return { kind: 'image', dataUrl: `data:${mime(manifest.icon)};base64,${data}` };
}

function iconFromDir(manifest: PluginManifest, dir: string): PluginIcon {
  if (manifest.icon.startsWith('emoji:')) return { kind: 'emoji', value: manifest.icon.slice(6) };
  const file = join(dir, manifest.icon);
  const data = readFileSync(file);
  if (data.length > 300_000) return { kind: 'emoji', value: '🧩' };
  return {
    kind: 'image',
    dataUrl: `data:${mime(manifest.icon)};base64,${data.toString('base64')}`,
  };
}
