/**
 * Cổng MCP của NSA: MỘT server MCP (streamable HTTP, chỉ JSON — không mở luồng SSE) gom tool
 * của mọi nguồn đang bật (bộ nhớ NSA Mem, plugin) cho agent. Xem ADR-0010.
 *
 * - Chỉ nghe 127.0.0.1, cổng ngẫu nhiên.
 * - Mỗi lượt chạy được cấp một mã bí mật (`register`); mã sai / hết hạn → 401.
 *   Mã gắn với ngữ cảnh lượt (agent nào, cuộc trò chuyện nào) để biết ai gọi.
 * - Danh sách tool tính lại mỗi lần `tools/list`: bật / tắt / gỡ plugin có hiệu lực ngay,
 *   không cần khởi động lại app.
 * - MỌI lời gọi tool đi qua ổ cắm `Policy` (cho phép / hỏi / chặn) và ghi `AuditLog`.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { McpCallContext, McpServerSpec, McpTool } from '@nsa/adapter-sdk';
import type { AuditEntry, AuditLog, IdentityProvider, Policy, PolicyDecision } from '@nsa/core';

/** Tool trong cổng: thêm nguồn gốc để chính sách và nhật ký biết nó của ai. */
export interface GatewayTool extends McpTool {
  source: 'memory' | 'plugin';
  pluginId?: string;
  /** Thao tác nhạy cảm — chính sách bản Cá nhân luôn hỏi người dùng mỗi lần gọi. */
  sensitive?: boolean;
}

/** Một nguồn tool; được hỏi lại mỗi lần agent liệt kê tool nên luôn phản ánh trạng thái hiện tại. */
export type ToolSource = () => GatewayTool[];

export interface McpGatewayOptions {
  /** Tên server — khoá cấu hình của mọi CLI (mặc định `nsa`: Claude thấy `mcp__nsa__<tool>`). */
  name?: string;
  version: string;
  identity: IdentityProvider;
  policy: Policy;
  audit?: AuditLog;
  /** Hỏi người dùng giữa lượt khi chính sách trả "hỏi". Không có thì "hỏi" coi như từ chối. */
  askUser?: (context: McpCallContext, description: string) => Promise<boolean>;
  now?: () => Date;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const BODY_LIMIT = 1_000_000;
const INPUT_PREVIEW = 400;

export class McpGateway {
  readonly #server: Server;
  readonly #url: string;
  readonly #name: string;
  readonly #sources = new Set<ToolSource>();
  readonly #contexts = new Map<string, McpCallContext>();
  readonly #options: McpGatewayOptions;

  private constructor(server: Server, url: string, options: McpGatewayOptions) {
    this.#server = server;
    this.#url = url;
    this.#name = options.name ?? 'nsa';
    this.#options = options;
  }

  static async start(options: McpGatewayOptions): Promise<McpGateway> {
    const holder: { gateway?: McpGateway } = {};
    const server = createServer((req, res) => {
      void holder.gateway?.handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(err));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Không mở được cổng MCP');
    holder.gateway = new McpGateway(server, `http://127.0.0.1:${address.port}/mcp`, options);
    return holder.gateway;
  }

  get url(): string {
    return this.#url;
  }

  get name(): string {
    return this.#name;
  }

  /** Thêm một nguồn tool; trả hàm gỡ nguồn. */
  addSource(source: ToolSource): () => void {
    this.#sources.add(source);
    return () => void this.#sources.delete(source);
  }

  /** Mọi tool đang bật. Trùng tên thì tool của nguồn thêm trước thắng. */
  listTools(): GatewayTool[] {
    const seen = new Set<string>();
    const tools: GatewayTool[] = [];
    for (const source of this.#sources) {
      let items: GatewayTool[] = [];
      try {
        items = source();
      } catch (err) {
        console.error('[gateway] một nguồn tool lỗi:', err);
      }
      for (const tool of items) {
        if (seen.has(tool.name)) continue;
        seen.add(tool.name);
        tools.push(tool);
      }
    }
    return tools;
  }

  /** Cấp mã cho một lượt; gọi `dispose` khi lượt kết thúc. */
  register(context: McpCallContext): { server: McpServerSpec; dispose: () => void } {
    const token = randomBytes(24).toString('hex');
    this.#contexts.set(token, context);
    return {
      server: {
        name: this.#name,
        url: this.#url,
        token,
        tools: this.listTools().map((t) => t.name),
      },
      dispose: () => void this.#contexts.delete(token),
    };
  }

  /** Nối vào `ChatExtension.mcpFor`: không có tool nào đang bật thì không gắn gì cho agent. */
  mcpFor(input: McpCallContext): { server: McpServerSpec; dispose: () => void } | null {
    if (this.listTools().length === 0) return null;
    return this.register(input);
  }

  close(): Promise<void> {
    this.#contexts.clear();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  // ------------------------------------------------------------ HTTP

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    const auth = req.headers['authorization'];
    const token = typeof auth === 'string' ? auth.replace(/^Bearer\s+/i, '') : '';
    const context = this.#contexts.get(token);
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
      sendJson(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const batch = Array.isArray(parsed);
    const requests = (batch ? parsed : [parsed]) as JsonRpcRequest[];
    const responses: unknown[] = [];
    for (const request of requests) {
      const response = await this.dispatch(request, context);
      if (response) responses.push(response);
    }
    if (responses.length === 0) {
      res.writeHead(202).end();
      return;
    }
    sendJson(res, batch ? responses : responses[0]);
  }

  private async dispatch(request: JsonRpcRequest, context: McpCallContext): Promise<unknown> {
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
          serverInfo: { name: this.#name, version: this.#options.version },
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({
          tools: this.listTools().map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            ...(t.readOnly ? { annotations: { readOnlyHint: true } } : {}),
          })),
        });
      case 'tools/call': {
        const toolName = String(request.params?.['name'] ?? '');
        const args = (request.params?.['arguments'] ?? {}) as Record<string, unknown>;
        const result = await this.invoke(toolName, args, context);
        if (result === null) {
          return fail(-32602, `Không có tool ${toolName} (plugin có thể đã bị tắt hoặc gỡ)`);
        }
        return ok({
          content: [{ type: 'text', text: result.text }],
          ...(result.error ? { isError: true } : {}),
        });
      }
      default:
        return fail(-32601, `Không hỗ trợ ${String(request.method)}`);
    }
  }

  // ------------------------------------------------------------ Chính sách + nhật ký + gọi

  /**
   * Một lời gọi tool: hỏi `Policy` → (hỏi người dùng nếu cần) → chạy → ghi nhật ký.
   * Trả `null` nếu tool không (còn) tồn tại.
   */
  async invoke(
    toolName: string,
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<{ text: string; error: boolean } | null> {
    const tool = this.listTools().find((t) => t.name === toolName);
    if (!tool) return null;
    const input = previewInput(args);
    const actor = this.#options.identity.current();
    const log = (
      body: Omit<
        Extract<AuditEntry, { type: 'mcp_tool' }>,
        'type' | 'at' | 'actor' | 'agentId' | 'source' | 'tool'
      >,
    ): void => {
      if (!this.#options.audit) return;
      try {
        this.#options.audit.record({
          type: 'mcp_tool',
          at: (this.#options.now ?? (() => new Date()))().toISOString(),
          actor: { id: actor.id, displayName: actor.displayName },
          agentId: context.agentId,
          ...(context.conversationId ? { conversationId: context.conversationId } : {}),
          ...(context.turnId ? { turnId: context.turnId } : {}),
          source: tool.source,
          ...(tool.pluginId ? { pluginId: tool.pluginId } : {}),
          tool: tool.name,
          ...body,
        });
      } catch (err) {
        console.error('[gateway] không ghi được nhật ký:', err);
      }
    };

    let verdict: PolicyDecision;
    try {
      verdict = await this.#options.policy.check({
        actor,
        action: {
          kind: 'mcp.tool',
          agentId: context.agentId,
          ...(context.conversationId ? { conversationId: context.conversationId } : {}),
          ...(context.turnId ? { turnId: context.turnId } : {}),
          source: tool.source,
          ...(tool.pluginId ? { pluginId: tool.pluginId } : {}),
          tool: tool.name,
          sensitive: tool.sensitive === true,
          input,
        },
        confirmed: false,
      });
    } catch (err) {
      verdict = { decision: 'deny', reason: `Lỗi khi kiểm chính sách: ${String(err)}` };
    }
    if (verdict.decision === 'deny') {
      log({ decision: 'deny', reason: verdict.reason, confirmed: false });
      return { text: `NSA chặn: ${verdict.reason}`, error: true };
    }
    let confirmed = false;
    if (verdict.decision === 'ask') {
      const allowed = await Promise.resolve(this.#options.askUser?.(context, verdict.reason)).then(
        (answer) => answer === true,
        () => false,
      );
      if (!allowed) {
        log({ decision: 'deny', reason: verdict.reason, confirmed: false });
        return { text: 'NSA: người dùng không cho phép thao tác này.', error: true };
      }
      confirmed = true;
    }

    const started = Date.now();
    try {
      const text = await tool.call(args, context);
      log({ decision: 'allow' as const, confirmed, ok: true, ms: Date.now() - started });
      return { text, error: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log({
        decision: 'allow' as const,
        confirmed,
        ok: false,
        error: message,
        ms: Date.now() - started,
      });
      return { text: message, error: true };
    }
  }
}

/** Nguồn tool cho bộ nhớ NSA Mem: ba tool giữ nguyên hành vi như server MCP tạm của giai đoạn 2. */
export function memoryToolSource(
  memory: { tools(): McpTool[] },
  enabled: () => boolean = () => true,
): ToolSource {
  return () => (enabled() ? memory.tools().map((t) => ({ ...t, source: 'memory' as const })) : []);
}

function previewInput(args: Record<string, unknown>): string {
  let text: string;
  try {
    text = JSON.stringify(args);
  } catch {
    text = '[không đọc được tham số]';
  }
  return text.length > INPUT_PREVIEW ? `${text.slice(0, INPUT_PREVIEW)}…` : text;
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
