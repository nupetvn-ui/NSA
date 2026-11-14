/**
 * Test quét key (PLAN.md, rủi ro "Key bị lộ là mất tiền thật"): chạy các đường chính của app
 * với một key giả, rồi quét MỌI file app ghi ra đĩa (cài đặt, kho khoá, nhật ký, lịch sử chat,
 * lịch sử phiên API, sổ chi phí, nhật ký CLI giả) và mọi thứ gửi lên giao diện.
 * Máy chủ giả cố tình in lại key trong trả lời và trong thông báo lỗi.
 */
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { prepareFakeCli, type AgentAdapter } from '@nsa/adapter-sdk';
import { startFakeApiServer, type FakeServer } from '@nsa/adapter-api';
import { ChatService, localIdentity, personalPolicy, type ChatEvent } from '@nsa/core';
import { bundledCatalog, secretForms, type OsCipher } from '@nsa/providers';
import { bundledCliAdapterFactories } from './adapters';
import { createFileAuditLog } from './audit';
import { setupProviders } from './providers';
import { createFileStore } from './store';

const KEY = 'sk-nsa-SCAN-9f8e7d6c5b4a3210zz99';

/** Giống hình dạng Electron safeStorage; bản mã không chứa bản rõ. */
const cipher: OsCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from([...Buffer.from(s, 'utf8')].map((b) => b ^ 0x37).reverse()),
  decryptString: (b) => Buffer.from([...b].reverse().map((x) => x ^ 0x37)).toString('utf8'),
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function leaks(text: string): string[] {
  return secretForms(KEY).filter((form) => text.includes(form));
}

let server: FakeServer | undefined;
afterAll(async () => server?.close());

describe('quét key trong mọi thứ app ghi ra', () => {
  it('key không nằm trong file nào, sự kiện nào gửi lên giao diện', async () => {
    let call = 0;
    server = await startFakeApiServer({
      reply: () => {
        call++;
        // Lần 1: model "in lại" key. Lần 2: hãng báo lỗi có kèm key. Sau đó: trả lời bình thường.
        if (call === 1)
          return { kind: 'text', text: `key của bạn là ${KEY}`, inputTokens: 50, outputTokens: 9 };
        if (call === 2) {
          return {
            kind: 'error',
            status: 429,
            body: JSON.stringify({ error: { message: `quota exceeded for ${KEY}` } }),
          };
        }
        return { kind: 'text', text: 'tóm tắt ngắn', inputTokens: 40, outputTokens: 5 };
      },
    });

    const userData = mkdtempSync(join(tmpdir(), 'nsa-keyscan-'));
    // File dữ liệu "tải về": trỏ DeepSeek vào máy chủ giả (cũng thử luôn đường cập nhật file dữ liệu).
    const catalog = structuredClone(bundledCatalog());
    catalog.version = '2099.1.1';
    for (const p of catalog.providers) {
      if (p.id === 'deepseek') p.endpoints = { openai: server.openaiUrl };
      if (p.id === 'deepseek') p.group = 'local'; // địa chỉ http của máy chủ giả chỉ hợp lệ với máy cục bộ
    }
    writeFileSync(join(userData, 'provider-catalog.json'), JSON.stringify(catalog));

    const fakeCli = prepareFakeCli('keyscan-opencode', [
      '{"type":"step_start","sessionID":"{{SESSION}}","part":{"type":"step-start"}}',
      '{"type":"text","sessionID":"{{SESSION}}","part":{"id":"p1","type":"text","text":"OK từ OpenCode"}}',
    ]);
    Object.assign(process.env, fakeCli.env);

    const sent: unknown[] = [];
    const identity = localIdentity('tester');
    // ChatService tạo sau, nhưng nhà cung cấp cần báo cho nó khi danh sách agent đổi.
    const ref: { chat?: ChatService } = {};
    const providers = setupProviders({
      cliAdapters: bundledCliAdapterFactories,
      userData,
      cipher,
      identity,
      audit: createFileAuditLog(join(userData, 'audit')),
      basePolicy: personalPolicy(),
      onAgentsChanged: (agents) => ref.chat?.setAdapters(agents),
      broadcast: (channel, payload) => sent.push({ channel, payload }),
      cliCommands: { opencode: { command: fakeCli.command, prefixArgs: fakeCli.prefixArgs } },
    });
    const events: ChatEvent[] = [];
    const chat = new ChatService({
      adapters: providers.agents(),
      identity,
      policy: providers.policy,
      audit: providers.audit,
      store: providers.wrapStore(createFileStore(join(userData, 'conversations.json'))),
      fallbackOrder: (id) => providers.hub.fallbackAgents(id),
      onEvent: (e) => {
        providers.onChatEvent(e);
        events.push(e);
        sent.push(e);
      },
    });
    ref.chat = chat;

    // 1. Dán key (đường IPC renderer → main).
    sent.push(await providers.handlers['providers:setKey']('deepseek', KEY));
    sent.push(await providers.handlers['providers:update']({ kind: 'budget', monthlyUsd: 5 }));
    sent.push(
      await providers.handlers['providers:update']({
        kind: 'pairing',
        cli: 'opencode',
        model: 'deepseek/deepseek-flash',
        on: true,
      }),
    );
    const agentIds = providers.agents().map((a: AgentAdapter) => a.id);
    expect(agentIds).toContain('api:deepseek/deepseek-flash');
    expect(agentIds).toContain('opencode+deepseek/deepseek-flash');

    const waitDone = (n: number) =>
      new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (events.filter((e) => e.event.type === 'done').length >= n) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - started > 15_000) {
            clearInterval(timer);
            reject(new Error('quá thời gian'));
          }
        }, 10);
      });

    // 2. Chat với model API (trả lời có key) rồi lượt hai (hãng lỗi có key).
    const first = await chat.send({
      agentId: 'api:deepseek/deepseek-flash',
      prompt: 'chào',
      cwd: userData,
    });
    expect(first.status).toBe('started');
    await waitDone(1);
    if (first.status !== 'started') throw new Error('không chạy');
    await chat.send({
      conversationId: first.conversationId,
      agentId: 'api:deepseek/deepseek-flash',
      prompt: 'tiếp',
    });
    await waitDone(2);

    // 3. CLI được cấp key (OpenCode giả).
    await chat.send({
      agentId: 'opencode+deepseek/deepseek-flash',
      prompt: 'xin chào',
      cwd: userData,
    });
    await waitDone(3);

    // 4. Việc nền, nút Kiểm tra (lỗi cũng có thể in key), xem màn hình Nhà cung cấp.
    sent.push(await providers.handlers['providers:tryTask']('background', 'Tóm tắt giúp tôi'));
    sent.push(await providers.handlers['providers:check']('deepseek'));
    sent.push(providers.handlers['providers:view']());

    // Đã có ghi chép thật (không phải test rỗng).
    const files = [...walk(userData), fakeCli.log];
    const names = files.map((f) => f.replace(userData, '').replace(/\\/g, '/'));
    for (const expected of [
      '/secrets.json',
      '/providers.json',
      '/conversations.json',
      '/api-sessions.json',
    ]) {
      expect(names).toContain(expected);
    }
    expect(names.some((n) => n.startsWith('/audit/'))).toBe(true);
    expect(names.some((n) => n.startsWith('/usage/'))).toBe(true);
    expect(readFileSync(fakeCli.log, 'utf8')).toContain('xin chào');

    // Key thật sự đã đi tới hãng (máy chủ giả) — nghĩa là test có dùng key.
    expect(server.requests.some((r) => r.headers['authorization'] === `Bearer ${KEY}`)).toBe(true);

    // ---- Quét
    const found: string[] = [];
    for (const file of files) {
      const text = readFileSync(file).toString('utf8');
      for (const form of leaks(text)) found.push(`${file}: ${form.slice(0, 8)}…`);
    }
    for (const form of leaks(JSON.stringify(sent)))
      found.push(`gửi lên giao diện: ${form.slice(0, 8)}…`);
    expect(found).toEqual([]);

    // Che key nhưng vẫn giữ nội dung còn lại.
    const conversations = readFileSync(join(userData, 'conversations.json'), 'utf8');
    expect(conversations).toContain('key của bạn là ••••zz99');
  }, 30_000);
});
