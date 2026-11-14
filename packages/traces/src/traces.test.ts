import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TraceQuery } from '@nsa/core';
import { createTraceIndex } from './index-store';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'nsa-traces-'));
  dirs.push(d);
  mkdirSync(join(d, 'audit'));
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const actor = { id: 'local:t', displayName: 't' };
let tick = 0;
function at(): string {
  return new Date(Date.UTC(2026, 10, 14, 8, 0, 0) + tick++ * 1000).toISOString();
}
function line(e: Record<string, unknown>): string {
  return `${JSON.stringify({ at: at(), actor, agentId: 'claude', ...e })}\n`;
}
const make = (root: string, extra: { redact?: (t: string) => string; batchLines?: number } = {}) =>
  createTraceIndex({
    auditDir: join(root, 'audit'),
    dbPath: join(root, 'x.sqlite'),
    ...extra,
  });

function turnLines(turnId: string, prompt = 'Báo giá cho khách Hòa'): string {
  const base = { conversationId: 'c1', turnId };
  return [
    line({ ...base, type: 'request', prompt, cwd: 'D:/x', permission: 'read-only' }),
    line({ ...base, type: 'policy', decision: 'allow', confirmed: false }),
    line({
      ...base,
      type: 'agent_event',
      event: { type: 'tool_call', id: 'k1', name: 'Bash', input: 'ls -la' },
    }),
    line({
      ...base,
      type: 'agent_event',
      event: { type: 'tool_result', id: 'k1', output: 'file-a\nfile-b', isError: false },
    }),
    line({
      ...base,
      type: 'agent_event',
      event: { type: 'usage', inputTokens: 100, outputTokens: 20, costUsd: 0.01 },
    }),
    line({ ...base, type: 'reply', text: 'Đã xong, báo giá 10 triệu' }),
    line({ ...base, type: 'agent_event', event: { type: 'done', cancelled: false } }),
  ].join('');
}

describe('Traces: dựng lượt từ nhật ký', () => {
  it('gom các dòng cùng turnId thành một lượt có bước, token, chi phí', async () => {
    const root = tmp();
    writeFileSync(join(root, 'audit', '2026-11.jsonl'), turnLines('T1'));
    const index = make(root);
    await index.sync();
    const { items, total } = index.list({});
    expect(total).toBe(1);
    const t = items[0]!;
    expect(t).toMatchObject({
      kind: 'turn',
      status: 'ok',
      toolCalls: 1,
      inputTokens: 100,
      outputTokens: 20,
      costUsd: 0.01,
      agentId: 'claude',
    });
    expect(t.title).toContain('Báo giá');
    const d = index.get(t.id)!;
    expect(d.steps.map((s) => s.kind)).toEqual([
      'request',
      'policy',
      'tool_call',
      'tool_result',
      'usage',
      'reply',
      'done',
    ]);
    expect(d.steps[2]?.detail).toBe('ls -la');
    index.close();
  });

  it('lượt lùi tầng / đổi agent và lượt bị chính sách chặn hiện đúng', async () => {
    const root = tmp();
    const base = { conversationId: 'c2', turnId: 'F' };
    writeFileSync(
      join(root, 'audit', '2026-11.jsonl'),
      [
        line({ ...base, type: 'request', prompt: 'làm đi', cwd: 'x', permission: 'edit' }),
        line({ ...base, type: 'policy', decision: 'allow', confirmed: true }),
        line({
          ...base,
          type: 'fallback',
          kind: 'agent',
          from: 'claude',
          to: 'opencode',
          reason: 'chưa đăng nhập',
        }),
        line({ ...base, agentId: 'opencode', type: 'reply', text: 'xong' }),
        line({
          ...base,
          agentId: 'opencode',
          type: 'agent_event',
          event: { type: 'done', cancelled: false },
        }),
        line({
          conversationId: 'c3',
          turnId: 'D',
          type: 'request',
          prompt: 'xoá',
          cwd: 'x',
          permission: 'edit',
        }),
        line({
          conversationId: 'c3',
          turnId: 'D',
          type: 'policy',
          decision: 'deny',
          confirmed: false,
          reason: 'nguy hiểm',
        }),
      ].join(''),
    );
    const index = make(root);
    await index.sync();
    const f = index.get('t:F')!;
    expect(f).toMatchObject({ fallbacks: 1, agentId: 'opencode', status: 'ok' });
    expect(f.agentIds).toEqual(['claude', 'opencode']);
    expect(index.get('t:D')).toMatchObject({ status: 'denied', policyFlags: 1 });
    index.close();
  });

  it('đọc tăng dần: chỉ đọc phần mới, dòng ghi dở để lần sau', async () => {
    const root = tmp();
    const file = join(root, 'audit', '2026-11.jsonl');
    writeFileSync(file, turnLines('T1'));
    const index = make(root);
    await index.sync();
    appendFileSync(file, turnLines('T2', 'Việc thứ hai'));
    appendFileSync(file, '{"at":"2026-11-14T09:00:00.000Z","actor"'); // dòng ghi dở
    await index.sync();
    expect(index.list({}).total).toBe(2);
    appendFileSync(
      file,
      ':{"id":"local:t","displayName":"t"},"agentId":"claude","type":"reply","text":"tiếp","turnId":"T2","conversationId":"c1"}\n',
    );
    await index.sync();
    expect(index.list({}).total).toBe(2);
    const second = index.list({ text: 'thu hai' }).items[0]!;
    expect(index.get(second.id)?.steps.at(-1)?.kind).toBe('reply');
    index.close();
  });

  it('file cũ không có turnId vẫn đọc được: dòng không thuộc Traces bị bỏ qua, không lỗi', async () => {
    const root = tmp();
    writeFileSync(
      join(root, 'audit', '2026-10.jsonl'),
      [
        line({ type: 'request', prompt: 'cũ', cwd: 'x', permission: 'read-only' }),
        line({ type: 'memory', op: 'propose', by: 'agent', decision: 'allow' }),
        'không phải json\n',
        line({
          type: 'plugin',
          op: 'job',
          pluginId: 'scheduler',
          decision: 'allow',
          detail: 'việc "x" xong',
        }),
      ].join(''),
    );
    const index = make(root);
    await index.sync();
    expect(index.list({}).items.map((i) => i.kind)).toEqual(['plugin']);
    expect(index.list({ pluginId: 'scheduler' }).total).toBe(1);
    index.close();
  });

  it('lọc theo ngày, agent, trạng thái; tìm chữ không phân biệt dấu', async () => {
    const root = tmp();
    const base = { conversationId: 'c1', agentId: 'opencode' };
    writeFileSync(
      join(root, 'audit', '2026-11.jsonl'),
      turnLines('A') +
        [
          line({
            ...base,
            turnId: 'B',
            type: 'request',
            prompt: 'lỗi thử',
            cwd: 'x',
            permission: 'read-only',
          }),
          line({
            ...base,
            turnId: 'B',
            type: 'agent_event',
            event: { type: 'error', message: 'hết hạn mức', code: 'cli' },
          }),
          line({
            ...base,
            turnId: 'B',
            type: 'agent_event',
            event: { type: 'done', cancelled: false },
          }),
        ].join(''),
    );
    const index = make(root);
    await index.sync();
    const q = (x: TraceQuery): string[] => index.list(x).items.map((i) => i.id);
    expect(q({ agentId: 'opencode' })).toEqual(['t:B']);
    expect(q({ status: 'error' })).toEqual(['t:B']);
    expect(q({ text: 'khach hoa' })).toEqual(['t:A']);
    expect(q({ text: 'HET HAN MUC' })).toEqual(['t:B']);
    expect(q({ from: '2026-11-15' })).toEqual([]);
    expect(q({ from: '2026-11-14', to: '2026-11-14' }).length).toBe(2);
    expect(index.filters().agents).toEqual(['claude', 'opencode']);
    index.close();
  });

  it('file lớn: dựng chỉ mục nhường luồng, không chặn hàng đợi sự kiện', async () => {
    const root = tmp();
    const parts: string[] = [];
    for (let i = 0; i < 3_000; i++) parts.push(turnLines(`L${i}`, `việc số ${i}`));
    writeFileSync(join(root, 'audit', '2026-11.jsonl'), parts.join(''));
    const index = make(root, { batchLines: 500 });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    await index.sync();
    clearInterval(timer);
    expect(index.list({}).total).toBe(3_000);
    expect(ticks).toBeGreaterThan(2); // giữa các lô luồng chính vẫn chạy được
    expect(index.list({ text: 'viec so 2999' }).total).toBe(1);
    index.close();
  }, 60_000);

  it('xoá chỉ mục thì dựng lại từ nhật ký; xoá nhật ký thì chỉ mục theo; chỉ mục hỏng thì bỏ đi', async () => {
    const root = tmp();
    const file = join(root, 'audit', '2026-11.jsonl');
    writeFileSync(file, turnLines('T1'));
    let index = make(root);
    await index.sync();
    index.close();
    rmSync(join(root, 'x.sqlite'), { force: true });
    index = make(root);
    await index.sync();
    expect(index.list({}).total).toBe(1);
    rmSync(file);
    await index.sync();
    expect(index.list({}).total).toBe(0);
    index.close();
    writeFileSync(join(root, 'x.sqlite'), 'không phải sqlite');
    writeFileSync(file, turnLines('T9'));
    index = make(root);
    await index.sync();
    expect(index.list({}).total).toBe(1);
    index.close();
  });

  it('bí mật không hiện trong Traces: che khi vào chỉ mục, khi đọc ra, và trong file SQLite', async () => {
    const KEY = 'sk-nsa-TRACE-1234567890abcdef';
    const root = tmp();
    const base = { conversationId: 'c1', turnId: 'S' };
    writeFileSync(
      join(root, 'audit', '2026-11.jsonl'),
      [
        line({
          ...base,
          type: 'request',
          prompt: `dùng ${KEY} đi`,
          cwd: 'x',
          permission: 'read-only',
        }),
        line({
          ...base,
          type: 'agent_event',
          event: {
            type: 'tool_call',
            id: '1',
            name: 'Bash',
            input: `curl -H "Authorization: ${KEY}"`,
          },
        }),
        line({
          ...base,
          type: 'agent_event',
          event: { type: 'error', message: `401 ${KEY}`, code: 'cli' },
        }),
        line({ ...base, type: 'reply', text: `key là ${KEY}` }),
      ].join(''),
    );
    const redact = (t: string): string => t.split(KEY).join('…cdef');
    const index = make(root, { redact });
    await index.sync();
    const all = JSON.stringify([index.list({}), index.get('t:S')]);
    expect(all).not.toContain(KEY);
    expect(all).toContain('…cdef');
    expect(index.list({ text: 'sk-nsa-trace' }).total).toBe(0);
    index.close();
    expect(readFileSync(join(root, 'x.sqlite')).toString('latin1')).not.toContain(KEY);
  });
});
