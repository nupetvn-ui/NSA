import {
  fileUrl,
  gateEnv,
  gateHookFiles,
  mcpEnv,
  openCodeMcpConfig,
  probeCli,
  runCommand,
  runJsonLinesProcess,
  type AgentAdapter,
  type CliAdapterOptions,
  type DetectResult,
  type McpServerSpec,
  type RunOptions,
} from '@nsa/adapter-sdk';
import { createPtyAdapter } from '@nsa/adapter-pty';
import { createOpenCodeParser } from './parser.js';

export interface OpenCodeAdapterOptions extends CliAdapterOptions {
  /** Model dạng `provider/model`; bỏ trống thì dùng mặc định trong cấu hình của người dùng. */
  model?: string;
}

// opencode dùng mã phiên dạng `ses_…`. Bắt đầu bằng chữ/số để không bị hiểu thành cờ.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const MODEL = /^[A-Za-z0-9][\w.:/-]{0,127}$/;
const INSTALL = 'Chưa cài OpenCode CLI. Cài bằng: npm install -g opencode-ai';

/**
 * Tham số dòng lệnh. Prompt đi qua stdin (opencode run đọc stdin khi không phải terminal —
 * đã thử thật với opencode 1.19.5).
 * Quyền: `plan` là agent có sẵn chỉ đọc (từ chối sửa file — đã thử thật), `build` được sửa.
 */
export function buildOpenCodeArgs(
  options: Pick<RunOptions, 'sessionId' | 'permission'>,
  model?: string,
): string[] {
  const args = [
    'run',
    '--format',
    'json',
    '--agent',
    options.permission === 'edit' ? 'build' : 'plan',
  ];
  if (model) {
    if (!MODEL.test(model)) throw new Error('Tên model OpenCode không hợp lệ');
    args.push('-m', model);
  }
  if (options.sessionId) {
    if (!SESSION_ID.test(options.sessionId)) throw new Error('Mã phiên OpenCode không hợp lệ');
    args.push('-s', options.sessionId);
  }
  return args;
}

/**
 * Cấu hình bổ sung qua OPENCODE_CONFIG_CONTENT: nạp plugin cổng chính sách của NSA.
 * Gộp với giá trị người dùng đã đặt (nếu có) thay vì ghi đè.
 */
export function openCodeGateConfig(
  pluginPath: string | undefined,
  existing?: string,
  mcpServers: McpServerSpec[] = [],
): string {
  let base: Record<string, unknown> = {};
  try {
    if (existing) base = JSON.parse(existing) as Record<string, unknown>;
  } catch {
    base = {};
  }
  const result: Record<string, unknown> = { ...base };
  if (pluginPath) {
    const plugins = Array.isArray(base['plugin']) ? (base['plugin'] as unknown[]) : [];
    result['plugin'] = [...plugins, fileUrl(pluginPath)];
  }
  if (mcpServers.length) {
    const mcp =
      typeof base['mcp'] === 'object' && base['mcp'] !== null
        ? (base['mcp'] as Record<string, unknown>)
        : {};
    result['mcp'] = { ...mcp, ...openCodeMcpConfig(mcpServers) };
  }
  return JSON.stringify(result);
}

export function createOpenCodeAdapter(options: OpenCodeAdapterOptions = {}): AgentAdapter {
  const command = options.command ?? 'opencode';
  const prefix = options.prefixArgs ?? [];

  const fallback = createPtyAdapter({
    id: 'opencode',
    displayName: 'OpenCode',
    command,
    prefixArgs: prefix,
    input: 'stdin',
    editFiles: true,
    installHint: INSTALL,
    args: (o) => [
      'run',
      '--agent',
      o.permission === 'edit' ? 'build' : 'plan',
      ...(options.model ? ['-m', options.model] : []),
    ],
  });

  return {
    id: 'opencode',
    displayName: 'OpenCode',
    fallback,

    async detect(): Promise<DetectResult> {
      const version = await runCommand(command, [...prefix, '--version']);
      if (!version || version.code !== 0) {
        return { installed: false, ready: false, note: INSTALL };
      }
      const versionText = version.stdout.trim().split(/\s+/).pop() ?? '';
      // OpenCode có model miễn phí (OpenCode Zen) nên dùng được cả khi chưa thêm khoá nào.
      const auth = await runCommand(command, [...prefix, 'auth', 'list']);
      const none = /\b0 credentials\b/i.test(auth?.stdout ?? '');
      return {
        installed: true,
        version: versionText,
        ready: true,
        ...(none
          ? { note: 'Chưa thêm khoá nhà cung cấp — đang dùng model miễn phí của OpenCode Zen.' }
          : {}),
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
        subagents: true,
        toolGate: true,
        tier: 'headless',
      };
    },

    fingerprint: () => probeCli(command, { prefixArgs: prefix, helpArgs: ['run', '--help'] }),

    run(runOptions, onEvent) {
      let env: Record<string, string> | undefined = runOptions.env
        ? { ...runOptions.env }
        : undefined;
      const mcp = runOptions.mcpServers ?? [];
      if (runOptions.gate || mcp.length) {
        env = {
          ...env,
          ...(runOptions.gate ? gateEnv(runOptions.gate) : {}),
          ...mcpEnv(mcp),
          // Gộp với cấu hình của lượt (nhà cung cấp do NSA cấp key) hoặc của người dùng.
          OPENCODE_CONFIG_CONTENT: openCodeGateConfig(
            runOptions.gate ? gateHookFiles().opencodePlugin : undefined,
            runOptions.env?.['OPENCODE_CONFIG_CONTENT'] ?? process.env['OPENCODE_CONFIG_CONTENT'],
            mcp,
          ),
        };
      }
      return runJsonLinesProcess(
        {
          command,
          label: 'OpenCode',
          args: [...prefix, ...buildOpenCodeArgs(runOptions, options.model)],
          cwd: runOptions.cwd,
          stdin: runOptions.prompt,
          ...(env ? { env } : {}),
          parseLine: createOpenCodeParser(),
          onExit: ({ code, stderr, sawError, jsonLines }) =>
            code !== 0 && !sawError && jsonLines > 0
              ? [
                  {
                    type: 'error',
                    code: 'cli',
                    message: stderr.trim() || `OpenCode thoát với mã ${String(code)}`,
                  },
                ]
              : [],
        },
        onEvent,
      );
    },
  };
}
