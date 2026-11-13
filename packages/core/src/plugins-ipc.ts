/**
 * Kênh IPC của App Store (ADR-0010). Màn hình của plugin KHÔNG gọi các kênh này: nó chạy trong
 * khung cô lập và chỉ nói chuyện với plugin của chính nó qua `plugins:ui`, do giao diện chuyển tiếp.
 */
import type {
  InstallResult,
  PluginGrants,
  PluginIcon,
  PluginInfo,
  PluginSettings,
  PreparedInstall,
  RegistryEntry,
} from '@nsa/plugin-sdk';

export type {
  InstallResult,
  PluginGrants,
  PluginIcon,
  PluginInfo,
  PluginSettings,
  PreparedInstall,
  RegistryEntry,
};

/** Nguồn cài: chọn thư mục / file bằng hộp thoại, đường dẫn cụ thể, hoặc một mục trong kho. */
export type PluginSource =
  | { kind: 'pick'; what: 'directory' | 'file' }
  | { kind: 'path'; path: string }
  | { kind: 'registry'; id: string };

export interface PluginsIpcContract {
  'plugins:list': { args: []; result: PluginInfo[] };
  'plugins:settings': { args: []; result: PluginSettings };
  'plugins:saveSettings': { args: [patch: Partial<PluginSettings>]; result: PluginSettings };
  /** Đọc + kiểm gói. Người dùng bấm Huỷ ở hộp thoại → null. */
  'plugins:prepare': { args: [source: PluginSource]; result: PreparedInstall | null };
  'plugins:install': {
    args: [prepareId: string, grants: PluginGrants, confirmed?: boolean];
    result: InstallResult;
  };
  'plugins:setEnabled': { args: [id: string, enabled: boolean]; result: PluginInfo };
  'plugins:uninstall': { args: [id: string, deleteData?: boolean]; result: void };
  'plugins:updateGrants': { args: [id: string, grants: PluginGrants]; result: PluginInfo };
  'plugins:runJob': { args: [id: string, jobId: string]; result: void };
  /** Người dùng chọn một thư mục để cấp cho plugin. */
  'plugins:pickFolder': { args: [label: string]; result: string | null };
  'plugins:registry': { args: []; result: RegistryEntry[] };
  /** Màn hình của plugin gọi một hàm trong plugin của chính nó. */
  'plugins:ui': { args: [id: string, method: string, params: unknown]; result: unknown };
}

export interface PluginsIpcEventContract {
  /** Danh sách plugin hoặc trạng thái của một plugin vừa đổi. */
  'plugins:changed': PluginInfo[];
  /** Plugin gửi sự kiện cho màn hình đang mở của nó. */
  'plugins:uiEvent': { pluginId: string; event: string; data: unknown };
}

export const PLUGINS_IPC_CHANNELS = [
  'plugins:list',
  'plugins:settings',
  'plugins:saveSettings',
  'plugins:prepare',
  'plugins:install',
  'plugins:setEnabled',
  'plugins:uninstall',
  'plugins:updateGrants',
  'plugins:runJob',
  'plugins:pickFolder',
  'plugins:registry',
  'plugins:ui',
] as const satisfies readonly (keyof PluginsIpcContract)[];

export const PLUGINS_IPC_EVENT_CHANNELS = [
  'plugins:changed',
  'plugins:uiEvent',
] as const satisfies readonly (keyof PluginsIpcEventContract)[];
