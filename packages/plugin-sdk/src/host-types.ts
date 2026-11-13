/**
 * Kiểu dữ liệu giữa plugin host, giao diện App Store và cổng MCP — thuần kiểu, không có mã Node.
 */
import type { PluginManifest, PluginPermissions } from './manifest.js';

/** Kết quả kiểm chữ ký của một gói. */
export type SignatureStatus =
  /** Chữ ký đúng và khoá nhà phát hành nằm trong danh sách NSA tin cậy. */
  | 'trusted'
  /** Chữ ký đúng nhưng khoá nhà phát hành chưa được tin. */
  | 'untrusted'
  /** Gói không có chữ ký (hoặc cài từ thư mục). */
  | 'unsigned'
  /** Có chữ ký nhưng nội dung đã bị sửa sau khi ký (hoặc chữ ký hỏng) — luôn bị từ chối. */
  | 'tampered';

/** Quyền người dùng đã cấp — luôn là tập con của điều plugin xin. */
export interface PluginGrants {
  network: string[];
  /** id thư mục → đường dẫn tuyệt đối người dùng chọn. */
  folders: Record<string, string>;
  memory: boolean;
  notifications: boolean;
  /** Cho plugin nhờ NSA chạy model "kênh chat". */
  model: boolean;
  /** id các chương trình dòng lệnh (`permissions.cli`) người dùng cho phép chạy. */
  cli: string[];
}

/** Trạng thái một khe bí mật — giao diện chỉ thấy có / chưa có và bốn ký tự cuối, không bao giờ thấy giá trị. */
export interface PluginSecretInfo {
  id: string;
  label: string;
  help: string;
  hosts: string[];
  where: ('url' | 'header' | 'body')[];
  set: boolean;
  hint?: string;
}

export type PluginStatus = 'stopped' | 'starting' | 'running' | 'crashed' | 'failed';

export type PluginIcon = { kind: 'emoji'; value: string } | { kind: 'image'; dataUrl: string };

export interface PluginJobInfo {
  id: string;
  title: string;
  everySeconds?: number;
  lastRun?: string;
  lastError?: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  icon: PluginIcon;
  enabled: boolean;
  status: PluginStatus;
  statusMessage?: string;
  signature: SignatureStatus;
  /** Tên nhà phát hành nếu chữ ký đúng và khoá được tin. */
  publisher?: string;
  /** Cài từ thư mục ở chế độ nhà phát triển (chưa ký). */
  developer: boolean;
  manifest: PluginManifest;
  grants: PluginGrants;
  jobs: PluginJobInfo[];
  secrets: PluginSecretInfo[];
  installedAt: string;
}

/** Gói đã được đọc và kiểm tra, chờ người dùng xem quyền rồi xác nhận cài. */
export interface PreparedInstall {
  prepareId: string;
  /** Cảnh báo riêng của plugin (rủi ro): người dùng phải đồng ý rõ trước khi cài. */
  riskWarning?: string;
  manifest: PluginManifest;
  icon: PluginIcon;
  signature: SignatureStatus;
  publisher?: string;
  /** Đang cài đè một bản cũ. */
  upgradeFrom?: string;
  /** Quyền xin thêm so với bản đang cài (khi cập nhật). */
  newPermissions: string[];
  /** Cảnh báo cần hiện rõ (chưa ký, nhà phát hành lạ…). */
  warnings: string[];
  /** Không cài được — lý do. */
  blocked?: string;
}

export type InstallResult =
  | { status: 'installed'; plugin: PluginInfo }
  | { status: 'needs_confirmation'; reason: string }
  | { status: 'denied'; reason: string };

export type { PluginManifest, PluginPermissions };

/** Cài từ nguồn nào (đường dẫn thư mục, file `.nsapkg`, hoặc mục trong kho). */
export interface RegistryEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  icon: string;
  /** Tương thích với phiên bản NSA đang chạy. */
  compatible: boolean;
  nsa: string;
  /** Đường dẫn hoặc URL của file `.nsapkg`. */
  package: string;
  sha256?: string;
  /** Phiên bản đang cài trên máy (nếu có). */
  installed?: string;
  updateAvailable: boolean;
}

export interface PluginSettings {
  /** Chế độ nhà phát triển: cho cài plugin chưa ký từ thư mục (kèm cảnh báo). */
  developerMode: boolean;
  /** Nguồn kho: đường dẫn hoặc URL của file chỉ mục. Trống = chưa có kho. */
  registry: string;
}
