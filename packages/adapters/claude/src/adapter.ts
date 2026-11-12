import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeMcpArgs,
  gateEnv,
  mcpEnv,
  gateHookFiles,
  nodeRuntime,
  probeCli,
  runCommand,
  runJsonLinesProcess,
  shellQuote,
  type AgentAdapter,
  type CliAdapterOptions,
  type DetectResult,
  type RunOptions,
} from '@nsa/adapter-sdk';
import { createPtyAdapter } from '@nsa/adapter-pty';
import { createClaudeParser } from './parser.js';

export type ClaudeAdapterOptions = CliAdapterOptions;

const INSTALL = 'Chưa cài Claude CLI. Cài bằng: npm install -g @anthropic-ai/claude-code';

/**
 * Settings gắn móc PreToolUse của NSA vào mọi công cụ (matcher "*").
 * Đã thử thật với Claude Code 2.1.322: móc trả `permissionDecision: deny` thì lệnh bị chặn
 * và agent nhận lỗi. Móc tự lỗi thì Claude cho lệnh chạy tiếp — nên script móc "lỗi là chặn".
 */
export function claudeGateSettings(hookScript: string): string {
  const runtime = nodeRuntime();
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: `${shellQuote(runtime.command)} ${shellQuote(hookScript)}`,
              timeout: 600,
            },
          ],
        },
      ],
    },
  });
}

function gateSettingsFile(): string {
  const dir = join(tmpdir(), `nsa-gate-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'claude-settings.json');
  writeFileSync(file, claudeGateSettings(gateHookFiles().commandHook), 'utf8');
  return file;
}

// Bắt đầu bằng chữ/số để không bao giờ bị hiểu thành cờ dòng lệnh (--xxx).
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

/** Dựng tham số dòng lệnh — tách riêng để test. Prompt KHÔNG nằm ở đây mà đi qua stdin. */
export function buildClaudeArgs(
  options: Pick<RunOptions, 'sessionId' | 'permission' | 'mcpServers'>,
  settingsFile?: string,
): string[] {
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
  if (settingsFile) args.push('--settings', settingsFile);
  if (options.mcpServers?.length) args.push(...claudeMcpArgs(options.mcpServers));
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
  const prefix = options.prefixArgs ?? [];

  // Tầng lùi: `claude -p` in văn bản thô, prompt vẫn qua stdin.
  const fallback = createPtyAdapter({
    id: 'claude',
    displayName: 'Claude Code',
    command,
    prefixArgs: prefix,
    input: 'stdin',
    editFiles: true,
    installHint: INSTALL,
    args: (o) => ['-p', '--permission-mode', o.permission === 'edit' ? 'acceptEdits' : 'plan'],
  });

  return {
    id: 'claude',
    displayName: 'Claude Code',
    fallback,

    async detect(): Promise<DetectResult> {
      const version = await runCommand(command, [...prefix, '--version']);
      if (!version || version.code !== 0) {
        return { installed: false, ready: false, note: INSTALL };
      }
      const versionText = version.stdout.trim().split(/\s+/)[0] ?? '';
      const auth = await runCommand(command, [...prefix, 'auth', 'status']);
      const loggedIn = parseLoggedIn(auth?.stdout ?? '');
      return {
        installed: true,
        version: versionText,
        ready: loggedIn,
        ...(loggedIn ? {} : { note: 'Chưa đăng nhập. Mở terminal và chạy: claude auth login' }),
      };
    },

    capabilities() {
      return {
        streaming: true,
        resume: true,
        tools: true,
        editFiles: true,
        images: false,
        mcp: true,
        subagents: true,
        toolGate: true,
        tier: 'headless',
      };
    },

    fingerprint: () => probeCli(command, { prefixArgs: prefix }),

    run(runOptions, onEvent) {
      const settings = runOptions.gate ? gateSettingsFile() : undefined;
      const mcp = runOptions.mcpServers ?? [];
      const env =
        runOptions.gate || mcp.length
          ? {
              ...(runOptions.gate ? { ...gateEnv(runOptions.gate), ...nodeRuntime().env } : {}),
              ...mcpEnv(mcp),
            }
          : undefined;
      return runJsonLinesProcess(
        {
          command,
          label: 'Claude Code',
          args: [...prefix, ...buildClaudeArgs(runOptions, settings)],
          cwd: runOptions.cwd,
          stdin: runOptions.prompt,
          ...(env ? { env } : {}),
          parseLine: createClaudeParser(),
          onExit: ({ code, stderr, sawError, jsonLines }) =>
            code !== 0 && !sawError && jsonLines > 0
              ? [
                  {
                    type: 'error',
                    code: 'cli',
                    message: stderr.trim() || `Claude CLI thoát với mã ${String(code)}`,
                  },
                ]
              : [],
        },
        onEvent,
      );
    },
  };
}
