/**
 * Lắp ghép adapter cập nhật độc lập với app (G1, ADR-0016). Adapter kèm app là bản dự phòng;
 * bản tải về (đã ký bằng khoá của NSA, tương thích, mới hơn, qua test hợp đồng) được ưu tiên.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  AdapterManager,
  IndexAdapterSource,
  DEFAULT_ADAPTER_INDEX_URL,
  type AdapterAuditEvent,
  type AdapterNotice,
  type BundledAdapter,
} from '@nsa/adapter-host';
import { createAntigravityAdapter } from '@nsa/adapter-antigravity';
import { createClaudeAdapter } from '@nsa/adapter-claude';
import { createCodexAdapter } from '@nsa/adapter-codex';
import { createGeminiAdapter } from '@nsa/adapter-gemini';
import { createOpenCodeAdapter } from '@nsa/adapter-opencode';
import type { CliAdapterFactories, CliAdapterParams } from '@nsa/providers';
import { bundledCatalog, validateCatalog } from '@nsa/providers';
import type { TrustedPublisher } from '@nsa/plugin-host';
import antigravityPkg from '../../../../packages/adapters/antigravity/package.json';
import claudePkg from '../../../../packages/adapters/claude/package.json';
import codexPkg from '../../../../packages/adapters/codex/package.json';
import geminiPkg from '../../../../packages/adapters/gemini/package.json';
import opencodePkg from '../../../../packages/adapters/opencode/package.json';

/** Mã adapter có thể cập nhật độc lập. */
export const UPDATABLE_ADAPTERS = ['claude', 'codex', 'opencode', 'gemini', 'antigravity'] as const;

/** Adapter kèm app: phiên bản lấy từ `package.json` của từng adapter. */
export function bundledAdapters(): BundledAdapter[] {
  return [
    { id: 'claude', version: claudePkg.version, create: (p) => createClaudeAdapter(p as object) },
    { id: 'codex', version: codexPkg.version, create: (p) => createCodexAdapter(p as object) },
    {
      id: 'opencode',
      version: opencodePkg.version,
      create: (p) => createOpenCodeAdapter(p as object),
    },
    { id: 'gemini', version: geminiPkg.version, create: (p) => createGeminiAdapter(p as object) },
    {
      id: 'antigravity',
      version: antigravityPkg.version,
      create: (p) => createAntigravityAdapter(p as object),
    },
  ];
}

/** Hàm tạo adapter CLI cho `ProviderHub` — luôn qua bộ quản lý (nên dùng được bản tải về). */
export function cliAdapterFactoriesOf(
  manager: Pick<AdapterManager, 'create'>,
): CliAdapterFactories {
  const make = (id: string) => (params: CliAdapterParams) => manager.create(id, params);
  return { claude: make('claude'), codex: make('codex'), opencode: make('opencode') };
}

/** Bản kèm app, không qua bộ quản lý — cho test chạy adapter thật. */
export const bundledCliAdapterFactories: CliAdapterFactories = {
  claude: (p) => createClaudeAdapter(p),
  codex: (p) => createCodexAdapter(p),
  opencode: (p) => createOpenCodeAdapter(p),
};

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Khoá của NSA đóng cùng app (`resources/adapter-trust.json`) — KHÔNG lấy từ chỉ mục tải về hay thư
 * mục dữ liệu. Bản phát triển (chưa đóng gói) được trỏ file khác bằng `NSA_ADAPTER_TRUST_FILE`.
 */
export function loadAdapterTrust(resourcesDir: string, isPackaged: boolean): TrustedPublisher[] {
  const override = process.env['NSA_ADAPTER_TRUST_FILE'];
  const file = !isPackaged && override ? override : join(resourcesDir, 'adapter-trust.json');
  const raw = readJson(file) as { keys?: unknown } | undefined;
  if (!raw || !Array.isArray(raw.keys)) return [];
  return raw.keys.filter(
    (k): k is TrustedPublisher =>
      typeof k === 'object' &&
      k !== null &&
      typeof (k as TrustedPublisher).keyId === 'string' &&
      typeof (k as TrustedPublisher).name === 'string' &&
      typeof (k as TrustedPublisher).publicKey === 'string',
  );
}

export interface AdaptersSetupOptions {
  userData: string;
  appVersion: string;
  isPackaged: boolean;
  /** Thư mục `resources` của app (chứa `adapter-trust.json`). */
  resourcesDir: string;
  audit: (event: AdapterAuditEvent) => void;
  notify: (notice: AdapterNotice) => void;
  onChanged: (adapterIds: string[]) => void;
}

export interface AdaptersSetup {
  manager: AdapterManager;
  /** Có cho cập nhật không (có khoá tin cậy, hoặc chế độ phát triển). */
  updatesEnabled: boolean;
}

export function setupAdapters(options: AdaptersSetupOptions): AdaptersSetup {
  // Adapter tải về không có node_modules riêng: cho chúng nạp node-pty (native) từ chính app.
  (globalThis as { nsaHostRequire?: (id: string) => unknown }).nsaHostRequire =
    createRequire(__filename);
  const trusted = loadAdapterTrust(options.resourcesDir, options.isPackaged);
  // Chế độ nhà phát triển: chỉ khi chưa đóng gói VÀ bật rõ ràng bằng biến môi trường.
  const allowUnsigned = !options.isPackaged && process.env['NSA_ADAPTER_ALLOW_UNSIGNED'] === '1';
  const sourceFile = readJson(join(options.userData, 'adapter-source.json')) as
    { indexUrl?: unknown } | undefined;
  const indexUrl =
    process.env['NSA_ADAPTER_INDEX_URL'] ||
    (typeof sourceFile?.indexUrl === 'string' ? sourceFile.indexUrl : '') ||
    DEFAULT_ADAPTER_INDEX_URL;
  const updatesEnabled =
    process.env['NSA_ADAPTER_UPDATES'] !== 'off' && (trusted.length > 0 || allowUnsigned);
  if (!updatesEnabled) {
    console.warn(
      '[adapters] không tự cập nhật: chưa có khoá tin cậy của NSA (resources/adapter-trust.json) hoặc đã tắt',
    );
  }
  const manager = new AdapterManager({
    dir: join(options.userData, 'adapters'),
    appVersion: options.appVersion,
    bundled: bundledAdapters(),
    trusted,
    allowUnsigned,
    ...(updatesEnabled ? { source: new IndexAdapterSource(indexUrl) } : {}),
    audit: options.audit,
    notify: options.notify,
    onChanged: options.onChanged,
    catalog: {
      file: join(options.userData, 'provider-catalog.json'),
      bundledVersion: bundledCatalog().version,
      validate: (json) => {
        const errors = validateCatalog(json);
        return errors.length > 0
          ? errors.join('; ')
          : { version: (json as { version: string }).version };
      },
    },
  });
  return { manager, updatesEnabled };
}
