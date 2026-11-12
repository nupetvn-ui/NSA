import type { ChildProcess } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import {
  killTree,
  probeCli,
  runCommand,
  stripAnsi,
  type AgentAdapter,
  type AgentEvent,
  type AgentRun,
  type DetectResult,
  type RunOptions,
} from '@nsa/adapter-sdk';

/**
 * Hồ sơ chạy một CLI ở tầng cuối (nguyên tắc 3 của PLAN.md) — không cần CLI nói JSON.
 *
 * Hai cách đưa prompt vào:
 * - `stdin`: chạy chế độ "in một lần" của CLI (`claude -p`, `codex exec`, `opencode run`…),
 *   gửi prompt qua stdin rồi đóng, đọc văn bản thô ở stdout. Ổn định, không cần terminal giả.
 * - `type`: mở terminal giả (ConPTY trên Windows) và GÕ prompt vào như người dùng, đọc màn hình.
 *   Dùng cho CLI không có chế độ in. Lượt kết thúc khi màn hình khớp `doneWhen`,
 *   khi im lặng `idleMs`, hoặc khi CLI thoát. Dễ vỡ nhất — chỉ là lưới an toàn.
 */
export interface PtyProfile {
  id: string;
  displayName: string;
  /** Lệnh gọi CLI. */
  command: string;
  /** Tham số chèn trước (dùng cho CLI giả trong test). */
  prefixArgs?: string[];
  /** Tham số của CLI — prompt KHÔNG được nằm ở đây. */
  args: (options: RunOptions) => string[];
  input: 'stdin' | 'type';
  /** Chế độ `type`: biểu thức nhận ra CLI đã trả lời xong (áp vào văn bản sau khi gõ). */
  doneWhen?: RegExp;
  /** Chế độ `type`: im lặng bao lâu thì coi là xong (mặc định 8 giây). */
  idleMs?: number;
  /** Chế độ `type`: thời gian chờ CLI khởi động trước khi gõ (mặc định 1,5 giây). */
  startupMs?: number;
  env?: Record<string, string>;
  /** Có sửa được file khi quyền là `edit` không (tuỳ CLI). */
  editFiles?: boolean;
  installHint?: string;
}

export function createPtyAdapter(profile: PtyProfile): AgentAdapter {
  const prefix = profile.prefixArgs ?? [];
  return {
    id: profile.id,
    displayName: profile.displayName,

    async detect(): Promise<DetectResult> {
      const out = await runCommand(profile.command, [...prefix, '--version']);
      if (!out || out.code !== 0) {
        return {
          installed: false,
          ready: false,
          note: profile.installHint ?? `Không tìm thấy lệnh "${profile.command}".`,
        };
      }
      const version = stripAnsi(out.stdout)
        .trim()
        .split(/\s+/)
        .find((w) => /\d/.test(w));
      return { installed: true, ready: true, ...(version ? { version } : {}) };
    },

    capabilities() {
      return {
        streaming: true,
        resume: false,
        tools: true,
        editFiles: profile.editFiles ?? false,
        images: false,
        mcp: false,
        subagents: false,
        toolGate: false,
        tier: 'pty',
      };
    },

    fingerprint: () => probeCli(profile.command, { prefixArgs: prefix }),

    run(options, onEvent) {
      const args = [...prefix, ...profile.args(options)];
      return profile.input === 'stdin'
        ? runPlain(profile, args, options, onEvent)
        : runTyped(profile, args, options, onEvent);
    },
  };
}

/** Bộ ghép văn bản thô thành sự kiện `text`, bỏ mã màu, chuẩn hoá xuống dòng. */
function textStream(onEvent: (e: AgentEvent) => void) {
  let total = '';
  return {
    push(chunk: string) {
      const clean = stripAnsi(chunk).replace(/\r\n?/g, '\n');
      if (!clean) return;
      total += clean;
      onEvent({ type: 'text', id: 'pty', text: clean });
    },
    get total() {
      return total;
    },
  };
}

function runPlain(
  profile: PtyProfile,
  args: string[],
  options: RunOptions,
  onEvent: (e: AgentEvent) => void,
): AgentRun {
  let finished = false;
  let cancelled = false;
  let stderr = '';
  const emit = (e: AgentEvent): void => {
    if (!finished) onEvent(e);
  };
  const text = textStream(emit);
  let child: ChildProcess;
  try {
    child = crossSpawn(profile.command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...profile.env, NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    emit({
      type: 'error',
      code: 'cli',
      message: `Không chạy được ${profile.displayName}: ${String(err)}`,
    });
    emit({ type: 'done', cancelled: false });
    return { cancel: () => undefined, finished: Promise.resolve() };
  }
  const finishedPromise = new Promise<void>((resolve) => {
    const finish = (code: number | null, spawnError?: NodeJS.ErrnoException): void => {
      if (finished) return;
      if (!cancelled) {
        if (spawnError?.code === 'ENOENT') {
          emit({
            type: 'error',
            code: 'not_installed',
            message: profile.installHint ?? `Không tìm thấy lệnh "${profile.command}".`,
          });
        } else if (spawnError) {
          emit({ type: 'error', code: 'cli', message: spawnError.message });
        } else if (code !== 0) {
          const tail = stderr.trim().split(/\r?\n/).slice(-6).join('\n');
          emit({
            type: 'error',
            code: 'cli',
            message: `${profile.displayName} (tầng văn bản thô) thoát với mã ${String(code)}${tail ? `:\n${tail}` : ''}`,
          });
        } else if (!text.total.trim()) {
          emit({
            type: 'error',
            code: 'protocol',
            message: `${profile.displayName} không in gì ra.`,
          });
        }
      }
      emit({ type: 'done', cancelled });
      finished = true;
      resolve();
    };
    child.on('error', (err: NodeJS.ErrnoException) => finish(null, err));
    child.stdout?.setEncoding('utf8').on('data', (c: string) => text.push(c));
    child.stderr?.setEncoding('utf8').on('data', (c: string) => {
      stderr = (stderr + c).slice(-8_000);
    });
    child.on('close', (code) => finish(code));
  });
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(options.prompt);
  return {
    cancel() {
      if (finished || cancelled) return;
      cancelled = true;
      killTree(child);
    },
    finished: finishedPromise,
  };
}

/** Giao diện tối thiểu của node-pty mà NSA dùng. */
interface PtyProcess {
  pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  kill(): void;
}
interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: { cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv; name?: string },
  ): PtyProcess;
}

let ptyModule: Promise<PtyModule | null> | null = null;

/** Nạp node-pty khi cần (module native, có thể thiếu trên một số máy). */
export function loadPty(): Promise<PtyModule | null> {
  ptyModule ??= import('@lydell/node-pty').then(
    (m) => (m as { default?: PtyModule }).default ?? (m as unknown as PtyModule),
    () => null,
  );
  return ptyModule;
}

function runTyped(
  profile: PtyProfile,
  args: string[],
  options: RunOptions,
  onEvent: (e: AgentEvent) => void,
): AgentRun {
  let finished = false;
  let cancelled = false;
  let term: PtyProcess | null = null;
  let resolveDone: () => void = () => undefined;
  const finishedPromise = new Promise<void>((r) => (resolveDone = r));
  const emit = (e: AgentEvent): void => {
    if (!finished) onEvent(e);
  };
  const text = textStream(emit);
  let idle: NodeJS.Timeout | undefined;
  let typed = false;
  let afterTyping = '';

  const finish = (error?: AgentEvent): void => {
    if (finished) return;
    clearTimeout(idle);
    if (error && !cancelled) emit(error);
    emit({ type: 'done', cancelled });
    finished = true;
    if (term) {
      try {
        term.kill();
      } catch {
        // đã thoát
      }
    }
    resolveDone();
  };

  void loadPty().then((pty) => {
    if (cancelled) return finish();
    if (!pty) {
      return finish({
        type: 'error',
        code: 'not_installed',
        message: 'Thiếu thành phần terminal giả (node-pty) nên không chạy được tầng PTY.',
      });
    }
    // Trên Windows, shim .cmd của npm phải chạy qua cmd.exe. Tham số do adapter đặt, không chứa prompt.
    const [file, fileArgs] =
      process.platform === 'win32' && !/\.exe$/i.test(profile.command)
        ? ['cmd.exe', ['/d', '/c', profile.command, ...args]]
        : [profile.command, args];
    try {
      term = pty.spawn(file, fileArgs, {
        cols: 120,
        rows: 40,
        cwd: options.cwd,
        env: { ...process.env, ...profile.env },
        name: 'xterm-256color',
      });
    } catch (err) {
      return finish({
        type: 'error',
        code: 'cli',
        message: `Không mở được terminal giả: ${String(err)}`,
      });
    }
    const idleMs = profile.idleMs ?? 8_000;
    const armIdle = (): void => {
      clearTimeout(idle);
      if (typed && afterTyping.trim()) idle = setTimeout(() => finish(), idleMs);
    };
    term.onData((data) => {
      if (!typed) return; // bỏ màn hình chào trước khi gõ
      text.push(data);
      afterTyping += stripAnsi(data);
      if (profile.doneWhen?.test(afterTyping)) return finish();
      armIdle();
    });
    term.onExit(({ exitCode }) =>
      finish(
        exitCode !== 0 && !afterTyping.trim()
          ? {
              type: 'error',
              code: 'cli',
              message: `${profile.displayName} thoát với mã ${exitCode}`,
            }
          : undefined,
      ),
    );
    setTimeout(() => {
      if (finished || !term) return;
      typed = true;
      // Dán kiểu "bracketed paste" để prompt nhiều dòng không bị gửi từng dòng, rồi Enter.
      term.write(`\u001b[200~${options.prompt}\u001b[201~`);
      setTimeout(() => term?.write('\r'), 150);
      idle = setTimeout(() => finish(), Math.max(idleMs * 4, 30_000));
    }, profile.startupMs ?? 1_500);
  });

  return {
    cancel() {
      if (finished || cancelled) return;
      cancelled = true;
      if (term) finish();
    },
    finished: finishedPromise,
  };
}
