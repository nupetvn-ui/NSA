import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import crossSpawn from 'cross-spawn';
import type { AgentRun } from './adapter.js';
import type { AgentEvent } from './events.js';

export interface JsonLinesProcessOptions {
  command: string;
  /** Tham số cố định do adapter đặt — KHÔNG đưa nội dung người dùng gõ vào đây. */
  args: string[];
  cwd: string;
  /** Nội dung gửi qua stdin (prompt của người dùng đi đường này để không bị shell diễn giải). */
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  /** Chuyển một dòng JSON của CLI thành các sự kiện chuẩn. */
  parseLine: (json: unknown) => AgentEvent[];
  /** Sự kiện thêm vào khi CLI kết thúc (ví dụ thông báo lỗi dễ hiểu). */
  onExit?: (info: { code: number | null; stderr: string; sawError: boolean }) => AgentEvent[];
}

const STDERR_LIMIT = 8_000;

/**
 * Chạy một CLI xuất JSON từng dòng, chuyển mỗi dòng thành sự kiện chuẩn và đảm bảo
 * luôn kết thúc bằng đúng một sự kiện `done`.
 * Dùng cross-spawn để chạy được cả shim `.cmd` của npm trên Windows.
 */
export function runJsonLinesProcess(
  options: JsonLinesProcessOptions,
  onEvent: (event: AgentEvent) => void,
): AgentRun {
  let cancelled = false;
  let finished = false;
  let sawError = false;
  let stderr = '';

  const emit = (event: AgentEvent): void => {
    if (finished) return;
    if (event.type === 'error') sawError = true;
    onEvent(event);
  };

  let child: ChildProcess;
  try {
    child = crossSpawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    emit({ type: 'error', message: `Không chạy được ${options.command}: ${String(err)}` });
    emit({ type: 'done', cancelled: false });
    finished = true;
    return { cancel: () => undefined, finished: Promise.resolve() };
  }

  const done = new Promise<void>((resolve) => {
    const finish = (code: number | null): void => {
      if (finished) return;
      if (!cancelled) {
        for (const event of options.onExit?.({ code, stderr, sawError }) ?? []) emit(event);
      }
      emit({ type: 'done', cancelled });
      finished = true;
      resolve();
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      const message =
        err.code === 'ENOENT'
          ? `Không tìm thấy lệnh "${options.command}". Hãy cài CLI và đảm bảo nó có trong PATH.`
          : `Lỗi khi chạy ${options.command}: ${err.message}`;
      emit({ type: 'error', message });
      finish(null);
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
    });

    if (child.stdout) {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) return;
        let json: unknown;
        try {
          json = JSON.parse(trimmed);
        } catch {
          return;
        }
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

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    // CLI chạy qua shim .cmd có tiến trình con; taskkill /T dừng cả cây.
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

/** Rút gọn chuỗi dài để hiển thị (giữ đầu và cuối). */
export function truncate(text: string, max = 4_000): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n… (đã lược ${text.length - max} ký tự) …\n${text.slice(-half)}`;
}
