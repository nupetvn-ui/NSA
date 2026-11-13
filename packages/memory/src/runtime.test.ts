import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as NodeSqlite from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentEvent, RunOptions } from '@nsa/adapter-sdk';
import { McpGateway, memoryToolSource } from '@nsa/mcp-gateway';
import {
  ChatService,
  DEFAULT_MEMORY_SETTINGS,
  localIdentity,
  personalPolicy,
  type Conversation,
} from '@nsa/core';
import {
  CORRECTION,
  DistillScheduler,
  TEACH,
  buildDistillPrompt,
  parseDistillOutput,
} from './distill.js';
import { ChatHistoryImporter, parseClaudeSession, parseCodexSession } from './importers.js';
import { MemoryRuntime } from './runtime.js';
import { MemoryService } from './service.js';

const require = createRequire(import.meta.url);
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nsa-memrt-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function memory() {
  const service = await MemoryService.open({
    root: tempDir(),
    identity: localIdentity('tester'),
    policy: personalPolicy(),
  });
  cleanups.push(() => service.close());
  return service;
}

/** Adapter giả: ghi lại prompt + server MCP nhận được, trả lời `answer(prompt)`. */
function fakeAgent(id: string, answer: (prompt: string) => string, mcp = true, delayMs = 5) {
  const runs: RunOptions[] = [];
  const adapter: AgentAdapter = {
    id,
    displayName: id.toUpperCase(),
    detect: async () => ({ installed: true, ready: true }),
    capabilities: () => ({
      streaming: true,
      resume: false,
      tools: true,
      editFiles: true,
      images: false,
      mcp,
      subagents: false,
      toolGate: false,
      tier: 'headless',
    }),
    run(options, onEvent) {
      runs.push(options);
      const events: AgentEvent[] = [
        { type: 'text', id: 't', text: answer(options.prompt) },
        { type: 'done', cancelled: false },
      ];
      const finished = new Promise<void>((resolve) =>
        setTimeout(() => {
          events.forEach(onEvent);
          resolve();
        }, delayMs),
      );
      return { cancel: () => undefined, finished };
    },
  };
  return { adapter, runs };
}

/** Cổng MCP của NSA với nguồn tool là bộ nhớ (giống cách app nối). */
async function gateway(service: MemoryService): Promise<McpGateway> {
  const mcp = await McpGateway.start({
    version: '0',
    identity: localIdentity('tester'),
    policy: personalPolicy(),
  });
  mcp.addSource(memoryToolSource(service));
  cleanups.push(() => mcp.close());
  return mcp;
}

const settle = () => new Promise((r) => setTimeout(r, 40));

describe('Agent B nhớ điều đã dạy agent A', () => {
  it('dạy qua mem_propose khi chat với A → cuộc trò chuyện mới với B nhận được điều đó', async () => {
    const service = await memory();
    const mcp = await gateway(service);

    // A: gọi mem_propose qua MCP thật (HTTP) bằng mã bí mật của lượt.
    const a = fakeAgent('claude', () => 'Đã ghi nhớ.', true, 300);
    const b = fakeAgent('codex', (prompt) =>
      prompt.includes('xanh lá') ? 'Bạn thích màu xanh lá.' : 'Tôi không biết.',
    );
    const ref: { chat?: ChatService } = {};
    const runtime = new MemoryRuntime({
      service,
      importer: new ChatHistoryImporter({ home: tempDir() }),
      settingsFile: join(tempDir(), 'memory-settings.json'),
      workDir: tempDir(),
      runTask: (r) => ref.chat!.runTask(r),
      conversations: () => ref.chat!.listConversations(),
    });
    runtime.saveSettings({ distill: { ...DEFAULT_MEMORY_SETTINGS.distill, enabled: false } });
    cleanups.push(() => runtime.dispose());
    const chat = new ChatService({
      adapters: [a.adapter, b.adapter],
      identity: localIdentity('tester'),
      extensions: [runtime, mcp],
    });
    ref.chat = chat;

    await chat.send({ agentId: 'claude', prompt: 'Hãy nhớ: tôi thích màu xanh lá', cwd: 'D:/p' });
    // Kho còn trống nhưng A có MCP → vẫn được báo dùng mem_propose.
    expect(a.runs[0]?.prompt).toContain('mem_propose');
    const attached = a.runs[0]?.mcpServers?.[0];
    expect(attached?.name).toBe('nsa');
    const call = await fetch(attached?.url ?? '', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${attached?.token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'mem_propose',
          arguments: {
            title: 'Màu yêu thích',
            body: 'Người dùng thích màu xanh lá.',
            kind: 'preference',
            confidence: 0.95,
          },
        },
      }),
    });
    const reply = (await call.json()) as { result: { content: { text: string }[] } };
    expect(reply.result.content[0]?.text).toMatch(/Đã ghi vào bộ nhớ/);
    await new Promise((r) => setTimeout(r, 350));

    // Mã bí mật hết hiệu lực khi lượt xong.
    const stale = await fetch(attached?.url ?? '', {
      method: 'POST',
      headers: { authorization: `Bearer ${attached?.token}` },
      body: '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
    });
    expect(stale.status).toBe(401);

    // B, cuộc trò chuyện MỚI.
    const result = await chat.send({ agentId: 'codex', prompt: 'Tôi thích màu gì?', cwd: 'D:/q' });
    await settle();
    expect(b.runs[0]?.prompt).toContain('[Bộ nhớ NSA]');
    expect(b.runs[0]?.prompt).toContain('Người dùng thích màu xanh lá.');
    const conv = chat
      .listConversations()
      .find((c) => result.status === 'started' && c.id === result.conversationId);
    expect(conv?.turns[0]?.memory?.[0]?.title).toBe('Màu yêu thích');
    expect(conv?.turns[0]?.parts[0]).toMatchObject({ text: 'Bạn thích màu xanh lá.' });
  });

  it('agent không hỗ trợ MCP vẫn nhận ngữ cảnh tự chèn, không nhận server MCP', async () => {
    const service = await memory();
    await service.teach({
      branch: 'nguoi-dung',
      title: 'Tên',
      body: 'Người dùng tên là Bình.',
      kind: 'fact',
    });
    const pty = fakeAgent('pty', () => 'ok', false);
    const runtime = new MemoryRuntime({
      service,
      importer: new ChatHistoryImporter({ home: tempDir() }),
      settingsFile: join(tempDir(), 's.json'),
      workDir: tempDir(),
      runTask: () => Promise.reject(new Error('không dùng')),
      conversations: () => [],
    });
    cleanups.push(() => runtime.dispose());
    const chat = new ChatService({
      adapters: [pty.adapter],
      identity: localIdentity('t'),
      extensions: [runtime],
    });
    await chat.send({ agentId: 'pty', prompt: 'tôi tên gì', cwd: 'D:/p' });
    await settle();
    expect(pty.runs[0]?.prompt).toContain('Bình');
    expect(pty.runs[0]?.mcpServers).toBeUndefined();
  });
});

describe('cổng MCP chứa tool bộ nhớ', () => {
  it('initialize / tools/list / thông báo / mã sai', async () => {
    const service = await memory();
    const mcp = await gateway(service);
    const { server, dispose } = mcp.register({ agentId: 'x' });
    const post = (body: unknown, token = server.token) =>
      fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    const init = (await (
      await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26' },
      })
    ).json()) as { result: { protocolVersion: string } };
    expect(init.result.protocolVersion).toBe('2025-03-26');
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const list = (await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()) as {
      result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] };
    };
    expect(list.result.tools.map((t) => t.name)).toEqual(['mem_search', 'mem_read', 'mem_propose']);
    expect(list.result.tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    expect((await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, 'sai')).status).toBe(401);
    dispose();
    expect((await post({ jsonrpc: '2.0', id: 4, method: 'tools/list' })).status).toBe(401);
  });

  it('mem_propose chỉ vào hộp duyệt: điều mâu thuẫn không được ghi', async () => {
    const service = await memory();
    await service.teach({
      branch: 'nguoi-dung',
      title: 'Màu yêu thích',
      body: 'Người dùng thích màu xanh lá.',
      kind: 'preference',
    });
    const propose = service.tools().find((t) => t.name === 'mem_propose');
    const text = await propose?.call(
      {
        title: 'Màu yêu thích',
        body: 'Người dùng thích màu đỏ.',
        kind: 'preference',
        confidence: 1,
      },
      { agentId: 'codex' },
    );
    expect(text).toMatch(/hộp duyệt/);
    expect(service.listEntries().map((e) => e.body)).toEqual(['Người dùng thích màu xanh lá.']);
    expect(service.listProposals('pending')).toHaveLength(1);
  });
});

describe('chắt lọc', () => {
  it('đọc JSON từ câu trả lời (kể cả khối ```json và chữ thừa)', () => {
    const drafts = parseDistillOutput(
      'Đây:\n```json\n{"memories":[{"branch":"du-an","title":"Gói","body":"Dùng pnpm.","kind":"fact","confidence":0.9}]}\n```',
      { kind: 'distill', agentId: 'claude' },
    );
    expect(drafts).toEqual([
      {
        branch: 'du-an',
        title: 'Gói',
        body: 'Dùng pnpm.',
        kind: 'fact',
        confidence: 0.9,
        sensitive: false,
        source: { kind: 'distill', agentId: 'claude' },
      },
    ]);
    expect(parseDistillOutput('{"memories":[]}', { kind: 'distill' })).toEqual([]);
    expect(() => parseDistillOutput('không có gì', { kind: 'distill' })).toThrow();
  });

  it('prompt chắt lọc có nhánh, bộ nhớ hiện có, đoạn chat', () => {
    const prompt = buildDistillPrompt(
      { title: 'T', ref: 'nsa:1', messages: [{ role: 'user', text: 'tôi dùng Windows' }] },
      [
        {
          path: 'nguoi-dung',
          title: 'Về người dùng',
          description: 'd',
          autoApprove: true,
          minConfidence: 0.8,
          hidden: false,
          count: 0,
        },
      ],
      [],
    );
    expect(prompt).toContain('nguoi-dung');
    expect(prompt).toContain('NGƯỜI DÙNG: tôi dùng Windows');
  });

  it('nhận ra câu sửa lỗi và câu dặn nhớ', () => {
    expect(CORRECTION.test('Sai rồi, dự án dùng pnpm')).toBe(true);
    expect(CORRECTION.test('cảm ơn')).toBe(false);
    expect(TEACH.test('Hãy nhớ: tôi thích trà')).toBe(true);
    expect(TEACH.test('viết hàm cộng')).toBe(false);
  });

  it('ngưỡng: sửa lỗi / dặn nhớ → ngay; đủ số lượt → ngay; còn lại → khi im lặng đủ lâu', () => {
    vi.useFakeTimers();
    cleanups.push(() => void vi.useRealTimers());
    const triggers: string[] = [];
    const settings = { ...DEFAULT_MEMORY_SETTINGS.distill, everyTurns: 3, idleMinutes: 10 };
    const progress: Record<string, number> = {};
    const scheduler = new DistillScheduler({
      settings: () => settings,
      progress: () => progress,
      onTrigger: (id, reason) => triggers.push(`${id}:${reason}`),
    });
    const conv = (prompts: string[]): Conversation => ({
      id: 'c',
      title: 't',
      cwd: '',
      permission: 'read-only',
      createdAt: '',
      updatedAt: '',
      sessions: {},
      turns: prompts.map((p, i) => ({
        id: `t${i}`,
        agentId: 'a',
        prompt: p,
        startedAt: '',
        status: 'done',
        parts: [],
        errors: [],
      })),
    });
    scheduler.turnFinished(conv(['a']));
    expect(triggers).toEqual([]);
    scheduler.turnFinished(conv(['a', 'Sai rồi, không phải vậy']));
    expect(triggers).toEqual(['c:correction']);
    progress['c'] = 2;
    scheduler.turnFinished(conv(['a', 'b', 'c', 'd', 'e']));
    expect(triggers.at(-1)).toBe('c:turns');
    progress['c'] = 5;
    scheduler.turnFinished(conv(['a', 'b', 'c', 'd', 'e', 'f']));
    vi.advanceTimersByTime(9 * 60_000);
    scheduler.turnStarted('c'); // người dùng gửi tiếp → chưa kết thúc
    vi.advanceTimersByTime(60 * 60_000);
    expect(triggers.at(-1)).toBe('c:turns');
    scheduler.turnFinished(conv(['a', 'b', 'c', 'd', 'e', 'f', 'g']));
    vi.advanceTimersByTime(10 * 60_000);
    expect(triggers.at(-1)).toBe('c:idle');
    scheduler.dispose();
  });

  it('runtime: chắt lọc giao agent qua runTask, đề xuất vào hộp duyệt, không chắt lọc lại', async () => {
    const service = await memory();
    const conversation: Conversation = {
      id: 'c1',
      title: 'Hỏi về gói',
      cwd: 'D:/p',
      permission: 'read-only',
      createdAt: '',
      updatedAt: '',
      sessions: {},
      turns: [
        {
          id: 't1',
          agentId: 'claude',
          prompt: 'Sai rồi, dự án NSA dùng pnpm chứ không phải npm',
          startedAt: '',
          status: 'done',
          parts: [{ kind: 'text', id: 'x', text: 'Xin lỗi, tôi sẽ dùng pnpm.' }],
          errors: [],
        },
      ],
    };
    const prompts: string[] = [];
    const runtime = new MemoryRuntime({
      service,
      importer: new ChatHistoryImporter({ home: tempDir() }),
      settingsFile: join(tempDir(), 's.json'),
      workDir: tempDir(),
      runTask: async (r) => {
        prompts.push(r.prompt);
        return {
          agentId: 'codex',
          text: '{"memories":[{"branch":"du-an","title":"Trình quản lý gói","body":"Dự án NSA dùng pnpm, không dùng npm.","kind":"fact","subject":"goi-nsa","confidence":0.95}]}',
        };
      },
      conversations: () => [conversation],
    });
    cleanups.push(() => runtime.dispose());
    runtime.turnFinished(conversation, conversation.turns[0] as never);
    await vi.waitFor(() => expect(service.listEntries()).toHaveLength(1));
    const [entry] = service.listEntries();
    expect(entry?.source).toEqual({ kind: 'distill', agentId: 'codex', ref: 'nsa:c1' });
    expect(prompts[0]).toContain('dự án NSA dùng pnpm');
    expect(await runtime.distillConversation('c1', 'idle')).toEqual([]);
    expect(prompts).toHaveLength(1);
    expect(runtime.status()).toMatchObject({ running: false, proposals: 1 });
  });
});

describe('nhập lịch sử chat', () => {
  it('Claude Code: lấy lời người dùng + trả lời, bỏ phần CLI tự chèn và agent con', () => {
    const parsed = parseClaudeSession([
      { type: 'queue-operation' },
      { type: 'user', cwd: 'D:\\p', message: { content: '<system-reminder>x</system-reminder>' } },
      {
        type: 'user',
        message: { content: 'Tôi dùng Windows 10' },
        timestamp: '2026-11-01T00:00:00Z',
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: '…' },
            { type: 'text', text: 'Đã rõ.' },
          ],
        },
      },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Thêm ý.' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'out' }] } },
      { type: 'user', isSidechain: true, message: { content: 'agent con' } },
    ]);
    expect(parsed.messages).toEqual([
      { role: 'user', text: 'Tôi dùng Windows 10' },
      { role: 'assistant', text: 'Đã rõ.\nThêm ý.' },
    ]);
    expect(parsed.cwd).toBe('D:\\p');
  });

  it('Codex: response_item message, bỏ developer + AGENTS.md', () => {
    const parsed = parseCodexSession([
      { type: 'session_meta', payload: { id: 'abc', cwd: 'G:\\x' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'sys' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '# AGENTS.md instructions' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'gói là túi đó' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Đã sửa.' }],
        },
      },
      { type: 'response_item', payload: { type: 'reasoning' } },
    ]);
    expect(parsed).toMatchObject({ id: 'abc', cwd: 'G:\\x' });
    expect(parsed.messages).toEqual([
      { role: 'user', text: 'gói là túi đó' },
      { role: 'assistant', text: 'Đã sửa.' },
    ]);
  });

  it('OpenCode: đọc opencode.db (session / message / part)', () => {
    const home = tempDir();
    const dir = join(home, '.local', 'share', 'opencode');
    mkdirSync(dir, { recursive: true });
    const { DatabaseSync } = require('node:sqlite') as typeof NodeSqlite;
    const db = new DatabaseSync(join(dir, 'opencode.db'));
    db.exec(`CREATE TABLE session (id TEXT, parent_id TEXT, title TEXT, directory TEXT, time_updated INTEGER);
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);`);
    db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run(
      'ses_1',
      null,
      'Phiên một',
      'D:/w',
      1794469604675,
    );
    db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run(
      'ses_child',
      'ses_1',
      'con',
      'D:/w',
      1794469604676,
    );
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('m1', 'ses_1', 1, '{"role":"user"}');
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run(
      'm2',
      'ses_1',
      2,
      '{"role":"assistant"}',
    );
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run(
      'p1',
      'm1',
      'ses_1',
      1,
      '{"type":"text","text":"Tôi thích trà"}',
    );
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run(
      'p2',
      'm2',
      'ses_1',
      2,
      '{"type":"reasoning","text":"…"}',
    );
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run(
      'p3',
      'm2',
      'ses_1',
      3,
      '{"type":"text","text":"Ghi nhận."}',
    );
    db.close();

    const importer = new ChatHistoryImporter({ home });
    const list = importer.list('opencode');
    expect(list.map((c) => c.id)).toEqual(['ses_1']);
    expect(importer.transcript('opencode', 'ses_1').messages).toEqual([
      { role: 'user', text: 'Tôi thích trà' },
      { role: 'assistant', text: 'Ghi nhận.' },
    ]);
    const sources = importer.sources();
    expect(sources.find((s) => s.source === 'opencode')?.available).toBe(true);
    expect(sources.find((s) => s.source === 'claude')?.available).toBe(false);
  });

  it('Claude Code + Codex đọc từ file trên đĩa', () => {
    const home = tempDir();
    mkdirSync(join(home, '.claude', 'projects', 'D--p'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'projects', 'D--p', 's1.jsonl'),
      `${JSON.stringify({ type: 'user', message: { content: 'xin chào' } })}\n{hỏng\n`,
    );
    mkdirSync(join(home, '.codex', 'sessions', '2026', '11', '10'), { recursive: true });
    writeFileSync(
      join(home, '.codex', 'sessions', '2026', '11', '10', 'rollout-x.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'cx' } })}\n${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'chào codex' }],
        },
      })}\n`,
    );
    const importer = new ChatHistoryImporter({ home });
    expect(importer.list('claude')[0]).toMatchObject({ id: 's1', title: 'xin chào', messages: 1 });
    expect(importer.list('codex')[0]).toMatchObject({ id: 'cx', title: 'chào codex' });
  });
});
