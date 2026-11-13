/**
 * Server MCP tối giản (streamable HTTP, chỉ trả JSON — không mở luồng SSE) để lộ tool của
 * NSA Mem cho agent. Đây là lối tạm của giai đoạn 2: giai đoạn 3 chuyển các tool này vào
 * MCP gateway chung (ADR-0008).
 *
 * - Chỉ nghe 127.0.0.1, cổng ngẫu nhiên.
 * - Mỗi lượt chạy được cấp một mã bí mật (`register`); mã sai / hết hạn → 401.
 * - Mã bí mật gắn với ngữ cảnh lượt (agent nào, cuộc trò chuyện nào) để tool biết ai gọi.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { McpServerSpec } from '@nsa/adapter-sdk';

export interface McpCallContext {
  agentId: string;
  conversationId?: string;
  turnId?: string;
}

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

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const BODY_LIMIT = 1_000_000;

export class McpHttpServer {
  readonly #server: Server;
  readonly #url: string;
  readonly #name: string;
  readonly #tools: McpTool[];
  readonly #contexts: Map<string, McpCallContext>;

  private constructor(
    server: Server,
    url: string,
    name: string,
    tools: McpTool[],
    contexts: Map<string, McpCallContext>,
  ) {
    this.#server = server;
    this.#url = url;
    this.#name = name;
    this.#tools = tools;
    this.#contexts = contexts;
  }

  static async start(options: {
    name: string;
    version: string;
    tools: McpTool[];
  }): Promise<McpHttpServer> {
    const contexts = new Map<string, McpCallContext>();
    const { name, version, tools } = options;
    const server = createServer((req, res) => {
      void handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(err));
      });
    });

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.url !== '/mcp') {
        res.writeHead(404).end();
        return;
      }
      const auth = req.headers['authorization'];
      const token = typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '') : '';
      const context = contexts.get(token);
      if (!context) {
        req.resume();
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'NSA: lượt này không còn hiệu lực' }));
        return;
      }
      if (req.method === 'DELETE') {
        res.writeHead(200).end();
        return;
      }
      if (req.method !== 'POST') {
        // Không mở luồng SSE do server chủ động gửi.
        res.writeHead(405, { allow: 'POST' }).end();
        return;
      }
      const body = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        });
        return;
      }
      const batch = Array.isArray(parsed);
      const requests = (batch ? parsed : [parsed]) as JsonRpcRequest[];
      const responses: unknown[] = [];
      for (const request of requests) {
        const response = await dispatch(request, context);
        if (response) responses.push(response);
      }
      if (responses.length === 0) {
        res.writeHead(202).end();
        return;
      }
      sendJson(res, batch ? responses : responses[0]);
    }

    async function dispatch(
      request: JsonRpcRequest,
      context: McpCallContext,
    ): Promise<unknown | null> {
      const id = request.id;
      // Thông báo (không có id) — không trả lời.
      if (id === undefined || id === null) return null;
      const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
      const fail = (code: number, message: string) => ({
        jsonrpc: '2.0',
        id,
        error: { code, message },
      });
      switch (request.method) {
        case 'initialize': {
          const asked = String(request.params?.['protocolVersion'] ?? '');
          return ok({
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name, version },
          });
        }
        case 'ping':
          return ok({});
        case 'tools/list':
          return ok({
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              ...(t.readOnly ? { annotations: { readOnlyHint: true } } : {}),
            })),
          });
        case 'tools/call': {
          const toolName = String(request.params?.['name'] ?? '');
          const tool = tools.find((t) => t.name === toolName);
          if (!tool) return fail(-32602, `Không có tool ${toolName}`);
          const args = (request.params?.['arguments'] ?? {}) as Record<string, unknown>;
          try {
            const text = await tool.call(args, context);
            return ok({ content: [{ type: 'text', text }] });
          } catch (err) {
            return ok({
              content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
              isError: true,
            });
          }
        }
        default:
          return fail(-32601, `Không hỗ trợ ${String(request.method)}`);
      }
    }

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Không mở được server MCP');
    return new McpHttpServer(server, `http://127.0.0.1:${address.port}/mcp`, name, tools, contexts);
  }

  get url(): string {
    return this.#url;
  }

  /** Cấp mã cho một lượt; gọi `dispose` khi lượt kết thúc. */
  register(context: McpCallContext): { server: McpServerSpec; dispose: () => void } {
    const token = randomBytes(24).toString('hex');
    this.#contexts.set(token, context);
    return {
      server: { name: this.#name, url: this.#url, token, tools: this.#tools.map((t) => t.name) },
      dispose: () => void this.#contexts.delete(token),
    };
  }

  close(): Promise<void> {
    this.#contexts.clear();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
      if (body.length > BODY_LIMIT) req.destroy(new Error('Yêu cầu quá lớn'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}
