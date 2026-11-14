import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { AgentAdapter } from '@nsa/adapter-sdk';
import {
  extractFiles,
  readPackage,
  verifyPackage,
  type PluginPackage,
  type TrustedPublisher,
} from '@nsa/plugin-host';
import { compareVersions, parseVersion, satisfies } from '@nsa/plugin-sdk';
import { checkAdapterShape, probeAdapter } from './contract.js';
import {
  ADAPTER_CONTRACT,
  ADAPTER_MANIFEST_FILE,
  CATALOG_PACKAGE_ID,
  type AdapterAuditEvent,
  type AdapterIndexEntry,
  type AdapterModule,
  type AdapterNotice,
  type AdapterPackageManifest,
  type AdapterSource,
  type AdapterStatus,
  type BundledAdapter,
  type UpdateReport,
} from './types.js';

interface State {
  version: 1;
  adapters: Record<string, { active?: string; failed: string[] }>;
  catalog: { version?: string; failed: string[] };
}

export interface AdapterManagerOptions {
  /** Thư mục dữ liệu của adapter tải về (`<userData>/adapters`). */
  dir: string;
  /** Phiên bản app — để kiểm trường `nsa` của gói. */
  appVersion: string;
  /** Adapter kèm app: bản dự phòng. */
  bundled: BundledAdapter[];
  /** Khoá nhà phát hành được tin (khoá của NSA, đóng cùng app). */
  trusted: TrustedPublisher[];
  /** CHỈ cho chế độ nhà phát triển: nhận cả gói chưa ký / ký bằng khoá lạ. Gói bị sửa thì luôn bị từ chối. */
  allowUnsigned?: boolean;
  source?: AdapterSource;
  /** Nạp module (mặc định `require` CommonJS); test có thể thay. */
  loadModule?: (file: string) => unknown;
  audit?: (event: AdapterAuditEvent) => void;
  notify?: (notice: AdapterNotice) => void;
  /** Có bản mới được kích hoạt — nơi lắp ghép nạp lại danh sách agent. */
  onChanged?: (adapterIds: string[]) => void;
  /** File dữ liệu hãng/model cục bộ + hàm kiểm: trả `{ version }` nếu hợp lệ, hoặc chuỗi lỗi. */
  catalog?: {
    file: string;
    bundledVersion: string;
    validate: (json: unknown) => { version: string } | string;
  };
}

interface Resolved {
  source: 'bundled' | 'downloaded';
  version: string;
  create: (params?: unknown) => AgentAdapter;
}

class Reject extends Error {}

/** Nạp CommonJS, bỏ bản trong bộ nhớ đệm (file có thể vừa được thay trong cùng phiên chạy). */
const defaultLoad = (file: string): unknown => {
  const req = createRequire(file);
  delete req.cache[req.resolve(file)];
  return req(file);
};

function newer(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  return pa !== null && pb !== null && compareVersions(pa, pb) > 0;
}

/**
 * Quản lý adapter: chọn giữa bản kèm app và bản tải về, tải + kiểm gói mới, tự quay về bản kèm app
 * khi bản tải về lỗi (ADR-0016). Bản kèm app luôn là đường lùi cuối cùng và không bao giờ bị xoá.
 */
export class AdapterManager {
  readonly #o: AdapterManagerOptions;
  readonly #bundled = new Map<string, BundledAdapter>();
  readonly #resolved = new Map<string, Resolved>();
  #state: State;

  constructor(options: AdapterManagerOptions) {
    this.#o = options;
    for (const b of options.bundled) this.#bundled.set(b.id, b);
    this.#state = this.#readState();
    for (const b of options.bundled) this.#resolved.set(b.id, this.#select(b));
  }

  // ------------------------------------------------------------ trạng thái

  #statePath(): string {
    return join(this.#o.dir, 'state.json');
  }

  #readState(): State {
    try {
      const raw = JSON.parse(readFileSync(this.#statePath(), 'utf8')) as Partial<State>;
      return {
        version: 1,
        adapters: raw.adapters && typeof raw.adapters === 'object' ? raw.adapters : {},
        catalog: { failed: [], ...(raw.catalog ?? {}) },
      };
    } catch {
      return { version: 1, adapters: {}, catalog: { failed: [] } };
    }
  }

  #saveState(): void {
    try {
      mkdirSync(this.#o.dir, { recursive: true });
      const tmp = `${this.#statePath()}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.#state, null, 2), 'utf8');
      renameSync(tmp, this.#statePath());
    } catch (err) {
      console.error('[adapters] không lưu được trạng thái:', err);
    }
  }

  #entry(id: string): { active?: string; failed: string[] } {
    return (this.#state.adapters[id] ??= { failed: [] });
  }

  // ------------------------------------------------------------ chọn bản chạy

  /** Bản kèm app, hoặc bản tải về nếu mới hơn, tương thích và nạp / qua hợp đồng. */
  #select(bundled: BundledAdapter): Resolved {
    const fallback: Resolved = {
      source: 'bundled',
      version: bundled.version,
      create: (p) => bundled.create(p),
    };
    const active = this.#state.adapters[bundled.id]?.active;
    if (!active) return fallback;
    if (!newer(active, bundled.version)) {
      // App vừa cập nhật và đã kèm bản mới hơn: bản tải về cũ không còn cần.
      delete this.#entry(bundled.id).active;
      this.#saveState();
      return fallback;
    }
    const loaded = this.#tryLoad(bundled.id, active);
    if (typeof loaded === 'string') {
      this.#demote(bundled.id, active, loaded);
      return fallback;
    }
    return {
      source: 'downloaded',
      version: active,
      create: (params) => {
        try {
          return loaded.create(params);
        } catch (err) {
          // Lỗi lúc tạo adapter (không chỉ lúc nạp): quay về bản kèm app ngay trong lần gọi này.
          this.#demote(bundled.id, active, `createAdapter() ném lỗi: ${(err as Error).message}`);
          this.#resolved.set(bundled.id, fallback);
          return bundled.create(params);
        }
      },
    };
  }

  /** Bỏ một bản tải về: ghi nhớ lỗi để không thử lại, báo người dùng, ghi nhật ký. */
  #demote(id: string, version: string, reason: string): void {
    const e = this.#entry(id);
    delete e.active;
    if (!e.failed.includes(version)) e.failed.push(version);
    this.#saveState();
    const bundledVersion = this.#bundled.get(id)?.version ?? '?';
    this.#o.audit?.({ adapterId: id, version, action: 'fallback', reason });
    this.#o.notify?.({
      level: 'warn',
      message: `Bản cập nhật adapter ${id} ${version} bị lỗi (${reason}). NSA đã quay về bản kèm app ${bundledVersion}.`,
    });
  }

  /** Nạp một bản đã giải nén; trả về chuỗi lỗi nếu hỏng, hoặc hàm tạo adapter. */
  #tryLoad(id: string, version: string): string | { create: (p?: unknown) => AgentAdapter } {
    try {
      const dir = join(this.#o.dir, id, version);
      const manifest = JSON.parse(
        readFileSync(join(dir, ADAPTER_MANIFEST_FILE), 'utf8'),
      ) as AdapterPackageManifest;
      this.#checkManifest(manifest, id, 'adapter', version);
      const entry = join(dir, manifest.entry);
      if (!existsSync(entry)) return `thiếu file ${manifest.entry}`;
      const mod = (this.#o.loadModule ?? defaultLoad)(entry) as Partial<AdapterModule> | null;
      if (!mod || mod.contract !== ADAPTER_CONTRACT || typeof mod.createAdapter !== 'function') {
        return `module không theo hợp đồng ${ADAPTER_CONTRACT}`;
      }
      const create = mod.createAdapter.bind(mod);
      const problem = checkAdapterShape(create({}), id);
      if (problem) return `trượt test hợp đồng: ${problem}`;
      return { create };
    } catch (err) {
      return `không nạp được: ${(err as Error).message}`;
    }
  }

  #checkManifest(
    m: AdapterPackageManifest,
    id: string,
    kind: AdapterPackageManifest['kind'],
    version: string,
  ): void {
    const bad = (why: string): never => {
      throw new Reject(why);
    };
    if (!m || typeof m !== 'object' || m.schema !== 1) bad('adapter.json sai định dạng');
    if (m.kind !== kind) bad(`loại gói "${m.kind}", cần "${kind}"`);
    if (m.id !== id) bad(`mã gói "${m.id}" khác "${id}"`);
    if (m.version !== version) bad(`phiên bản trong gói "${m.version}" khác "${version}"`);
    if (typeof m.entry !== 'string' || !m.entry || /^([/\\]|[a-zA-Z]:)|\.\./.test(m.entry))
      bad('entry không hợp lệ');
    if (kind === 'adapter' && m.contract !== ADAPTER_CONTRACT)
      bad(`hợp đồng ${String(m.contract)} chưa được app hỗ trợ`);
    if (typeof m.nsa !== 'string' || !satisfies(this.#o.appVersion, m.nsa))
      bad(`cần NSA ${String(m.nsa)}, app là ${this.#o.appVersion}`);
  }

  // ------------------------------------------------------------ dùng

  /** Tạo adapter `id` từ bản đang được chọn (bản tải về hoặc bản kèm app). */
  create(id: string, params?: unknown): AgentAdapter {
    const r = this.#resolved.get(id);
    if (!r) throw new Error(`Không có adapter "${id}"`);
    return r.create(params);
  }

  status(): AdapterStatus[] {
    return [...this.#bundled.values()].map((b) => {
      const r = this.#resolved.get(b.id);
      return {
        id: b.id,
        source: r?.source ?? 'bundled',
        version: r?.version ?? b.version,
        bundledVersion: b.version,
      };
    });
  }

  // ------------------------------------------------------------ tải và cài

  /** Hỏi nguồn, tải các gói mới hơn, kiểm và kích hoạt. Không bao giờ ném lỗi ra ngoài. */
  async checkForUpdates(): Promise<UpdateReport> {
    const report: UpdateReport = { installed: [], rejected: [] };
    const source = this.#o.source;
    if (!source) return report;
    let entries: AdapterIndexEntry[];
    try {
      entries = await source.list();
    } catch (err) {
      report.error = (err as Error).message;
      return report;
    }
    const changed: string[] = [];
    for (const entry of entries) {
      try {
        if (entry.kind === 'adapter' && this.#bundled.has(entry.id)) {
          if (await this.#installAdapter(source, entry)) {
            report.installed.push({ id: entry.id, version: entry.version });
            changed.push(entry.id);
          }
        } else if (entry.kind === 'catalog' && entry.id === CATALOG_PACKAGE_ID && this.#o.catalog) {
          if (await this.#installCatalog(source, entry))
            report.installed.push({ id: entry.id, version: entry.version });
        }
      } catch (err) {
        const permanent = err instanceof Reject;
        const reason = permanent ? err.message : `lỗi khi tải: ${(err as Error).message}`;
        report.rejected.push({ id: entry.id, version: entry.version, reason });
        this.#reject(entry, reason, permanent);
      }
    }
    if (changed.length > 0) this.#o.onChanged?.(changed);
    return report;
  }

  #reject(entry: AdapterIndexEntry, reason: string, permanent: boolean): void {
    // Gói bị từ chối vì nội dung (chữ ký, tương thích, hợp đồng) thì không thử lại đúng phiên bản đó.
    if (permanent) {
      const failed =
        entry.kind === 'catalog' ? this.#state.catalog.failed : this.#entry(entry.id).failed;
      if (!failed.includes(entry.version)) failed.push(entry.version);
      this.#saveState();
    }
    this.#o.audit?.({ adapterId: entry.id, version: entry.version, action: 'rejected', reason });
    this.#o.notify?.({
      level: 'warn',
      message: `NSA từ chối bản cập nhật ${entry.id} ${entry.version}: ${reason}.`,
    });
  }

  /** Tải, kiểm mã băm, chữ ký và manifest. Trả về gói và manifest đã chấp nhận. */
  async #fetchAndVerify(
    source: AdapterSource,
    entry: AdapterIndexEntry,
  ): Promise<{ pkg: PluginPackage; manifest: AdapterPackageManifest }> {
    const bytes = await source.fetchPackage(entry);
    if (
      entry.sha256 &&
      createHash('sha256').update(bytes).digest('hex') !== entry.sha256.toLowerCase()
    ) {
      throw new Reject('mã băm của file tải về không khớp chỉ mục');
    }
    let pkg: PluginPackage;
    try {
      pkg = readPackage(bytes);
    } catch (err) {
      throw new Reject((err as Error).message);
    }
    const verdict = verifyPackage(pkg, this.#o.trusted);
    if (verdict.status === 'tampered') {
      throw new Reject('chữ ký không khớp nội dung (gói bị sửa sau khi ký)');
    }
    if (verdict.status !== 'trusted' && !this.#o.allowUnsigned) {
      throw new Reject(
        verdict.status === 'unsigned'
          ? 'gói chưa được ký'
          : 'gói ký bằng khoá không nằm trong danh sách tin cậy của NSA',
      );
    }
    const raw = pkg.files[ADAPTER_MANIFEST_FILE];
    if (raw === undefined) throw new Reject(`thiếu ${ADAPTER_MANIFEST_FILE}`);
    let manifest: AdapterPackageManifest;
    try {
      manifest = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as AdapterPackageManifest;
    } catch {
      throw new Reject(`${ADAPTER_MANIFEST_FILE} không phải JSON`);
    }
    this.#checkManifest(manifest, entry.id, entry.kind, entry.version);
    if (pkg.files[manifest.entry] === undefined) throw new Reject(`thiếu file ${manifest.entry}`);
    return { pkg, manifest };
  }

  async #installAdapter(source: AdapterSource, entry: AdapterIndexEntry): Promise<boolean> {
    const bundled = this.#bundled.get(entry.id) as BundledAdapter;
    const current = this.#resolved.get(entry.id)?.version ?? bundled.version;
    if (!newer(entry.version, current)) return false;
    if (!satisfies(this.#o.appVersion, entry.nsa)) return false; // chỉ mục nói chưa hợp app này
    if (this.#entry(entry.id).failed.includes(entry.version)) return false;

    const { pkg } = await this.#fetchAndVerify(source, entry);
    const finalDir = join(this.#o.dir, entry.id, entry.version);
    const staging = join(this.#o.dir, '.staging', `${entry.id}-${entry.version}-${process.pid}`);
    rmSync(staging, { recursive: true, force: true });
    extractFiles(pkg.files, staging);
    rmSync(finalDir, { recursive: true, force: true });
    mkdirSync(dirname(finalDir), { recursive: true });
    renameSync(staging, finalDir);

    // Phải nạp được và qua test hợp đồng (kể cả detect() chạy thật) rồi mới thành bản chạy chính.
    const loaded = this.#tryLoad(entry.id, entry.version);
    let problem = typeof loaded === 'string' ? loaded : null;
    if (typeof loaded !== 'string') {
      const probe = await probeAdapter(loaded.create({}));
      if (probe) problem = `trượt test hợp đồng: ${probe}`;
    }
    if (problem !== null) {
      rmSync(finalDir, { recursive: true, force: true });
      throw new Reject(problem);
    }
    const e = this.#entry(entry.id);
    const previous = e.active;
    e.active = entry.version;
    this.#saveState();
    this.#resolved.set(entry.id, this.#select(bundled));
    if (previous && previous !== entry.version) {
      rmSync(join(this.#o.dir, entry.id, previous), { recursive: true, force: true });
    }
    this.#o.audit?.({
      adapterId: entry.id,
      version: entry.version,
      action: 'installed',
      reason: `thay bản ${current}`,
    });
    this.#o.notify?.({
      level: 'info',
      message: `Đã cập nhật adapter ${entry.id} lên ${entry.version} (không cần cập nhật app).`,
    });
    return true;
  }

  async #installCatalog(source: AdapterSource, entry: AdapterIndexEntry): Promise<boolean> {
    const cat = this.#o.catalog;
    if (!cat) return false;
    const stored = this.#state.catalog.version;
    const current = stored && newer(stored, cat.bundledVersion) ? stored : cat.bundledVersion;
    if (!newer(entry.version, current)) return false;
    if (!satisfies(this.#o.appVersion, entry.nsa)) return false;
    if (this.#state.catalog.failed.includes(entry.version)) return false;
    const { pkg, manifest } = await this.#fetchAndVerify(source, entry);
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(pkg.files[manifest.entry] ?? '', 'base64').toString('utf8'));
    } catch {
      throw new Reject('file dữ liệu không phải JSON');
    }
    const checked = cat.validate(json);
    if (typeof checked === 'string') throw new Reject(`file dữ liệu không hợp lệ: ${checked}`);
    if (checked.version !== entry.version) {
      throw new Reject(
        `phiên bản trong file dữ liệu (${checked.version}) khác gói (${entry.version})`,
      );
    }
    mkdirSync(dirname(cat.file), { recursive: true });
    writeFileSync(`${cat.file}.tmp`, JSON.stringify(json), 'utf8');
    renameSync(`${cat.file}.tmp`, cat.file);
    this.#state.catalog.version = entry.version;
    this.#saveState();
    this.#o.audit?.({
      adapterId: CATALOG_PACKAGE_ID,
      version: entry.version,
      action: 'catalog',
      reason: `thay bản ${current}`,
    });
    this.#o.notify?.({
      level: 'info',
      message: `Đã tải danh sách hãng/model ${entry.version}; áp dụng khi mở lại NSA.`,
    });
    return true;
  }
}
