/**
 * Gói adapter / file dữ liệu cập nhật độc lập với app (G1, ADR-0016). Dùng lại đúng định dạng
 * `.nsapkg`, chữ ký Ed25519 và kiểm phiên bản tương thích (`nsa`) của plugin; chỉ thêm một
 * manifest riêng `adapter.json` (không phải `plugin.json`).
 */
import type { AgentAdapter } from '@nsa/adapter-sdk';

export const ADAPTER_MANIFEST_FILE = 'adapter.json';
/** Mã chữ ký hợp đồng mà app hiểu; gói khai báo `contract` khác thì bị bỏ qua. */
export const ADAPTER_CONTRACT = 1;
/** Mã gói của file dữ liệu hãng/model. */
export const CATALOG_PACKAGE_ID = 'provider-catalog';

export type AdapterPackageKind = 'adapter' | 'catalog';

export interface AdapterPackageManifest {
  schema: 1;
  kind: AdapterPackageKind;
  /** `claude`, `codex`… hoặc `provider-catalog`. */
  id: string;
  version: string;
  /** Khoảng phiên bản NSA chạy được (cùng cú pháp với `nsa` của plugin). */
  nsa: string;
  /** File vào của gói: module CommonJS (adapter) hoặc file JSON (catalog). */
  entry: string;
  /** Chỉ adapter: phiên bản hợp đồng module. */
  contract?: number;
}

/** Một dòng trong file chỉ mục. */
export interface AdapterIndexEntry {
  id: string;
  kind: AdapterPackageKind;
  version: string;
  nsa: string;
  /** Đường dẫn (tương đối so với chỉ mục) hoặc URL tới file `.nsapkg`. */
  package: string;
  sha256?: string;
}

/** Nguồn tải gói: file chỉ mục sau một interface; kho riêng của doanh nghiệp cắm vào đây. */
export interface AdapterSource {
  list(): Promise<AdapterIndexEntry[]>;
  fetchPackage(entry: AdapterIndexEntry): Promise<Buffer>;
}

/** Module trong gói adapter (CommonJS). */
export interface AdapterModule {
  contract: number;
  createAdapter(params?: unknown): AgentAdapter;
}

/** Adapter kèm app — bản dự phòng. */
export interface BundledAdapter {
  id: string;
  version: string;
  create(params?: unknown): AgentAdapter;
}

export type AdapterUpdateAction = 'installed' | 'rejected' | 'fallback' | 'catalog';

/** Sự kiện cho nhật ký (AuditLog). */
export interface AdapterAuditEvent {
  adapterId: string;
  version: string;
  action: AdapterUpdateAction;
  reason: string;
}

/** Thông báo cho người dùng. */
export interface AdapterNotice {
  level: 'info' | 'warn';
  message: string;
}

export interface AdapterStatus {
  id: string;
  source: 'bundled' | 'downloaded';
  version: string;
  bundledVersion: string;
}

export interface UpdateReport {
  installed: { id: string; version: string }[];
  rejected: { id: string; version: string; reason: string }[];
  /** Lỗi mạng / chỉ mục — không phải lỗi của gói nào. */
  error?: string;
}
