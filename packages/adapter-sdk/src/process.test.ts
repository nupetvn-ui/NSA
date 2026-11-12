import { describe, expect, it } from 'vitest';
import type { AgentEvent } from './events.js';
import { runJsonLinesProcess, truncate } from './process.js';

// Một "CLI giả" bằng chính Node: đọc stdin, in vài dòng JSON, rồi thoát với mã cho trước.
const FAKE_CLI = `
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  console.log('log thường, không phải JSON');
  console.log(JSON.stringify({ kind: 'echo', text: input }));
  console.error('cảnh báo trên stderr');
  process.exit(Number(process.argv[1] ?? 0));
});
`;

function run(exitCode: number, stdin: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const handle = runJsonLinesProcess(
    {
      command: process.execPath,
      args: ['-e', FAKE_CLI, String(exitCode)],
      cwd: process.cwd(),
      stdin,
      parseLine: (json) => {
        const j = json as { kind: string; text: string };
        return j.kind === 'echo' ? [{ type: 'text', id: 't', text: j.text }] : [];
      },
      onExit: ({ code, stderr }) =>
        code === 0 ? [] : [{ type: 'error', message: `thoát ${code}: ${stderr.trim()}` }],
    },
    (e) => events.push(e),
  );
  return handle.finished.then(() => events);
}

describe('runJsonLinesProcess', () => {
  it('gửi prompt qua stdin, bỏ dòng không phải JSON, kết thúc bằng done', async () => {
    const events = await run(0, 'xin chào "có ngoặc" & ký tự đặc biệt');
    expect(events).toEqual([
      { type: 'text', id: 't', text: 'xin chào "có ngoặc" & ký tự đặc biệt' },
      { type: 'done', cancelled: false },
    ]);
  });

  it('báo lỗi kèm stderr khi CLI thoát với mã khác 0', async () => {
    const events = await run(3, 'x');
    expect(events.at(-2)).toEqual({ type: 'error', message: 'thoát 3: cảnh báo trên stderr' });
    expect(events.at(-1)).toEqual({ type: 'done', cancelled: false });
  });

  it('báo lỗi dễ hiểu khi không tìm thấy lệnh', async () => {
    const events: AgentEvent[] = [];
    await runJsonLinesProcess(
      { command: 'nsa-lenh-khong-ton-tai', args: [], cwd: process.cwd(), parseLine: () => [] },
      (e) => events.push(e),
    ).finished;
    expect(events.at(-1)).toEqual({ type: 'done', cancelled: false });
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('huỷ được lượt đang chạy', async () => {
    const events: AgentEvent[] = [];
    const handle = runJsonLinesProcess(
      {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: process.cwd(),
        parseLine: () => [],
      },
      (e) => events.push(e),
    );
    setTimeout(() => handle.cancel(), 200);
    await handle.finished;
    expect(events).toEqual([{ type: 'done', cancelled: true }]);
  });
});

describe('truncate', () => {
  it('giữ nguyên chuỗi ngắn, lược giữa chuỗi dài', () => {
    expect(truncate('abc', 10)).toBe('abc');
    const long = truncate('a'.repeat(50) + 'b'.repeat(50), 20);
    expect(long.startsWith('a'.repeat(10))).toBe(true);
    expect(long.endsWith('b'.repeat(10))).toBe(true);
  });
});
