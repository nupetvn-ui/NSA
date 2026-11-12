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
import { createAntigravityParser } from './parser.js';

export type AntigravityAdapterOptions = CliAdapterOptions;

const INSTALL =
  'Chưa cài Antigravity CLI (agy). Cài theo hướng dẫn tại antigravity.google/docs/cli, ' +
  'rồi chạy "agy" một lần để đăng nhập.';
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

/**
 * Tham số dòng lệnh theo tài liệu chính thức. Prompt đi qua stdin ở dạng
 * `--input-format stream-json` (một dòng JSON mỗi lượt) để không nằm trong tham số.
 * Quyền: `--mode plan` = chỉ lập kế hoạch, `--mode accept-edits` = tự duyệt sửa file.
 * Không dùng `--dangerously-skip-permissions`: hành động cần duyệt sẽ bị từ chối mềm.
 */
export function buildAntigravityArgs(
  options: Pick<RunOptions, 'sessionId' | 'permission'>,
): string[] {
  const args = [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--mode',
    options.permission === 'edit' ? 'accept-edits' : 'plan',
  ];
  if (options.sessionId) {
    if (!CONVERSATION_ID.test(options.sessionId))
      throw new Error('Mã hội thoại Antigravity không hợp lệ');
    args.push('--conversation', options.sessionId);
  }
  return args;
}

/** Một lượt người dùng ở dạng stream-json đầu vào của agy. */
export function antigravityInput(prompt: string): string {
  return `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`;
}

export function createAntigravityAdapter(options: AntigravityAdapterOptions = {}): AgentAdapter {
  const command = options.command ?? 'agy';
  const prefix = options.prefixArgs ?? [];

  const fallback = createPtyAdapter({
    id: 'antigravity',
    displayName: 'Antigravity',
    command,
    prefixArgs: prefix,
    input: 'stdin',
    editFiles: true,
    installHint: INSTALL,
    args: (o) => ['--print', '--mode', o.permission === 'edit' ? 'accept-edits' : 'plan'],
  });

  return {
    id: 'antigravity',
    displayName: 'Antigravity',
    fallback,

    async detect(): Promise<DetectResult> {
      const version = await runCommand(command, [...prefix, '--version']);
      if (!version || version.code !== 0) return { installed: false, ready: false, note: INSTALL };
      return {
        installed: true,
        version: version.stdout.trim().split(/\s+/).pop() ?? '',
        ready: true,
        note: 'Adapter Antigravity viết theo tài liệu, chưa được chạy thật.',
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
        toolGate: false,
        tier: 'headless',
      };
    },

    fingerprint: () => probeCli(command, { prefixArgs: prefix }),

    run(runOptions, onEvent) {
      return runJsonLinesProcess(
        {
          command,
          label: 'Antigravity',
          args: [...prefix, ...buildAntigravityArgs(runOptions)],
          cwd: runOptions.cwd,
          stdin: antigravityInput(runOptions.prompt),
          parseLine: createAntigravityParser(),
          onExit: ({ code, stderr, sawError }) => {
            if (sawError) return [];
            if (/authentication required/i.test(stderr)) {
              return [
                {
                  type: 'error',
                  code: 'auth',
                  message:
                    'Antigravity chưa đăng nhập. Mở terminal, chạy "agy" một lần để đăng nhập.',
                },
              ];
            }
            return code !== 0
              ? [
                  {
                    type: 'error',
                    code: 'cli',
                    message: stderr.trim() || `agy thoát với mã ${String(code)}`,
                  },
                ]
              : [];
          },
        },
        onEvent,
      );
    },
  };
}
