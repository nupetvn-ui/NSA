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
  validateManifest,
  type InstallResult,
  type MemoryHit,
  type MemoryNote,
  type MemoryProposeResult,
  type PluginGrants,
  type PluginIcon,
  type PluginInfo,
  type PluginManifest,
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
import { PluginProcess, type ReadyInfo } from './process.js';
import { RUNNER_SOURCE } from './runner-source.js';
import { PluginRegistry } from './registry.js';

/** Cầu nối tới NSA Mem — do app cắm vào, host không biết gì về kho nhớ. */
export interface PluginMemoryBridge {
  /** Tạo (ẩn) nhánh của plugin và mọi nhánh cha nếu chưa có. */
  ensureBranch(path: string, title: string): Promise<void>;
  search(branch: string, query: string, limit: number): Promise<MemoryHit[]>;
  read(branch: string, id: string): Promise<MemoryNote | null>;
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

export interface PluginHostOptions {
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
  jobs: Map<string, { lastRun?: string; lastError?: string; running: boolean }>;
  configLock: Promise<void>;
  generation: number;
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
      installedAt: e.record.installedAt,
    };
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

    if (verification.status === 'tampered') {
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
    const prepared: PreparedInstall = {
      prepareId,
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
      grants: { folders: record.grants.folders, memory: record.grants.memory },
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
          void this.runJob(entry.id, job.id).catch(() => undefined);
      };
      if (job.runOnStart) setTimeout(run, 50).unref();
      if (job.everySeconds) {
        const timer = setInterval(run, job.everySeconds * 1000);
        timer.unref();
        entry.timers.push(timer);
      }
    }
  }

  /** Chạy một việc nền ngay (cũng dùng cho nút "Chạy thử"). */
  async runJob(id: string, jobId: string): Promise<void> {
    const entry = this.#need(id);
    const job = entry.manifest.jobs.find((j) => j.id === jobId);
    if (!job) throw new Error(`Plugin không có việc nền "${jobId}".`);
    const proc = entry.process;
    if (!proc || entry.status !== 'running') throw new Error('Plugin đang không chạy.');
    const state = entry.jobs.get(jobId) ?? { running: false };
    entry.jobs.set(jobId, state);
    if (state.running) return;
    state.running = true;
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
      this.#changed();
    }
  }

  // ------------------------------------------------------------ Tool cho cổng MCP

  /** Tool của mọi plugin đang bật và chạy — cổng MCP hỏi lại mỗi lần agent liệt kê tool. */
  tools(): GatewayTool[] {
    const tools: GatewayTool[] = [];
    for (const entry of this.#entries.values()) {
      if (!entry.record.enabled || entry.status !== 'running' || !entry.process) continue;
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
      case 'memory.search':
      case 'memory.read':
      case 'memory.propose': {
        const branch = this.#memoryBranch(entry);
        if (!grants.memory || !branch || !this.#o.memory) return deny('nhớ (NSA Mem)');
        if (method === 'memory.search') {
          return this.#o.memory.search(
            branch,
            String(p['query'] ?? ''),
            Math.min(20, Number(p['limit']) || 8),
          );
        }
        if (method === 'memory.read') {
          const note = await this.#o.memory.read(branch, String(p['id'] ?? ''));
          if (!note) throw new Error('Không có mục nhớ này trong nhánh của plugin.');
          return note;
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
    let url: URL;
    try {
      url = new URL(p.url);
    } catch {
      throw new Error(`Địa chỉ không hợp lệ: ${p.url}`);
    }
    let method = (p.method || 'GET').toUpperCase();
    let body: Buffer | undefined = p.body ? Buffer.from(p.body, 'base64') : undefined;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(p.headers ?? {})) {
      if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase())) headers[k] = String(v);
    }
    for (let hop = 0; hop <= 5; hop++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`Chỉ gọi được http / https (nhận được ${url.protocol}).`);
      }
      if (!domainAllowed(url.hostname, entry.record.grants.network)) {
        const message = `NSA: plugin "${entry.id}" chưa được cấp quyền mạng tới "${url.hostname}".`;
        this.#audit({ op: 'denied', pluginId: entry.id, decision: 'deny', detail: message });
        throw new Error(message);
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
      const bytes = await readLimited(response);
      return {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers.entries()],
        body: bytes.toString('base64'),
      };
    }
    throw new Error('Chuyển hướng quá nhiều lần.');
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
    return {
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
      plugins: raw.plugins ?? {},
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
