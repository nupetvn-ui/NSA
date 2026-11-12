/**
 * Cổng chính sách cho từng lệnh bên trong một lượt (ADR-0007).
 *
 * Lõi mở một máy chủ HTTP nhỏ trên 127.0.0.1 (cổng ngẫu nhiên). Mỗi lượt chạy được cấp
 * một mã bí mật riêng. Adapter gắn móc (hook / plugin) của CLI để trước MỖI lệnh, CLI hỏi
 * cổng này; cổng hỏi ổ cắm `Policy` rồi trả lời cho phép / chặn.
 *
 * Nguyên tắc: móc phải "lỗi là chặn" — cổng không trả lời, mã sai, hết giờ… đều là chặn.
 * (Đã thử thật: Claude Code và OpenCode cho lệnh chạy tiếp nếu móc tự lỗi, nên script móc
 * tự bắt mọi lỗi và trả về "chặn".)
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ToolGateEndpoint } from './adapter.js';

/** Một lệnh CLI định chạy, gửi từ móc về cổng. */
export interface ToolCallRequest {
  /** Tên công cụ theo CLI: `Bash`, `Edit`, `bash`, `write`… */
  tool: string;
  /** Tham số của công cụ (lệnh shell, đường dẫn file…) — dạng CLI gửi. */
  input: unknown;
}

export type ToolGateVerdict = { allow: true } | { allow: false; reason: string };

export type ToolGateHandler = (request: ToolCallRequest) => Promise<ToolGateVerdict>;

const BODY_LIMIT = 256_000;

/** Máy chủ cổng dùng chung cho mọi lượt; mỗi lượt đăng ký một mã riêng. */
export class ToolGateServer {
  readonly #server: Server;
  readonly #url: string;
  readonly #handlers: Map<string, ToolGateHandler>;

  private constructor(server: Server, url: string, handlers: Map<string, ToolGateHandler>) {
    this.#server = server;
    this.#url = url;
    this.#handlers = handlers;
  }

  static async start(): Promise<ToolGateServer> {
    const handlers = new Map<string, ToolGateHandler>();
    const server = createServer((req, res) => {
      const reply = (verdict: ToolGateVerdict): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(verdict));
      };
      if (req.method !== 'POST' || req.url !== '/check') {
        res.writeHead(404).end();
        return;
      }
      const token = req.headers['x-nsa-token'];
      const handler = typeof token === 'string' ? handlers.get(token) : undefined;
      if (!handler) {
        req.resume();
        reply({ allow: false, reason: 'NSA: lượt này không còn hiệu lực' });
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > BODY_LIMIT) req.destroy();
      });
      req.on('end', () => {
        let request: ToolCallRequest;
        try {
          const json = JSON.parse(body) as { tool?: unknown; input?: unknown };
          request = { tool: String(json.tool ?? 'unknown'), input: json.input ?? null };
        } catch {
          reply({ allow: false, reason: 'NSA: yêu cầu không hợp lệ' });
          return;
        }
        handler(request).then(reply, (err: unknown) =>
          reply({ allow: false, reason: `NSA: lỗi khi kiểm chính sách (${String(err)})` }),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Không mở được cổng chính sách');
    return new ToolGateServer(server, `http://127.0.0.1:${address.port}/check`, handlers);
  }

  /** Đăng ký một lượt; gọi `dispose` khi lượt kết thúc để mã bí mật hết hiệu lực. */
  register(handler: ToolGateHandler): { endpoint: ToolGateEndpoint; dispose: () => void } {
    const token = randomBytes(24).toString('hex');
    this.#handlers.set(token, handler);
    return {
      endpoint: { url: this.#url, token },
      dispose: () => void this.#handlers.delete(token),
    };
  }

  close(): Promise<void> {
    this.#handlers.clear();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}

// ------------------------------------------------------------ Script móc cho từng CLI

/**
 * Móc dạng lệnh (Claude Code PreToolUse). Đọc JSON từ stdin, hỏi cổng, in quyết định.
 * Mọi lỗi → chặn. CommonJS, không phụ thuộc gì, chạy được bằng Node hoặc Electron
 * (ELECTRON_RUN_AS_NODE=1).
 */
const COMMAND_HOOK = String.raw`'use strict';
const url = process.env.NSA_GATE_URL, token = process.env.NSA_GATE_TOKEN;
function out(allow, reason) {
  if (allow) { process.exit(0); }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
    permissionDecision: 'deny', permissionDecisionReason: reason } }));
  process.exit(0);
}
let raw = '';
const timer = setTimeout(() => out(false, 'NSA: cổng chính sách không trả lời'), 600000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', async () => {
  try {
    if (!url || !token) return out(false, 'NSA: thiếu địa chỉ cổng chính sách');
    const j = JSON.parse(raw);
    const res = await fetch(url, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-nsa-token': token },
      body: JSON.stringify({ tool: j.tool_name, input: j.tool_input }) });
    const v = await res.json();
    clearTimeout(timer);
    out(v && v.allow === true, (v && v.reason) || 'NSA: chính sách chặn lệnh này');
  } catch (e) { out(false, 'NSA: lỗi cổng chính sách — ' + (e && e.message)); }
});
`;

/** Plugin OpenCode: chạy bên trong tiến trình opencode, ném lỗi để chặn công cụ. */
const OPENCODE_PLUGIN = String.raw`export const NsaGate = async () => ({
  'tool.execute.before': async (input, output) => {
    const url = process.env.NSA_GATE_URL, token = process.env.NSA_GATE_TOKEN;
    let v;
    try {
      const res = await fetch(url, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-nsa-token': token },
        body: JSON.stringify({ tool: input.tool, input: output.args }) });
      v = await res.json();
    } catch (e) {
      throw new Error('NSA: lỗi cổng chính sách — ' + (e && e.message));
    }
    if (!v || v.allow !== true) throw new Error((v && v.reason) || 'NSA: chính sách chặn lệnh này');
  },
});
`;

let hookDir: string | null = null;

/** Ghi các script móc ra thư mục tạm (một lần mỗi tiến trình) và trả về đường dẫn. */
export function gateHookFiles(): { commandHook: string; opencodePlugin: string } {
  if (!hookDir) {
    hookDir = join(tmpdir(), `nsa-gate-${process.pid}`);
    mkdirSync(hookDir, { recursive: true });
    writeFileSync(join(hookDir, 'gate-hook.cjs'), COMMAND_HOOK, 'utf8');
    writeFileSync(join(hookDir, 'nsa-gate-plugin.js'), OPENCODE_PLUGIN, 'utf8');
  }
  return {
    commandHook: join(hookDir, 'gate-hook.cjs'),
    opencodePlugin: join(hookDir, 'nsa-gate-plugin.js'),
  };
}

/** URL file:// cho plugin OpenCode. */
export function fileUrl(path: string): string {
  return pathToFileURL(path).href;
}

/**
 * Lệnh chạy script Node từ bên trong một CLI: dùng chính runtime của NSA
 * (Electron chạy như Node khi có ELECTRON_RUN_AS_NODE=1), nên máy người dùng không cần cài Node.
 */
export function nodeRuntime(): { command: string; env: Record<string, string> } {
  return {
    command: process.execPath,
    env: process.versions['electron'] ? { ELECTRON_RUN_AS_NODE: '1' } : {},
  };
}

/** Biến môi trường mà script móc đọc. */
export function gateEnv(endpoint: ToolGateEndpoint): Record<string, string> {
  return { NSA_GATE_URL: endpoint.url, NSA_GATE_TOKEN: endpoint.token };
}

/** Bọc đường dẫn trong ngoặc kép, dùng gạch xuôi — chạy được trong cả cmd lẫn bash. */
export function shellQuote(path: string): string {
  return `"${path.replace(/\\/g, '/')}"`;
}
