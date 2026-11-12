import { describe, expect, it } from 'vitest';
import { prepareFakeCli, runContract, type AgentEvent } from '@nsa/adapter-sdk';
import {
  antigravityInput,
  buildAntigravityArgs,
  createAntigravityAdapter,
  createAntigravityParser,
} from './index.js';

// Dựng theo tài liệu antigravity.google/docs/cli/headless — CHƯA ghi được từ CLI thật.
const CID = 'conv-7f3a9b2c4d5e';
const DOC_SHAPED = [
  `{"event":"init","conversation_id":"${CID}","init":{"cwd":"D:/p","tools":["run_command"],"permission_mode":"plan"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":0,"state":"DONE","step_type":"user_input"}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":1,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"command":"ls"}}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":1,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"command":"ls"},"output":"a.txt"}}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"Có "}}`,
  `{"event":"step_update","step_update":{"conversation_id":"${CID}","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"a.txt"}}`,
  `{"event":"result","result":{"conversation_id":"${CID}","status":"SUCCESS","response":"Có a.txt","usage":{"input_tokens":50,"output_tokens":5,"thinking_tokens":3,"cache_read_tokens":10}}}`,
];

describe('createAntigravityParser (theo tài liệu)', () => {
  it('chuyển init / step_update / result thành sự kiện chuẩn', () => {
    const parse = createAntigravityParser();
    const events: AgentEvent[] = DOC_SHAPED.flatMap((l) => parse(JSON.parse(l)));
    expect(events).toEqual([
      { type: 'session', sessionId: CID },
      { type: 'tool_call', id: 'step1', name: 'run_command', input: 'ls' },
      { type: 'tool_result', id: 'step1', output: 'a.txt', isError: false },
      { type: 'text', id: 'step2', text: 'Có ' },
      { type: 'text', id: 'step2', text: 'a.txt' },
      { type: 'usage', inputTokens: 60, outputTokens: 8 },
    ]);
  });

  it('trạng thái khác SUCCESS → lỗi', () => {
    const parse = createAntigravityParser();
    const events = parse({
      event: 'result',
      result: { status: 'ERROR', error: { message: 'hỏng' } },
    });
    expect(events.at(-1)).toEqual({ type: 'error', code: 'cli', message: 'hỏng' });
  });
});

describe('tham số Antigravity', () => {
  it('prompt đi qua stdin dạng stream-json, không nằm trong tham số', () => {
    const args = buildAntigravityArgs({ permission: 'read-only', sessionId: CID });
    expect(args).toEqual([
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--mode',
      'plan',
      '--conversation',
      CID,
    ]);
    expect(JSON.parse(antigravityInput('xin "chào"'))).toEqual({
      event: 'user',
      message: { content: 'xin "chào"' },
    });
  });
});

describe('hợp đồng adapter (CLI giả)', () => {
  it('gửi, stdin, resume, huỷ', async () => {
    const fake = prepareFakeCli(
      'antigravity',
      DOC_SHAPED.map((l) => l.split(CID).join('{{SESSION}}')),
    );
    Object.assign(process.env, fake.env);
    const adapter = createAntigravityAdapter({
      command: fake.command,
      prefixArgs: fake.prefixArgs,
    });
    const results = await runContract(adapter, {
      mode: 'fake',
      cwd: process.cwd(),
      fakeLog: fake.log,
    });
    expect(results.filter((r) => r.status === 'failed')).toEqual([]);
  }, 30_000);
});
