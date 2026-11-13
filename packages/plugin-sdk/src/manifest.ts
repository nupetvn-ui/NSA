/**
 * Manifest `nsa-plugin.json` của một app trong App Store — kiểu dữ liệu và bộ kiểm tra.
 * File này không dùng module của Node nên chạy được ở cả lõi, giao diện và plugin.
 */
import { isValidRange, satisfies } from './semver.js';

export const MANIFEST_FILE = 'nsa-plugin.json';

export const ID_PATTERN = /^[a-z][a-z0-9-]{1,23}$/;
export const TOOL_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const RESERVED_IDS = new Set(['nsa', 'mem', 'memory', 'core', 'system']);
const DOMAIN_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$|^localhost$/;
export const SECRET_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;
const INTERVAL_PATTERN = /^(\d+)(s|m|h)$/;

export type FolderAccess = 'read' | 'readwrite';

export interface ManifestFolder {
  /** Mã nội bộ, plugin dùng để hỏi đường dẫn đã được cấp. */
  id: string;
  /** Nhãn hiển thị trong hộp xin quyền. */
  label: string;
  access: FolderAccess;
}

export interface ManifestTool {
  name: string;
  description: string;
  /** JSON Schema của tham số (kiểu object). */
  inputSchema: Record<string, unknown>;
  /** Thao tác nhạy cảm (xoá, gửi hàng loạt…): chính sách luôn hỏi người dùng mỗi lần gọi. */
  sensitive: boolean;
  /** Không sửa gì ngoài dữ liệu của chính plugin (agent ở chế độ chỉ đọc vẫn gọi được). */
  readOnly: boolean;
}

export interface ManifestScreen {
  id: string;
  title: string;
  /** File HTML trong gói, ví dụ `ui/index.html`. */
  entry: string;
}

export interface ManifestJob {
  id: string;
  title: string;
  /** Chạy lặp mỗi N giây (tối thiểu 10). Bỏ trống = chỉ chạy khi được gọi. */
  everySeconds?: number;
  runOnStart: boolean;
}

export interface ManifestMemory {
  /** Tên nhánh riêng của plugin (nằm dưới `plugin/<id>` trong NSA Mem, ẩn mặc định). */
  branch: string;
  title: string;
}

/**
 * Một "khe" cất bí mật (token bot, khoá OA…) của plugin. Người dùng nhập giá trị ở màn hình
 * Quản lý (do NSA vẽ, không phải màn hình của plugin); NSA cất trong kho khoá của hệ điều hành.
 * Plugin KHÔNG BAO GIỜ đọc được giá trị: nó chỉ viết `{{secret:<id>}}` trong URL / header / body
 * của `fetch`, và lõi thay giá trị thật vào — chỉ khi tên miền đích nằm trong `hosts` (ADR-0011).
 */
export interface ManifestSecret {
  id: string;
  label: string;
  /** Hướng dẫn ngắn lấy giá trị ở đâu. */
  help: string;
  /** Tên miền được nhận giá trị này (phải nằm trong `permissions.network`). */
  hosts: string[];
  /**
   * Nơi được đặt `{{secret:id}}`: `url` (chỉ phần đường dẫn, không phải query), `header`, `body`.
   * Mặc định `url` + `header` — KHÔNG cho vào body, để plugin không đem token đăng vào nội dung tin nhắn.
   */
  where: ('url' | 'header' | 'body')[];
}

/**
 * Quyền chạy một chương trình dòng lệnh trên máy người dùng (ví dụ `gws`). Plugin KHÔNG tự sinh
 * tiến trình con (bị cấm — ADR-0010): nó nhờ lõi chạy, và lõi chỉ chạy các lệnh con đã khai trong
 * `allow`, không qua shell, với môi trường tối thiểu, qua Policy + AuditLog (ADR-0012).
 */
export interface ManifestCli {
  id: string;
  /** Nhãn hiển thị trong hộp xin quyền. */
  label: string;
  /** Tên chương trình (không có đường dẫn), tìm trong PATH. */
  command: string;
  /** Cách cài, hiện khi máy chưa có chương trình. */
  install: string;
  /**
   * Các lệnh con được chạy, mỗi mục là phần đầu của dòng lệnh (từng từ phải khớp đúng), ví dụ
   * `drive files list`. `sensitive`: luôn hỏi người dùng mỗi lần chạy.
   */
  allow: { args: string[]; sensitive: boolean }[];
  /** Tham số bị cấm trong mọi lệnh (ví dụ ghi file ra đường dẫn tuỳ ý). */
  denyFlags: string[];
}

/** Bản đóng gói NSA mà plugin được phép có mặt. */
export type ManifestEdition = 'personal' | 'enterprise';

/** Quyền plugin xin được cấp. Không xin thì không bao giờ có. */
export interface PluginPermissions {
  /** Tên miền được gọi mạng. `*.example.com` khớp mọi tên miền con. */
  network: string[];
  folders: ManifestFolder[];
  /** Đọc / đề xuất ghi vào nhánh nhớ của chính plugin (qua hộp duyệt). */
  memory: boolean;
  notifications: boolean;
  /**
   * Nhờ NSA chạy model của việc "kênh chat" (qua kho khoá + chính sách + chi phí). Nội dung plugin
   * gửi đi sẽ tới nhà cung cấp model người dùng đã chọn.
   */
  model: boolean;
  /** Chương trình dòng lệnh nhờ lõi chạy hộ. */
  cli: ManifestCli[];
}

export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  /** `emoji:📝`, hoặc đường dẫn file ảnh (svg / png) trong gói. */
  icon: string;
  version: string;
  /** Dải phiên bản NSA tương thích, ví dụ `>=0.1.0`. */
  nsa: string;
  author: string;
  /** File JavaScript (ESM) chạy trong tiến trình riêng. Null nếu plugin chỉ có màn hình. */
  main: string | null;
  permissions: PluginPermissions;
  tools: ManifestTool[];
  screens: ManifestScreen[];
  jobs: ManifestJob[];
  memory: ManifestMemory | null;
  /** Khe bí mật (token…) — xem `ManifestSecret`. */
  secrets: ManifestSecret[];
  /** Chỉ cài được ở các bản này. Trống = mọi bản. */
  editions: ManifestEdition[];
  /** Cảnh báo phải hiện rõ và được người dùng đồng ý riêng trước khi cài (rủi ro của plugin). */
  warning: string;
}

export interface ManifestError {
  /** Vị trí trong manifest, ví dụ `tools[1].name`. */
  path: string;
  message: string;
}

export type ManifestResult =
  { ok: true; manifest: PluginManifest } | { ok: false; errors: ManifestError[] };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Kiểm một manifest đọc từ JSON; trả mọi lỗi cùng lúc, bằng tiếng Việt dễ hiểu. */
export function validateManifest(raw: unknown): ManifestResult {
  const errors: ManifestError[] = [];
  const err = (path: string, message: string): void => void errors.push({ path, message });
  if (!isObj(raw)) {
    return {
      ok: false,
      errors: [{ path: '', message: 'nsa-plugin.json phải là một đối tượng JSON.' }],
    };
  }

  const str = (
    obj: Obj,
    key: string,
    path: string,
    opts: { max?: number; required?: boolean } = {},
  ): string => {
    const v = obj[key];
    if (v === undefined || v === null) {
      if (opts.required !== false) err(path, `Thiếu "${key}".`);
      return '';
    }
    if (typeof v !== 'string' || v.trim() === '') {
      err(path, `"${key}" phải là chuỗi không rỗng.`);
      return '';
    }
    if (opts.max !== undefined && v.length > opts.max) {
      err(path, `"${key}" dài quá ${opts.max} ký tự.`);
    }
    return v;
  };
  const list = (obj: Obj, key: string, max: number): unknown[] => {
    const v = obj[key];
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      err(key, `"${key}" phải là một danh sách.`);
      return [];
    }
    if (v.length > max) err(key, `"${key}" tối đa ${max} mục.`);
    return v.slice(0, max);
  };

  const id = str(raw, 'id', 'id');
  if (id && !ID_PATTERN.test(id)) {
    err(
      'id',
      `"id" chỉ gồm chữ thường, số, gạch ngang, bắt đầu bằng chữ, dài 2–24 ký tự (nhận được "${id}").`,
    );
  } else if (RESERVED_IDS.has(id)) {
    err('id', `"id" "${id}" là tên dành riêng của NSA.`);
  }
  const name = str(raw, 'name', 'name', { max: 60 });
  const description = str(raw, 'description', 'description', { max: 400, required: false });
  const version = str(raw, 'version', 'version');
  if (version && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    err('version', `"version" phải có dạng 1.2.3 (nhận được "${version}").`);
  }
  const nsa = str(raw, 'nsa', 'nsa');
  if (nsa && !isValidRange(nsa)) {
    err('nsa', `"nsa" phải là dải phiên bản như ">=0.1.0" hoặc "^0.2.0" (nhận được "${nsa}").`);
  }
  const author = str(raw, 'author', 'author', { max: 80, required: false });

  let icon = str(raw, 'icon', 'icon', { max: 200, required: false });
  if (icon === '') icon = 'emoji:🧩';
  else if (!icon.startsWith('emoji:')) {
    if (!/\.(svg|png)$/i.test(icon) || icon.startsWith('/') || icon.includes('..')) {
      err(
        'icon',
        '"icon" phải là "emoji:🙂" hoặc đường dẫn tương đối tới file .svg / .png trong gói.',
      );
    }
  } else if (icon.length < 7 || icon.length > 20) {
    err('icon', '"icon" kiểu emoji chỉ nhận một biểu tượng, ví dụ "emoji:📝".');
  }

  let main: string | null = null;
  if (raw['main'] !== undefined && raw['main'] !== null) {
    main = str(raw, 'main', 'main');
    if (main && (!/\.m?js$/.test(main) || main.startsWith('/') || main.includes('..'))) {
      err('main', '"main" phải là đường dẫn tương đối tới file .js / .mjs trong gói.');
    }
  }

  // ---- quyền
  const permissions: PluginPermissions = {
    network: [],
    folders: [],
    memory: false,
    notifications: false,
    model: false,
    cli: [],
  };
  const rawPerm = raw['permissions'];
  if (rawPerm !== undefined) {
    if (!isObj(rawPerm)) err('permissions', '"permissions" phải là một đối tượng.');
    else {
      for (const key of Object.keys(rawPerm)) {
        if (!['network', 'folders', 'memory', 'notifications', 'model', 'cli'].includes(key)) {
          err(
            `permissions.${key}`,
            `Quyền "${key}" không tồn tại. Có: network, folders, memory, notifications, model, cli.`,
          );
        }
      }
      const net = rawPerm['network'];
      if (net !== undefined) {
        if (!Array.isArray(net) || !net.every((d) => typeof d === 'string')) {
          err(
            'permissions.network',
            '"network" phải là danh sách tên miền, ví dụ ["api.example.com"].',
          );
        } else {
          (net as string[]).forEach((d, i) => {
            if (!DOMAIN_PATTERN.test(d)) {
              err(
                `permissions.network[${i}]`,
                `"${d}" không phải tên miền hợp lệ (chữ thường, ví dụ "api.example.com" hoặc "*.example.com").`,
              );
            } else permissions.network.push(d);
          });
        }
      }
      const folders = rawPerm['folders'];
      if (folders !== undefined) {
        if (!Array.isArray(folders)) err('permissions.folders', '"folders" phải là một danh sách.');
        else {
          const seen = new Set<string>();
          (folders as unknown[]).slice(0, 10).forEach((f, i) => {
            const p = `permissions.folders[${i}]`;
            if (!isObj(f)) return err(p, 'Mỗi thư mục là một đối tượng { id, label, access }.');
            const fid = str(f, 'id', `${p}.id`);
            if (fid && !/^[a-z][a-z0-9_]{0,23}$/.test(fid)) {
              err(`${p}.id`, '"id" thư mục chỉ gồm chữ thường, số, gạch dưới.');
            }
            if (seen.has(fid)) err(`${p}.id`, `Trùng id thư mục "${fid}".`);
            seen.add(fid);
            const label = str(f, 'label', `${p}.label`, { max: 80 });
            const access = f['access'];
            if (access !== 'read' && access !== 'readwrite') {
              err(`${p}.access`, '"access" phải là "read" hoặc "readwrite".');
            } else if (fid && label) permissions.folders.push({ id: fid, label, access });
          });
        }
      }
      const rawCli = rawPerm['cli'];
      if (rawCli !== undefined) {
        if (!Array.isArray(rawCli)) err('permissions.cli', '"cli" phải là một danh sách.');
        else {
          const seen = new Set<string>();
          (rawCli as unknown[]).slice(0, 4).forEach((c, i) => {
            const p = `permissions.cli[${i}]`;
            if (!isObj(c))
              return err(p, 'Mỗi mục là một đối tượng { id, label, command, install, allow }.');
            const cid = str(c, 'id', `${p}.id`);
            if (cid && !SECRET_PATTERN.test(cid))
              err(`${p}.id`, '"id" chỉ gồm chữ thường, số, gạch dưới.');
            if (seen.has(cid)) err(`${p}.id`, `Trùng id "${cid}".`);
            seen.add(cid);
            const label = str(c, 'label', `${p}.label`, { max: 80 });
            const command = str(c, 'command', `${p}.command`, { max: 40 });
            if (command && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(command)) {
              err(
                `${p}.command`,
                '"command" chỉ là tên chương trình (chữ, số, ., _, -), không có đường dẫn hay dấu cách.',
              );
            }
            const install = str(c, 'install', `${p}.install`, { max: 400, required: false });
            const allow: ManifestCli['allow'] = [];
            const rawAllow = c['allow'];
            if (!Array.isArray(rawAllow) || rawAllow.length === 0) {
              err(
                `${p}.allow`,
                '"allow" phải là danh sách lệnh con được chạy, ví dụ ["drive files list"].',
              );
            } else {
              (rawAllow as unknown[]).slice(0, 60).forEach((a, k) => {
                const sensitive = isObj(a) && a['sensitive'] === true;
                const text = typeof a === 'string' ? a : isObj(a) ? a['args'] : undefined;
                if (typeof text !== 'string' || text.trim() === '') {
                  return err(
                    `${p}.allow[${k}]`,
                    'Mỗi mục là chuỗi "drive files list" hoặc { "args": "…", "sensitive": true }.',
                  );
                }
                const words = text.trim().split(/\s+/);
                if (words.some((w) => !/^[A-Za-z0-9+_.:-]+$/.test(w))) {
                  return err(
                    `${p}.allow[${k}]`,
                    `"${text}" chỉ gồm các từ chữ / số / +_.:- ngăn bằng dấu cách.`,
                  );
                }
                allow.push({ args: words, sensitive });
              });
            }
            const denyFlags: string[] = [];
            const rawDeny = c['denyFlags'];
            if (rawDeny !== undefined) {
              if (
                !Array.isArray(rawDeny) ||
                !rawDeny.every((f) => typeof f === 'string' && /^-{1,2}[A-Za-z0-9-]+$/.test(f))
              ) {
                err(
                  `${p}.denyFlags`,
                  '"denyFlags" phải là danh sách tham số như ["--output", "-o"].',
                );
              } else denyFlags.push(...(rawDeny as string[]));
            }
            if (cid && label && command && allow.length > 0) {
              permissions.cli.push({ id: cid, label, command, install, allow, denyFlags });
            }
          });
        }
      }
      for (const key of ['memory', 'notifications', 'model'] as const) {
        const v = rawPerm[key];
        if (v === undefined) continue;
        if (typeof v !== 'boolean') err(`permissions.${key}`, `"${key}" phải là true hoặc false.`);
        else permissions[key] = v;
      }
    }
  }

  // ---- tool
  const tools: ManifestTool[] = [];
  const toolNames = new Set<string>();
  list(raw, 'tools', 40).forEach((t, i) => {
    const p = `tools[${i}]`;
    if (!isObj(t)) return err(p, 'Mỗi tool là một đối tượng { name, description, inputSchema }.');
    const tname = str(t, 'name', `${p}.name`);
    if (tname && !TOOL_PATTERN.test(tname)) {
      err(
        `${p}.name`,
        `Tên tool "${tname}" chỉ gồm chữ thường, số, gạch dưới, bắt đầu bằng chữ, tối đa 32 ký tự.`,
      );
    }
    if (toolNames.has(tname)) err(`${p}.name`, `Trùng tên tool "${tname}".`);
    toolNames.add(tname);
    const tdesc = str(t, 'description', `${p}.description`, { max: 800 });
    let schema: Record<string, unknown> = { type: 'object', properties: {} };
    if (t['inputSchema'] !== undefined) {
      const given = t['inputSchema'];
      if (!isObj(given) || given['type'] !== 'object') {
        err(`${p}.inputSchema`, '"inputSchema" phải là JSON Schema có "type": "object".');
      } else schema = given;
    }
    for (const flag of ['sensitive', 'readOnly']) {
      if (t[flag] !== undefined && typeof t[flag] !== 'boolean') {
        err(`${p}.${flag}`, `"${flag}" phải là true hoặc false.`);
      }
    }
    if (t['sensitive'] === true && t['readOnly'] === true) {
      err(p, 'Tool không thể vừa "sensitive" vừa "readOnly".');
    }
    if (tname && tdesc) {
      tools.push({
        name: tname,
        description: tdesc,
        inputSchema: schema,
        sensitive: t['sensitive'] === true,
        readOnly: t['readOnly'] === true,
      });
    }
  });
  if (tools.length > 0 && main === null) {
    err('main', 'Plugin có tool thì phải có "main" (file chạy tool).');
  }

  // ---- màn hình
  const screens: ManifestScreen[] = [];
  const screenIds = new Set<string>();
  list(raw, 'screens', 10).forEach((s, i) => {
    const p = `screens[${i}]`;
    if (!isObj(s)) return err(p, 'Mỗi màn hình là một đối tượng { id, title, entry }.');
    const sid = str(s, 'id', `${p}.id`);
    if (sid && !/^[a-z][a-z0-9-]{0,23}$/.test(sid)) {
      err(`${p}.id`, '"id" màn hình chỉ gồm chữ thường, số, gạch ngang.');
    }
    if (screenIds.has(sid)) err(`${p}.id`, `Trùng id màn hình "${sid}".`);
    screenIds.add(sid);
    const title = str(s, 'title', `${p}.title`, { max: 60 });
    const entry = str(s, 'entry', `${p}.entry`);
    if (entry && (!/\.html?$/i.test(entry) || entry.startsWith('/') || entry.includes('..'))) {
      err(`${p}.entry`, '"entry" phải là đường dẫn tương đối tới file .html trong gói.');
    }
    if (sid && title && entry) screens.push({ id: sid, title, entry });
  });

  // ---- việc nền
  const jobs: ManifestJob[] = [];
  const jobIds = new Set<string>();
  list(raw, 'jobs', 10).forEach((j, i) => {
    const p = `jobs[${i}]`;
    if (!isObj(j)) return err(p, 'Mỗi việc nền là một đối tượng { id, title, every }.');
    const jid = str(j, 'id', `${p}.id`);
    if (jid && !TOOL_PATTERN.test(jid)) {
      err(`${p}.id`, '"id" việc nền chỉ gồm chữ thường, số, gạch dưới.');
    }
    if (jobIds.has(jid)) err(`${p}.id`, `Trùng id việc nền "${jid}".`);
    jobIds.add(jid);
    const title = str(j, 'title', `${p}.title`, { max: 80 });
    let everySeconds: number | undefined;
    if (j['every'] !== undefined) {
      const m = typeof j['every'] === 'string' ? INTERVAL_PATTERN.exec(j['every']) : null;
      if (!m) err(`${p}.every`, '"every" phải có dạng "30s", "5m" hoặc "1h".');
      else {
        everySeconds = Number(m[1]) * ({ s: 1, m: 60, h: 3600 }[m[2] as 's' | 'm' | 'h'] ?? 1);
        if (everySeconds < 10) err(`${p}.every`, 'Việc nền chạy nhanh nhất mỗi 10 giây.');
      }
    }
    if (j['runOnStart'] !== undefined && typeof j['runOnStart'] !== 'boolean') {
      err(`${p}.runOnStart`, '"runOnStart" phải là true hoặc false.');
    }
    if (jid && title) {
      jobs.push({
        id: jid,
        title,
        ...(everySeconds ? { everySeconds } : {}),
        runOnStart: j['runOnStart'] === true,
      });
    }
  });
  if (jobs.length > 0 && main === null) err('main', 'Plugin có việc nền thì phải có "main".');

  // ---- nhánh nhớ
  let memory: ManifestMemory | null = null;
  if (raw['memory'] !== undefined && raw['memory'] !== null) {
    const m = raw['memory'];
    if (!isObj(m)) err('memory', '"memory" phải là một đối tượng { branch, title }.');
    else {
      const branch = str(m, 'branch', 'memory.branch');
      if (branch && !/^[a-z][a-z0-9-]{0,31}$/.test(branch)) {
        err(
          'memory.branch',
          '"branch" chỉ gồm chữ thường, số, gạch ngang (một cấp, không có "/").',
        );
      }
      const title = str(m, 'title', 'memory.title', { max: 60, required: false });
      if (branch) memory = { branch, title: title || name || branch };
      if (!permissions.memory) {
        err(
          'permissions.memory',
          'Plugin có "memory" thì phải xin quyền: "permissions": { "memory": true }.',
        );
      }
    }
  } else if (permissions.memory) {
    err(
      'memory',
      'Xin quyền "memory" thì phải khai báo nhánh: "memory": { "branch": "…", "title": "…" }.',
    );
  }

  // ---- khe bí mật
  const secrets: ManifestSecret[] = [];
  const secretIds = new Set<string>();
  list(raw, 'secrets', 8).forEach((x, i) => {
    const p = `secrets[${i}]`;
    if (!isObj(x)) return err(p, 'Mỗi khe bí mật là một đối tượng { id, label, hosts }.');
    const sid = str(x, 'id', `${p}.id`);
    if (sid && !SECRET_PATTERN.test(sid)) {
      err(`${p}.id`, '"id" khe bí mật chỉ gồm chữ thường, số, gạch dưới.');
    }
    if (secretIds.has(sid)) err(`${p}.id`, `Trùng id khe bí mật "${sid}".`);
    secretIds.add(sid);
    const label = str(x, 'label', `${p}.label`, { max: 80 });
    const help = str(x, 'help', `${p}.help`, { max: 300, required: false });
    const hosts: string[] = [];
    const rawHosts = x['hosts'];
    if (!Array.isArray(rawHosts) || rawHosts.length === 0) {
      err(`${p}.hosts`, '"hosts" phải là danh sách tên miền được nhận giá trị này.');
    } else {
      (rawHosts as unknown[]).forEach((h, k) => {
        if (typeof h !== 'string' || !DOMAIN_PATTERN.test(h)) {
          err(`${p}.hosts[${k}]`, `"${String(h)}" không phải tên miền hợp lệ.`);
        } else if (h.startsWith('*.')) {
          err(`${p}.hosts[${k}]`, 'Khe bí mật chỉ gắn với tên miền cụ thể, không dùng "*.".');
        } else if (!permissions.network.includes(h)) {
          err(`${p}.hosts[${k}]`, `"${h}" phải nằm trong permissions.network.`);
        } else hosts.push(h);
      });
    }
    const where: ('url' | 'header' | 'body')[] = [];
    const rawWhere = x['where'];
    if (rawWhere === undefined) where.push('url', 'header');
    else if (!Array.isArray(rawWhere) || rawWhere.length === 0) {
      err(`${p}.where`, '"where" phải là danh sách trong "url", "header", "body".');
    } else {
      (rawWhere as unknown[]).forEach((w, k) => {
        if (w !== 'url' && w !== 'header' && w !== 'body') {
          err(`${p}.where[${k}]`, '"where" chỉ nhận "url", "header" hoặc "body".');
        } else if (!where.includes(w)) where.push(w);
      });
    }
    if (sid && label && hosts.length > 0) secrets.push({ id: sid, label, help, hosts, where });
  });

  const editions: ManifestEdition[] = [];
  if (raw['editions'] !== undefined) {
    const e = raw['editions'];
    if (!Array.isArray(e) || e.length === 0) {
      err('editions', '"editions" phải là danh sách, ví dụ ["personal"].');
    } else {
      (e as unknown[]).forEach((v, i) => {
        if (v !== 'personal' && v !== 'enterprise') {
          err(`editions[${i}]`, '"editions" chỉ nhận "personal" hoặc "enterprise".');
        } else if (!editions.includes(v)) editions.push(v);
      });
    }
  }
  const warning = str(raw, 'warning', 'warning', { max: 1500, required: false });

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      id,
      name,
      description,
      icon,
      version,
      nsa,
      author,
      main,
      permissions,
      tools,
      screens,
      jobs,
      memory,
      secrets,
      editions,
      warning,
    },
  };
}

/** Gộp các lỗi thành một đoạn văn bản dễ đọc. */
export function formatManifestErrors(errors: ManifestError[]): string {
  return errors.map((e) => (e.path ? `• ${e.path}: ${e.message}` : `• ${e.message}`)).join('\n');
}

/** Manifest này chạy được trên phiên bản NSA `nsaVersion` không. */
export function isCompatible(manifest: Pick<PluginManifest, 'nsa'>, nsaVersion: string): boolean {
  return satisfies(nsaVersion, manifest.nsa);
}

/** Tên miền có nằm trong danh sách đã cấp không (`*.a.com` khớp `x.a.com`, không khớp `a.com`). */
export function domainAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((pattern) =>
    pattern.startsWith('*.') ? h.endsWith(pattern.slice(1)) : h === pattern,
  );
}

/** Chỗ giữ chỗ plugin viết thay cho giá trị bí mật: `{{secret:bot_token}}`. */
export const SECRET_PLACEHOLDER_SOURCE = '\\{\\{secret:([a-z][a-z0-9_]{0,23})\\}\\}';

/** Tên tool mà agent nhìn thấy qua cổng MCP: `<plugin>__<tool>`. */
export function gatewayToolName(pluginId: string, tool: string): string {
  return `${pluginId.replace(/-/g, '_')}__${tool}`;
}
