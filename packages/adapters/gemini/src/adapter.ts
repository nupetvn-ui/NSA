import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  probeCli,
  runCommand,
  runJsonLinesProcess,
  type AgentAdapter,
  type AgentEvent,
  type CliAdapterOptions,
  type DetectResult,
  type RunOptions,
} from '@nsa/adapter-sdk';
import { createPtyAdapter } from '@nsa/adapter-pty';
import { createGeminiParser } from './parser.js';

export type GeminiAdapterOptions = CliAdapterOptions;

const INSTALL = 'Chưa cài Gemini CLI. Cài bằng: npm install -g @google/gemini-cli';
const AUTH_HINT =
  'Gemini CLI chưa đăng nhập. Mở terminal, chạy "gemini" để đăng nhập, hoặc đặt biến GEMINI_API_KEY.';
/** Mã thoát khi chưa xác thực — ghi từ gemini-cli 0.68.0 chạy thật trên máy chưa đăng nhập. */
const EXIT_AUTH = 41;
// gemini --resume nhận "latest", số thứ tự hoặc mã phiên (UUID).
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

/**
 * Tham số dòng lệnh. `-p ""` bật chế độ headless; prompt đi qua stdin (Gemini nối stdin
 * với `-p`). `--skip-trust` vì thư mục chưa "tin" thì Gemini tự hạ chế độ duyệt về mặc định
 * (ghi được từ chạy thật). Quyền: `plan` = chỉ đọc, `auto_edit` = tự duyệt sửa file.
 */
export function buildGeminiArgs(options: Pick<RunOptions, 'sessionId' | 'permission'>): string[] {
  const args = [
    '-p',
    '',
    '--output-format',
    'stream-json',
    '--skip-trust',
    '--approval-mode',
    options.permission === 'edit' ? 'auto_edit' : 'plan',
  ];
  if (options.sessionId) {
    if (!SESSION_ID.test(options.sessionId)) throw new Error('Mã phiên Gemini không hợp lệ');
    args.push('--resume', options.sessionId);
  }
  return args;
}

/** Có khoá API trong biến môi trường, hoặc đã đăng nhập Google (file oauth_creds.json). */
export function geminiLooksLoggedIn(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): boolean {
  if (env['GEMINI_API_KEY'] || env['GOOGLE_API_KEY'] || env['GOOGLE_GENAI_USE_VERTEXAI']) {
    return true;
  }
  return existsSync(join(home, '.gemini', 'oauth_creds.json'));
}

/** Hiểu lỗi khi Gemini thoát mà không in JSON (ví dụ chưa đăng nhập). */
export function geminiExitEvents(code: number | null, stderr: string): AgentEvent[] {
  if (code === EXIT_AUTH || /set an auth method|GEMINI_API_KEY/i.test(stderr)) {
    return [{ type: 'error', code: 'auth', message: AUTH_HINT }];
  }
  return [];
}

/**
 * Lưu ý: trang tài liệu Gemini CLI ghi rằng nó đã được Antigravity CLI thay thế
 * (18/06/2026). Adapter vẫn giữ cho người đang dùng bản cũ — xem ADR-0006.
 */
export function createGeminiAdapter(options: GeminiAdapterOptions = {}): AgentAdapter {
  const command = options.command ?? 'gemini';
  const prefix = options.prefixArgs ?? [];

  const fallback = createPtyAdapter({
    id: 'gemini',
    displayName: 'Gemini CLI',
    command,
    prefixArgs: prefix,
    input: 'stdin',
    editFiles: true,
    installHint: INSTALL,
    args: (o) => [
      '-p',
      '',
      '--output-format',
      'text',
      '--skip-trust',
      '--approval-mode',
      o.permission === 'edit' ? 'auto_edit' : 'plan',
    ],
  });

  return {
    id: 'gemini',
    displayName: 'Gemini CLI',
    fallback,

    async detect(): Promise<DetectResult> {
      const version = await runCommand(command, [...prefix, '--version']);
      if (!version || version.code !== 0) return { installed: false, ready: false, note: INSTALL };
      // Gemini không có lệnh kiểm đăng nhập riêng: xem có khoá API hoặc file đăng nhập không.
      const loggedIn = geminiLooksLoggedIn();
      return {
        installed: true,
        version: version.stdout.trim(),
        ready: loggedIn,
        note: loggedIn
          ? 'Adapter Gemini chưa được chạy thật với tài khoản đã đăng nhập.'
          : AUTH_HINT,
      };
    },

    capabilities() {
      return {
        streaming: true,
        resume: true,
        tools: true,
        editFiles: true,
        images: true,
        mcp: true,
        subagents: false,
        // Gemini có móc BeforeTool trong settings.json nhưng chưa xác minh được cách nạp
        // settings cho riêng một lần chạy mà không sửa file của người dùng. Xem ADR-0007.
        toolGate: false,
        tier: 'headless',
      };
    },

    fingerprint: () => probeCli(command, { prefixArgs: prefix }),

    run(runOptions, onEvent) {
      return runJsonLinesProcess(
        {
          command,
          label: 'Gemini CLI',
          args: [...prefix, ...buildGeminiArgs(runOptions)],
          cwd: runOptions.cwd,
          stdin: runOptions.prompt,
          parseLine: createGeminiParser(),
          onExit: ({ code, stderr, sawError, jsonLines }) => {
            if (sawError) return [];
            const auth = geminiExitEvents(code, stderr);
            if (auth.length) return auth;
            return code !== 0 && jsonLines > 0
              ? [
                  {
                    type: 'error',
                    code: 'cli',
                    message: stderr.trim() || `Gemini thoát với mã ${String(code)}`,
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
