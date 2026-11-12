import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@nsa/adapter-sdk';
import { buildClaudeArgs, createClaudeParser } from './index.js';

function parseAll(lines: unknown[]): AgentEvent[] {
  const parse = createClaudeParser();
  return lines.flatMap((line) => parse(line));
}

const SID = '6c8860a0-a9dc-469c-b69e-743706b22249';

describe('createClaudeParser', () => {
  it('ghép văn bản stream từng phần và không lặp lại khi tin nhắn đầy đủ tới', () => {
    const events = parseAll([
      { type: 'system', subtype: 'init', session_id: SID },
      {
        type: 'stream_event',
        session_id: SID,
        parent_tool_use_id: null,
        event: { type: 'message_start', message: { id: 'msg_1' } },
      },
      {
        type: 'stream_event',
        session_id: SID,
        parent_tool_use_id: null,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Xin ' },
        },
      },
      {
        type: 'stream_event',
        session_id: SID,
        parent_tool_use_id: null,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'chào' },
        },
      },
      {
        type: 'assistant',
        session_id: SID,
        parent_tool_use_id: null,
        message: { id: 'msg_1', content: [{ type: 'text', text: 'Xin chào' }] },
      },
    ]);
    expect(events).toEqual([
      { type: 'session', sessionId: SID },
      { type: 'text', id: 'msg_1:0', text: 'Xin ' },
      { type: 'text', id: 'msg_1:0', text: 'chào' },
    ]);
  });

  it('chuyển tool_use / tool_result và tổng kết lượt', () => {
    const events = parseAll([
      {
        type: 'assistant',
        session_id: SID,
        parent_tool_use_id: null,
        message: {
          id: 'msg_2',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
        },
      },
      {
        type: 'user',
        session_id: SID,
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt', is_error: false },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: SID,
        total_cost_usd: 0.01,
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 0,
          output_tokens: 3,
        },
      },
    ]);
    expect(events).toEqual([
      { type: 'session', sessionId: SID },
      { type: 'tool_call', id: 'toolu_1', name: 'Bash', input: 'ls' },
      { type: 'tool_result', id: 'toolu_1', output: 'a.txt', isError: false },
      { type: 'usage', inputTokens: 15, outputTokens: 3, costUsd: 0.01 },
    ]);
  });

  it('bỏ qua tin nhắn của agent con', () => {
    const events = parseAll([
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_9',
        message: { id: 'm', content: [{ type: 'text', text: 'nội bộ' }] },
      },
    ]);
    expect(events).toEqual([]);
  });

  it('ghi từ CLI thật khi chưa đăng nhập: báo lỗi kèm cách sửa', () => {
    const events = parseAll([
      {
        type: 'assistant',
        session_id: SID,
        parent_tool_use_id: null,
        message: {
          id: 'e77d',
          model: '<synthetic>',
          content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: 'Not logged in · Please run /login',
        session_id: SID,
        total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    ]);
    const error = events.find((e) => e.type === 'error');
    expect(error).toEqual({
      type: 'error',
      message: 'Claude CLI chưa đăng nhập. Mở terminal, chạy "claude auth login" rồi thử lại.',
    });
  });
});

describe('buildClaudeArgs', () => {
  it('chỉ đọc → plan; cho sửa → acceptEdits; có resume', () => {
    expect(buildClaudeArgs({ permission: 'read-only' })).toContain('plan');
    const args = buildClaudeArgs({ permission: 'edit', sessionId: SID });
    expect(args).toContain('acceptEdits');
    expect(args.slice(-2)).toEqual(['--resume', SID]);
  });

  it('từ chối mã phiên lạ', () => {
    expect(() => buildClaudeArgs({ permission: 'edit', sessionId: 'x; rm -rf /' })).toThrow();
  });
});
