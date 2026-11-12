import {
  probeCli,
  runCommand,
  runJsonLinesProcess,
  type AgentAdapter,
  type CliAdapterOptions,
  type DetectResult,
  type RunOptions,
} from '@nsa/adapter-sdk';
import { createPtyAdapter } from '@nsa/adapter-pty';
import { createCodexParser } from './parser.js';

export interface CodexAdapterOptions extends CliAdapterOptions {
  /** Model cho lượt chạy (`-c model="…"`); bỏ trống thì dùng cấu hình của người dùng. */
  model?: string;
}

const MODEL = /^[A-Za-z0-9][\w.:/-]{0,127}$/;

const INSTALL = 'Chưa cài Codex CLI. Cài bằng: npm install -g @openai/codex';

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
  const prefix = options.prefixArgs ?? [];
  if (options.model && !MODEL.test(options.model)) throw new Error('Tên model Codex không hợp lệ');
  // `-c` là cờ chung của codex (đặt trước lệnh con), giống `-c sandbox_mode` đã chạy thật.
  const modelArgs = options.model ? ['-c', `model="${options.model}"`] : [];

  // Tầng lùi: `codex exec` không có --json, đọc văn bản thô; prompt vẫn qua stdin.
  const fallback = createPtyAdapter({
    id: 'codex',
    displayName: 'Codex',
    command,
    prefixArgs: prefix,
    input: 'stdin',
    editFiles: true,
    installHint: INSTALL,
    args: (o) => [
      'exec',
      '--skip-git-repo-check',
      '-c',
      `sandbox_mode="${o.permission === 'edit' ? 'workspace-write' : 'read-only'}"`,
      '-',
    ],
  });

  return {
    id: 'codex',
    displayName: 'Codex',
    fallback,

    async detect(): Promise<DetectResult> {
      const version = await runCommand(command, [...prefix, '--version']);
      if (!version || version.code !== 0) {
        return { installed: false, ready: false, note: INSTALL };
      }
      const versionText = version.stdout.trim().split(/\s+/).pop() ?? '';
      const status = await runCommand(command, [...prefix, 'login', 'status']);
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
      return {
        streaming: false,
        resume: true,
        tools: true,
        editFiles: true,
        images: true,
        mcp: true,
        subagents: false,
        // Móc PreToolUse của Codex chỉ chạy khi người dùng đã "tin" móc đó (đã thử thật:
        // móc truyền qua -c bị bỏ qua im lặng). Xem ADR-0007.
        toolGate: false,
        tier: 'headless',
      };
    },

    fingerprint: () => probeCli(command, { prefixArgs: prefix, helpArgs: ['exec', '--help'] }),

    run(runOptions, onEvent) {
      return runJsonLinesProcess(
        {
          command,
          label: 'Codex',
          args: [...prefix, ...modelArgs, ...buildCodexArgs(runOptions)],
          cwd: runOptions.cwd,
          stdin: runOptions.prompt,
          ...(runOptions.env ? { env: runOptions.env } : {}),
          parseLine: createCodexParser(),
          onExit: ({ code, stderr, sawError, jsonLines }) =>
            code !== 0 && !sawError && jsonLines > 0
              ? [
                  {
                    type: 'error',
                    code: 'cli',
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
