import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@nsa/adapter-sdk';
import { createPtyAdapter, loadPty } from './index.js';

function collect(adapter: ReturnType<typeof createPtyAdapter>, prompt: string, cancelMs?: number) {
  const events: AgentEvent[] = [];
  const run = adapter.run({ prompt, cwd: process.cwd(), permission: 'read-only' }, (e) =>
    events.push(e),
  );
  if (cancelMs !== undefined) setTimeout(() => run.cancel(), cancelMs);
  return run.finished.then(() => events);
}

const text = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');

// CLI "chế độ in" giả: đọc stdin, in hoa lại, có màu ANSI.
const ECHO = `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{process.stdout.write('\\x1b[32m'+s.toUpperCase()+'\\x1b[0m\\r\\n');process.exit(Number(process.argv[1]||0))});`;

describe('adapter PTY — chế độ stdin (văn bản thô)', () => {
  const adapter = (exit = 0) =>
    createPtyAdapter({
      id: 'echo',
      displayName: 'Echo',
      command: process.execPath,
      args: () => ['-e', ECHO, String(exit)],
      input: 'stdin',
    });

  it('gửi prompt qua stdin, bỏ mã màu, kết thúc bằng done', async () => {
    const events = await collect(adapter(), 'xin chào "a & b"');
    expect(text(events)).toBe('XIN CHÀO "A & B"\n');
    expect(events.at(-1)).toEqual({ type: 'done', cancelled: false });
    expect(adapter().capabilities().tier).toBe('pty');
  });

  it('CLI thoát mã khác 0 thì báo lỗi; không có lệnh thì báo chưa cài', async () => {
    const failed = await collect(adapter(2), 'x');
    expect(failed.some((e) => e.type === 'error' && e.code === 'cli')).toBe(true);
    const missing = createPtyAdapter({
      id: 'x',
      displayName: 'X',
      command: 'nsa-khong-co-lenh-nay',
      args: () => [],
      input: 'stdin',
    });
    const events = await collect(missing, 'x');
    expect(events.some((e) => e.type === 'error' && e.code === 'not_installed')).toBe(true);
    expect(events.at(-1)?.type).toBe('done');
  });
});

describe('adapter PTY — chế độ gõ vào terminal giả', async () => {
  const available = (await loadPty()) !== null;

  it.runIf(available)(
    'gõ prompt vào REPL của Node và đọc kết quả trên màn hình',
    async () => {
      const repl = createPtyAdapter({
        id: 'node-repl',
        displayName: 'Node REPL',
        command: process.execPath,
        args: () => ['-i'],
        input: 'type',
        startupMs: 800,
        doneWhen: /4242/,
      });
      const events = await collect(repl, '4200 + 42');
      expect(text(events)).toContain('4242');
      expect(events.at(-1)).toEqual({ type: 'done', cancelled: false });
    },
    20_000,
  );

  it.runIf(available)(
    'huỷ được phiên terminal giả',
    async () => {
      const repl = createPtyAdapter({
        id: 'node-repl',
        displayName: 'Node REPL',
        command: process.execPath,
        args: () => ['-i'],
        input: 'type',
        idleMs: 60_000,
      });
      const events = await collect(repl, 'setInterval(()=>{},1000)', 2_500);
      expect(events.at(-1)).toEqual({ type: 'done', cancelled: true });
    },
    20_000,
  );
});
