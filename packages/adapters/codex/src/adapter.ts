import {
  runCommand,
  runJsonLinesProcess,
  type AgentAdapter,
  type DetectResult,
  type RunOptions,
} from '@nsa/adapter-sdk';
import { createCodexParser } from './parser.js';

export interface CodexAdapterOptions {
  /** Lệnh gọi Codex CLI, mặc định `codex` (tìm trong PATH). */
  command?: string;
}

// Bắt đầu bằng chữ/số để không bao giờ bị hiểu thành cờ dòng lệnh (--xxx).
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

/** Dựng tham số dòng lệnh — tách riêng để test. Prompt đi qua stdin (tham số `-`). */
export function buildCodexArgs(options: Pick<RunOptions, 'sessionId' | 'permission'>): string[] {
  const sandbox = options.permission === 'edit' ? 'workspace-write' : 'read-only';
  const common = ['--json', '--skip-git-repo-check', '-c', `sandbox_mode="${sandbox}"`];
  if (options.sessionId) {
    if (!SESSION_ID.test(options.sessionId)) throw new Error('Mã phiên Codex không hợp lệ');
    return ['exec', 'resume', ...common, options.sessionId, '-'];
  }
  return ['exec', ...common, '-'];
}

export function createCodexAdapter(options: CodexAdapterOptions = {}): AgentAdapter {
  const command = options.command ?? 'codex';

  return {
    id: 'codex',
    displayName: 'Codex',

    async detect(): Promise<DetectResult> {
      const version = await runCommand(command, ['--version']);
      if (!version || version.code !== 0) {
        return {
          installed: false,
          ready: false,
          note: 'Chưa cài Codex CLI. Cài bằng: npm install -g @openai/codex',
        };
      }
      const versionText = version.stdout.trim().split(/\s+/).pop() ?? '';
      const status = await runCommand(command, ['login', 'status']);
      const text = `${status?.stdout ?? ''}${status?.stderr ?? ''}`;
      const loggedIn =
        status?.code === 0 && /logged in/i.test(text) && !/not logged in/i.test(text);
      return {
        installed: true,
        version: versionText,
        ready: loggedIn,
        ...(loggedIn ? {} : { note: 'Chưa đăng nhập. Mở terminal và chạy: codex login' }),
      };
    },

    capabilities() {
      return { streaming: false, resume: true, tools: true, images: true, mcp: true };
    },

    run(runOptions, onEvent) {
      return runJsonLinesProcess(
        {
          command,
          args: buildCodexArgs(runOptions),
          cwd: runOptions.cwd,
          stdin: runOptions.prompt,
          parseLine: createCodexParser(),
          onExit: ({ code, stderr, sawError }) =>
            code !== 0 && !sawError
              ? [
                  {
                    type: 'error',
                    message: lastErrorLine(stderr) || `Codex CLI thoát với mã ${code}`,
                  },
                ]
              : [],
        },
        onEvent,
      );
    },
  };
}

/** Codex in nhiều log ra stderr; lấy dòng lỗi cuối cùng cho dễ đọc. */
function lastErrorLine(stderr: string): string {
  const lines = stderr.trim().split(/\r?\n/).filter(Boolean);
  return [...lines].reverse().find((l) => /error/i.test(l)) ?? lines.at(-1) ?? '';
}
