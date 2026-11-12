import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@nsa/adapter-sdk';
import { buildCodexArgs, createCodexParser } from './index.js';

// Ghi từ `codex exec --json` thật (codex-cli 0.167.2) khi yêu cầu chạy một lệnh shell.
const RECORDED = [
  '{"type":"thread.started","thread_id":"01a1cd85-cd58-7d83-8048-ce256e30a64b"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Tôi sẽ chạy lệnh và báo kết quả.\\n"}}',
  '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"powershell.exe -Command \'echo hello-nsa\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"powershell.exe -Command \'echo hello-nsa\'","aggregated_output":"hello-nsa\\r\\n","exit_code":0,"status":"completed"}}',
  '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Kết quả: `hello-nsa`"}}',
  '{"type":"turn.completed","usage":{"input_tokens":46652,"cached_input_tokens":36864,"cache_write_input_tokens":0,"output_tokens":66,"reasoning_output_tokens":0}}',
];

function parseAll(lines: string[]): AgentEvent[] {
  const parse = createCodexParser();
  return lines.flatMap((line) => parse(JSON.parse(line)));
}

describe('createCodexParser', () => {
  it('chuyển đầu ra thật của codex exec thành sự kiện chuẩn', () => {
    expect(parseAll(RECORDED)).toEqual([
      { type: 'session', sessionId: '01a1cd85-cd58-7d83-8048-ce256e30a64b' },
      { type: 'text', id: 'item_0', text: 'Tôi sẽ chạy lệnh và báo kết quả.\n' },
      {
        type: 'tool_call',
        id: 'item_1',
        name: 'shell',
        input: "powershell.exe -Command 'echo hello-nsa'",
      },
      { type: 'tool_result', id: 'item_1', output: 'hello-nsa\r\n', isError: false },
      { type: 'text', id: 'item_2', text: 'Kết quả: `hello-nsa`' },
      { type: 'usage', inputTokens: 46652, outputTokens: 66 },
    ]);
  });

  it('báo lỗi khi lượt thất bại', () => {
    const events = parseAll(['{"type":"turn.failed","error":{"message":"stream disconnected"}}']);
    expect(events).toEqual([{ type: 'error', message: 'stream disconnected' }]);
  });

  it('gợi ý đăng nhập khi lỗi xác thực', () => {
    const [event] = parseAll(['{"type":"error","message":"401 Unauthorized"}']);
    expect(event?.type === 'error' && event.message).toContain('codex login');
  });

  it('bỏ qua dòng không hiểu', () => {
    expect(parseAll(['{"type":"something.new"}', '[]'])).toEqual([]);
  });
});

describe('buildCodexArgs', () => {
  it('lượt đầu: exec, sandbox chỉ đọc, prompt qua stdin', () => {
    expect(buildCodexArgs({ permission: 'read-only' })).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-c',
      'sandbox_mode="read-only"',
      '-',
    ]);
  });

  it('lượt sau: resume theo mã phiên, cho sửa file', () => {
    const args = buildCodexArgs({ permission: 'edit', sessionId: '01a1cd85-cd58-7d83' });
    expect(args.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(args).toContain('sandbox_mode="workspace-write"');
    expect(args.slice(-2)).toEqual(['01a1cd85-cd58-7d83', '-']);
  });

  it('từ chối mã phiên lạ (chống chèn tham số)', () => {
    expect(() =>
      buildCodexArgs({ permission: 'edit', sessionId: '--dangerously-bypass' }),
    ).toThrow();
  });
});
