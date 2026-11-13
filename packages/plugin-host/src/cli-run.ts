/**
 * Chạy chương trình dòng lệnh hộ plugin (quyền `cli`, ADR-0012). Plugin không tự sinh tiến trình con;
 * lõi chạy với các ràng buộc:
 * - chỉ lệnh con nằm trong `allow` của manifest (so khớp từng từ ở đầu dòng lệnh);
 * - KHÔNG qua shell (`execFile`), mỗi phần tử là một tham số — chuỗi như `; rm -rf` chỉ là chữ;
 * - môi trường tối thiểu: không thừa kế biến nào của app ngoài những biến chương trình cần để tìm
 *   cấu hình của chính nó;
 * - hết giờ thì giết; đầu ra bị cắt.
 */
import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { CliResult, ManifestCli } from '@nsa/plugin-sdk';

/** Cách chạy một chương trình: tệp thật + tham số chèn trước (test dùng `node fake.js`). */
export interface ResolvedCommand {
  file: string;
  prefixArgs: string[];
}

export type CliResolver = (command: string) => ResolvedCommand | { error: string };

const MAX_ARGS = 60;
const MAX_ARG_CHARS = 30_000;
const MAX_OUTPUT = 1_000_000;

/** Biến môi trường chương trình cần để tìm cấu hình / kho khoá của nó. Mọi biến khác bị bỏ. */
const ENV_ALLOW = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'windir',
  'USERPROFILE',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'TEMP',
  'TMP',
  'XDG_CONFIG_HOME',
  'GOOGLE_APPLICATION_CREDENTIALS',
];

export function minimalEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(source)) {
    // Windows không phân biệt hoa thường tên biến.
    if (
      ENV_ALLOW.some((k) => k.toLowerCase() === key.toLowerCase()) ||
      key.startsWith('GOOGLE_WORKSPACE_')
    ) {
      env[key] = source[key];
    }
  }
  return env;
}

/** Tìm tệp chạy được trong PATH. Windows: chỉ `.exe` (`.cmd` / `.bat` cần shell nên không dùng). */
export function defaultResolver(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCommand | { error: string } {
  const dirs = String(env['PATH'] ?? env['Path'] ?? '')
    .split(delimiter)
    .filter(Boolean);
  const win = process.platform === 'win32';
  let shim = false;
  for (const dir of dirs) {
    const exe = join(dir, win ? `${command}.exe` : command);
    if (existsSync(exe) && statSync(exe).isFile()) return { file: exe, prefixArgs: [] };
    if (win && (existsSync(join(dir, `${command}.cmd`)) || existsSync(join(dir, `${command}.bat`))))
      shim = true;
  }
  if (shim) {
    return {
      error: `Tìm thấy "${command}" nhưng chỉ là tệp .cmd / .bat (cài bằng npm) — NSA không chạy qua shell. Hãy tải bản chạy trực tiếp (.exe).`,
    };
  }
  return { error: `Máy chưa có chương trình "${command}" trong PATH.` };
}

/** Lệnh con khớp với phần đầu của `args` (từng từ đúng nguyên văn) — trả mục khớp dài nhất, hoặc null. */
export function matchAllow(
  allow: ManifestCli['allow'],
  args: string[],
): ManifestCli['allow'][number] | null {
  let best: ManifestCli['allow'][number] | null = null;
  for (const rule of allow) {
    if (rule.args.length > args.length) continue;
    if (
      rule.args.every((word, i) => args[i] === word) &&
      (!best || rule.args.length > best.args.length)
    ) {
      best = rule;
    }
  }
  return best;
}

/** Kiểm tham số trước khi chạy; trả lỗi đọc được hoặc null. */
export function validateArgs(args: unknown, denyFlags: string[]): string | null {
  if (!Array.isArray(args) || args.length === 0) return 'Thiếu tham số.';
  if (args.length > MAX_ARGS) return `Quá ${MAX_ARGS} tham số.`;
  for (const a of args) {
    if (typeof a !== 'string') return 'Mọi tham số phải là chuỗi.';
    if (a.length > MAX_ARG_CHARS) return 'Một tham số dài quá mức.';
    if (a.includes('\0')) return 'Tham số có ký tự NUL.';
    const name = a.startsWith('-') ? (a.split('=')[0] ?? a) : '';
    if (name && denyFlags.includes(name)) return `Tham số "${name}" bị cấm.`;
  }
  return null;
}

export function runCli(
  resolved: ResolvedCommand,
  args: string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      resolved.file,
      [...resolved.prefixArgs, ...args],
      {
        timeout: options.timeoutMs,
        maxBuffer: MAX_OUTPUT * 4,
        windowsHide: true,
        shell: false,
        cwd: tmpdir(),
        env: options.env ?? minimalEnv(),
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        const cut = (s: string): string =>
          s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n…(đã cắt bớt)` : s;
        if (!err) return resolve({ code: 0, stdout: cut(stdout), stderr: cut(stderr) });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        if (e.killed) {
          return resolve({
            code: null,
            stdout: cut(stdout),
            stderr: cut(stderr),
            error: 'Hết giờ chờ chương trình.',
          });
        }
        if (typeof e.code === 'number')
          return resolve({ code: e.code, stdout: cut(stdout), stderr: cut(stderr) });
        resolve({ code: null, stdout: '', stderr: '', error: `Không chạy được: ${e.message}` });
      },
    );
  });
}
