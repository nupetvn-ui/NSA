/**
 * Gắn server MCP của NSA vào từng lượt chạy CLI (hợp đồng `attachMcp` của PLAN.md).
 *
 * NSA mở server MCP dạng streamable HTTP trên 127.0.0.1; mỗi lượt có một mã bí mật riêng.
 * Mã bí mật đi qua BIẾN MÔI TRƯỜNG, không bao giờ nằm trong tham số dòng lệnh hay file
 * cấu hình (giống cổng chính sách — ADR-0007). Giai đoạn 2 chỉ có server bộ nhớ `nsa_mem`;
 * giai đoạn 3 thay bằng MCP gateway chung (ADR-0008).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface McpServerSpec {
  /** Tên server — chỉ chữ thường, số, gạch dưới (dùng làm khoá cấu hình của mọi CLI). */
  name: string;
  /** Địa chỉ streamable HTTP, ví dụ `http://127.0.0.1:51234/mcp`. */
  url: string;
  /** Mã bí mật của lượt — gửi bằng `Authorization: Bearer`. */
  token: string;
  /** Tên các tool server lộ ra — để cho phép sẵn (Claude chế độ plan chặn tool lạ). */
  tools: string[];
}

const NAME = /^[a-z][a-z0-9_]{0,31}$/;

function checkName(name: string): string {
  if (!NAME.test(name)) throw new Error(`Tên server MCP không hợp lệ: ${name}`);
  return name;
}

/** Tên biến môi trường chứa mã bí mật của một server. */
export function mcpTokenEnv(name: string): string {
  return `NSA_MCP_${checkName(name).toUpperCase()}_TOKEN`;
}

export function mcpEnv(servers: McpServerSpec[]): Record<string, string> {
  return Object.fromEntries(servers.map((s) => [mcpTokenEnv(s.name), s.token]));
}

/**
 * Claude Code: `--mcp-config <file>` + `--allowedTools mcp__<server>__<tool>`.
 * File cấu hình chỉ chứa `${BIẾN}` — Claude tự thay bằng giá trị biến môi trường.
 */
export function claudeMcpConfig(servers: McpServerSpec[]): string {
  return JSON.stringify({
    mcpServers: Object.fromEntries(
      servers.map((s) => [
        checkName(s.name),
        {
          type: 'http',
          url: s.url,
          headers: { Authorization: `Bearer \${${mcpTokenEnv(s.name)}}` },
        },
      ]),
    ),
  });
}

export function claudeMcpArgs(servers: McpServerSpec[]): string[] {
  if (servers.length === 0) return [];
  const dir = join(tmpdir(), `nsa-mcp-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `claude-mcp-${servers.map((s) => s.name).join('-')}.json`);
  writeFileSync(file, claudeMcpConfig(servers), 'utf8');
  const allowed = servers.flatMap((s) => s.tools.map((t) => `mcp__${s.name}__${t}`));
  return ['--mcp-config', file, '--allowedTools', allowed.join(',')];
}

/** Codex: `-c mcp_servers.<tên>.url=…` + `bearer_token_env_var` (Codex tự đọc biến môi trường). */
export function codexMcpArgs(servers: McpServerSpec[]): string[] {
  return servers.flatMap((s) => {
    const key = `mcp_servers.${checkName(s.name)}`;
    return [
      '-c',
      `${key}.url=${JSON.stringify(s.url)}`,
      '-c',
      `${key}.bearer_token_env_var=${JSON.stringify(mcpTokenEnv(s.name))}`,
    ];
  });
}

/** OpenCode: khối `mcp` gộp vào OPENCODE_CONFIG_CONTENT; `{env:BIẾN}` do OpenCode tự thay. */
export function openCodeMcpConfig(servers: McpServerSpec[]): Record<string, unknown> {
  return Object.fromEntries(
    servers.map((s) => [
      checkName(s.name),
      {
        type: 'remote',
        url: s.url,
        enabled: true,
        oauth: false,
        headers: { Authorization: `Bearer {env:${mcpTokenEnv(s.name)}}` },
      },
    ]),
  );
}

/** Ai đang gọi một tool qua cổng MCP: agent nào, cuộc trò chuyện nào, lượt nào. */
export interface McpCallContext {
  agentId: string;
  conversationId?: string;
  turnId?: string;
}

/** Một tool lộ ra cho agent qua cổng MCP của NSA (bộ nhớ hoặc tool của plugin). */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Tool không sửa gì trong thư mục làm việc / máy người dùng. Claude Code ở chế độ `plan`
   * (quyền chỉ đọc của NSA) chỉ cho gọi tool MCP có `readOnlyHint` (đã thử thật).
   */
  readOnly?: boolean;
  call(args: Record<string, unknown>, context: McpCallContext): Promise<string> | string;
}
