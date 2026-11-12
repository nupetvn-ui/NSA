import {
  runCommand,
  runJsonLinesProcess,
  type AgentAdapter,
  type DetectResult,
  type RunOptions,
} from '@nsa/adapter-sdk';
import { createClaudeParser } from './parser.js';

export interface ClaudeAdapterOptions {
  /** Lệnh gọi Claude CLI, mặc định `claude` (tìm trong PATH). */
  command?: string;
}

// Bắt đầu bằng chữ/số để không bao giờ bị hiểu thành cờ dòng lệnh (--xxx).
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

/** Dựng tham số dòng lệnh — tách riêng để test. Prompt KHÔNG nằm ở đây mà đi qua stdin. */
export function buildClaudeArgs(options: Pick<RunOptions, 'sessionId' | 'permission'>): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    // read-only: chế độ lập kế hoạch, không sửa gì; edit: tự chấp nhận sửa file.
    options.permission === 'edit' ? 'acceptEdits' : 'plan',
  ];
  if (options.sessionId) {
    if (!SESSION_ID.test(options.sessionId)) throw new Error('Mã phiên Claude không hợp lệ');
    args.push('--resume', options.sessionId);
  }
  return args;
}

/** Đọc kết quả `claude auth status` (JSON có trường loggedIn). */
function parseLoggedIn(stdout: string): boolean {
  try {
    return (JSON.parse(stdout) as { loggedIn?: boolean }).loggedIn === true;
  } catch {
    return false;
  }
}

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): AgentAdapter {
  const command = options.command ?? 'claude';

  return {
    id: 'claude',
    displayName: 'Claude Code',

    async detect(): Promise<DetectResult> {
      const version = await runCommand(command, ['--version']);
      if (!version || version.code !== 0) {
        return {
          installed: false,
          ready: false,
          note: 'Chưa cài Claude CLI. Cài bằng: npm install -g @anthropic-ai/claude-code',
        };
      }
      const versionText = version.stdout.trim().split(/\s+/)[0] ?? '';
      const auth = await runCommand(command, ['auth', 'status']);
      const loggedIn = parseLoggedIn(auth?.stdout ?? '');
      return {
        installed: true,
        version: versionText,
        ready: loggedIn,
        ...(loggedIn ? {} : { note: 'Chưa đăng nhập. Mở terminal và chạy: claude auth login' }),
      };
    },

    capabilities() {
      return { streaming: true, resume: true, tools: true, images: false, mcp: true };
    },

    run(runOptions, onEvent) {
      return runJsonLinesProcess(
        {
          command,
          args: buildClaudeArgs(runOptions),
          cwd: runOptions.cwd,
          stdin: runOptions.prompt,
          parseLine: createClaudeParser(),
          onExit: ({ code, stderr, sawError }) =>
            code !== 0 && !sawError
              ? [{ type: 'error', message: stderr.trim() || `Claude CLI thoát với mã ${code}` }]
              : [],
        },
        onEvent,
      );
    },
  };
}
