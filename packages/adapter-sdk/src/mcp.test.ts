import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  claudeMcpArgs,
  codexMcpArgs,
  mcpEnv,
  mcpTokenEnv,
  openCodeMcpConfig,
  type McpServerSpec,
} from './mcp.js';

const server: McpServerSpec = {
  name: 'nsa_mem',
  url: 'http://127.0.0.1:5000/mcp',
  token: 'bí-mật',
  tools: ['mem_search', 'mem_read'],
};

describe('gắn MCP vào CLI — mã bí mật chỉ đi qua biến môi trường', () => {
  it('Claude: file cấu hình chỉ chứa ${BIẾN}, cho phép sẵn tool', () => {
    const args = claudeMcpArgs([server]);
    expect(args[0]).toBe('--mcp-config');
    const config = readFileSync(args[1] ?? '', 'utf8');
    expect(config).not.toContain('bí-mật');
    expect(JSON.parse(config)).toEqual({
      mcpServers: {
        nsa_mem: {
          type: 'http',
          url: server.url,
          headers: { Authorization: 'Bearer ${NSA_MCP_NSA_MEM_TOKEN}' },
        },
      },
    });
    expect(args.slice(2)).toEqual([
      '--allowedTools',
      'mcp__nsa_mem__mem_search,mcp__nsa_mem__mem_read',
    ]);
    expect(args.join(' ')).not.toContain('bí-mật');
  });

  it('Codex: -c url + bearer_token_env_var', () => {
    const args = codexMcpArgs([server]);
    expect(args).toEqual([
      '-c',
      'mcp_servers.nsa_mem.url="http://127.0.0.1:5000/mcp"',
      '-c',
      'mcp_servers.nsa_mem.bearer_token_env_var="NSA_MCP_NSA_MEM_TOKEN"',
    ]);
  });

  it('OpenCode: remote + {env:BIẾN}', () => {
    expect(openCodeMcpConfig([server])).toEqual({
      nsa_mem: {
        type: 'remote',
        url: server.url,
        enabled: true,
        oauth: false,
        headers: { Authorization: 'Bearer {env:NSA_MCP_NSA_MEM_TOKEN}' },
      },
    });
  });

  it('biến môi trường + tên server hợp lệ', () => {
    expect(mcpEnv([server])).toEqual({ NSA_MCP_NSA_MEM_TOKEN: 'bí-mật' });
    expect(() => mcpTokenEnv('--evil')).toThrow();
  });
});
