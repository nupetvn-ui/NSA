import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import crossSpawn from 'cross-spawn';
import type { AgentRun, CliFingerprint } from './adapter.js';
import type { AgentEvent } from './events.js';

export interface ExitInfo {
  code: number | null;
  stderr: string;
  sawError: boolean;
  /** Số dòng JSON đọc được — bằng 0 nghĩa là CLI không nói đúng giao thức. */
  jsonLines: number;
}

export interface JsonLinesProcessOptions {
  command: string;
  /** Tham số cố định do adapter đặt — KHÔNG đưa nội dung người dùng gõ vào đây. */
  args: string[];
  cwd: string;
  /** Nội dung gửi qua stdin (prompt của người dùng đi đường này để không bị shell diễn giải). */
  stdin?: string;
  /** Biến môi trường thêm vào (gộp với môi trường của NSA). */
  env?: NodeJS.ProcessEnv;
  /** Chuyển một dòng JSON của CLI thành các sự kiện chuẩn. */
  parseLine: (json: unknown) => AgentEvent[];
  /** Sự kiện thêm vào khi CLI kết thúc (ví dụ thông báo lỗi dễ hiểu). */
  onExit?: (info: ExitInfo) => AgentEvent[];
  /** Tên hiển thị của CLI trong thông báo lỗi. */
  label?: string;
}

const STDERR_LIMIT = 8_000;
const STDOUT_SAMPLE = 2_000;

/**
 * Chạy một CLI xuất JSON từng dòng, chuyển mỗi dòng thành sự kiện chuẩn và đảm bảo
 * luôn kết thúc bằng đúng một sự kiện `done`.
 * Dùng cross-spawn để chạy được cả shim `.cmd` của npm trên Windows.
 *
 * CLI kết thúc mà không có dòng JSON nào (và adapter chưa báo lỗi) thì phát lỗi `protocol`
 * — dấu hiệu CLI vừa đổi cờ / định dạng; lõi dựa vào đó để lùi xuống tầng dưới.
 */
export function runJsonLinesProcess(
  options: JsonLinesProcessOptions,
  onEvent: (event: AgentEvent) => void,
): AgentRun {
  let cancelled = false;
  let finished = false;
  let sawError = false;
  let stderr = '';
  let jsonLines = 0;
  let stdoutSample = '';
  const label = options.label ?? options.command;

  const emit = (event: AgentEvent): void => {
    if (finished) return;
    if (event.type === 'error') sawError = true;
    onEvent(event);
  };

  let child: ChildProcess;
  try {
    child = crossSpawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    emit({ type: 'error', code: 'cli', message: `Không chạy được ${label}: ${String(err)}` });
    emit({ type: 'done', cancelled: false });
    finished = true;
    return { cancel: () => undefined, finished: Promise.resolve() };
  }

  const done = new Promise<void>((resolve) => {
    const finish = (code: number | null): void => {
      if (finished) return;
      if (!cancelled) {
        for (const event of options.onExit?.({ code, stderr, sawError, jsonLines }) ?? []) {
          emit(event);
        }
        if (jsonLines === 0 && !sawError) {
          const detail = [stderr.trim(), stdoutSample.trim()].filter(Boolean).join('\n');
          emit({
            type: 'error',
            code: 'protocol',
            message:
              `Không đọc được đầu ra của ${label} (mã thoát ${String(code)}). ` +
              `CLI có thể vừa đổi định dạng hoặc cờ dòng lệnh.` +
              (detail ? `\n${truncate(detail, 1_500)}` : ''),
          });
        }
      }
      emit({ type: 'done', cancelled });
      finished = true;
      resolve();
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        emit({
          type: 'error',
          code: 'not_installed',
          message: `Không tìm thấy lệnh "${options.command}". Hãy cài CLI và đảm bảo nó có trong PATH.`,
        });
      } else {
        emit({ type: 'error', code: 'cli', message: `Lỗi khi chạy ${label}: ${err.message}` });
      }
      finish(null);
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
    });

    if (child.stdout) {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => {
        const json = parseJsonLine(line);
        if (json === undefined) {
          if (stdoutSample.length < STDOUT_SAMPLE) stdoutSample += `${line}\n`;
          return;
        }
        jsonLines++;
        for (const event of options.parseLine(json)) emit(event);
      });
      // Chờ đọc hết stdout rồi mới kết thúc, để không mất dòng cuối.
      child.on('close', (code) => {
        lines.close();
        finish(code);
      });
    } else {
      child.on('close', (code) => finish(code));
    }
  });

  child.stdin?.on('error', () => undefined);
  child.stdin?.end(options.stdin ?? '');

  return {
    cancel() {
      if (finished || cancelled) return;
      cancelled = true;
      killTree(child);
    },
    finished: done,
  };
}

function parseJsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** Dừng cả cây tiến trình (CLI chạy qua shim .cmd có tiến trình con). */
export function killTree(child: Pick<ChildProcess, 'pid' | 'kill'>): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on(
      'error',
      () => child.kill(),
    );
  } else {
    child.kill('SIGTERM');
  }
}

export interface CommandOutput {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Chạy một lệnh ngắn (ví dụ `--version`) và lấy toàn bộ đầu ra, có giới hạn thời gian. */
export function runCommand(
  command: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<CommandOutput | null> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child: ChildProcess;
    try {
      child = crossSpawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => killTree(child), timeoutMs);
    child.stdout?.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr?.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Lấy phiên bản + `--help` của một CLI để so giữa các lần khởi động.
 * Bỏ mã màu ANSI và chuẩn hoá xuống dòng để so cho đúng.
 */
export async function probeCli(
  command: string,
  options: { versionArgs?: string[]; helpArgs?: string[]; prefixArgs?: string[] } = {},
): Promise<CliFingerprint> {
  const prefix = options.prefixArgs ?? [];
  const [version, help] = await Promise.all([
    runCommand(command, [...prefix, ...(options.versionArgs ?? ['--version'])]),
    runCommand(command, [...prefix, ...(options.helpArgs ?? ['--help'])]),
  ]);
  const clean = (out: CommandOutput | null): string | null => {
    if (!out || out.code === null) return null;
    const text = stripAnsi(`${out.stdout}${out.stdout.trim() ? '' : out.stderr}`)
      .replace(/\r\n?/g, '\n')
      .trim();
    return text || null;
  };
  return { version: clean(version), help: clean(help) };
}

/** Bỏ mã điều khiển terminal (màu, di chuyển con trỏ, tiêu đề cửa sổ). */
export function stripAnsi(text: string): string {
  return (
    text
      // OSC: ESC ] … BEL hoặc ESC \
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
      // CSI: ESC [ … chữ cái
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
      // Các mã ESC còn lại (2 ký tự)
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b[@-Z\\-_]/g, '')
  );
}

/** Rút gọn chuỗi dài để hiển thị (giữ đầu và cuối). */
export function truncate(text: string, max = 4_000): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n… (đã lược ${text.length - max} ký tự) …\n${text.slice(-half)}`;
}
