import { describe, expect, it } from 'vitest';
import { prepareFakeCli, runContract, type AgentEvent } from '@nsa/adapter-sdk';
import {
  buildOpenCodeArgs,
  createOpenCodeAdapter,
  createOpenCodeParser,
  openCodeGateConfig,
} from './index.js';

// Ghi từ `opencode run --format json --agent plan` thật (opencode 1.19.5, model opencode/big-pickle):
// đọc một file bằng công cụ read rồi trả lời. Rút gọn trường dài.
const SID = 'ses_e32499d94ffeD4b2CmYc7Ln8wR';
const RECORDED = [
  `{"type":"step_start","timestamp":1794452647569,"sessionID":"${SID}","part":{"id":"prt_1","messageID":"msg_1","sessionID":"${SID}","type":"step-start"}}`,
  `{"type":"tool_use","timestamp":1794452648060,"sessionID":"${SID}","part":{"type":"tool","tool":"read","callID":"call_00_un7g","state":{"status":"completed","input":{"filePath":"C:\\\\oc\\\\note.txt"},"output":"<content>\\n1: mật khẩu wifi là chuoi-bi-mat-42\\n</content>","title":"note.txt"},"id":"prt_2","sessionID":"${SID}","messageID":"msg_1"}}`,
  `{"type":"step_finish","timestamp":1794452648062,"sessionID":"${SID}","part":{"id":"prt_3","reason":"tool-calls","type":"step-finish","tokens":{"total":12890,"input":11001,"output":97,"reasoning":0,"cache":{"write":0,"read":1792}},"cost":0}}`,
  `{"type":"step_start","timestamp":1794452649397,"sessionID":"${SID}","part":{"id":"prt_4","type":"step-start"}}`,
  `{"type":"text","timestamp":1794452650445,"sessionID":"${SID}","part":{"id":"prt_5","type":"text","text":"The note says: \\"mật khẩu wifi là chuoi-bi-mat-42\\"."}}`,
  `{"type":"step_finish","timestamp":1794452650445,"sessionID":"${SID}","part":{"id":"prt_6","reason":"stop","type":"step-finish","tokens":{"total":13146,"input":332,"output":35,"reasoning":107,"cache":{"write":0,"read":12672}},"cost":0}}`,
];

function parseAll(lines: string[]): AgentEvent[] {
  const parse = createOpenCodeParser();
  return lines.flatMap((l) => parse(JSON.parse(l)));
}

describe('createOpenCodeParser', () => {
  it('chuyển đầu ra thật của opencode run thành sự kiện chuẩn, cộng dồn token qua các bước', () => {
    expect(parseAll(RECORDED)).toEqual([
      { type: 'session', sessionId: SID },
      { type: 'tool_call', id: 'call_00_un7g', name: 'read', input: 'C:\\oc\\note.txt' },
      {
        type: 'tool_result',
        id: 'call_00_un7g',
        output: '<content>\n1: mật khẩu wifi là chuoi-bi-mat-42\n</content>',
        isError: false,
      },
      { type: 'usage', inputTokens: 12793, outputTokens: 97 },
      { type: 'text', id: 'prt_5', text: 'The note says: "mật khẩu wifi là chuoi-bi-mat-42".' },
      { type: 'usage', inputTokens: 25797, outputTokens: 239 },
    ]);
  });

  it('lệnh bị plugin cổng chính sách chặn (ghi thật) → tool_result lỗi', () => {
    const events = parseAll([
      `{"type":"tool_use","sessionID":"${SID}","part":{"type":"tool","tool":"bash","callID":"c1","state":{"status":"error","input":{"command":"echo hi-oc"},"error":"NSA chặn thử"}}}`,
    ]);
    expect(events.slice(1)).toEqual([
      { type: 'tool_call', id: 'c1', name: 'bash', input: 'echo hi-oc' },
      { type: 'tool_result', id: 'c1', output: 'NSA chặn thử', isError: true },
    ]);
  });

  it('lỗi thật khi bản quá cũ cho model miễn phí → mã auth, kèm cách sửa', () => {
    const events = parseAll([
      `{"type":"error","sessionID":"${SID}","error":{"name":"APIError","data":{"message":"OpenCode 1.18.0 or newer is required to use the free tier","statusCode":426}}}`,
    ]);
    expect(events[1]).toMatchObject({ type: 'error', code: 'auth' });
    expect(events[1]?.type === 'error' && events[1].message).toContain('opencode upgrade');
  });
});

describe('buildOpenCodeArgs', () => {
  it('chỉ đọc → agent plan; sửa → build; resume bằng -s', () => {
    expect(buildOpenCodeArgs({ permission: 'read-only' })).toEqual([
      'run',
      '--format',
      'json',
      '--agent',
      'plan',
    ]);
    expect(buildOpenCodeArgs({ permission: 'edit', sessionId: SID }).slice(-4)).toEqual([
      '--agent',
      'build',
      '-s',
      SID,
    ]);
    expect(() => buildOpenCodeArgs({ permission: 'edit', sessionId: '--help' })).toThrow();
  });

  it('gộp plugin cổng vào cấu hình sẵn có của người dùng', () => {
    const merged = JSON.parse(
      openCodeGateConfig('C:\\t\\p.js', '{"model":"x/y","plugin":["a"]}'),
    ) as {
      model: string;
      plugin: string[];
    };
    expect(merged.model).toBe('x/y');
    expect(merged.plugin[0]).toBe('a');
    expect(merged.plugin[1]).toMatch(/^file:\/\/\/.*p\.js$/);
  });
});

describe('hợp đồng adapter (CLI giả)', () => {
  it('gửi, stdin, resume, huỷ, cổng chính sách', async () => {
    const fake = prepareFakeCli(
      'opencode',
      RECORDED.map((l) => l.split(SID).join('{{SESSION}}')),
    );
    Object.assign(process.env, fake.env);
    const adapter = createOpenCodeAdapter({ command: fake.command, prefixArgs: fake.prefixArgs });
    const results = await runContract(adapter, {
      mode: 'fake',
      cwd: process.cwd(),
      fakeLog: fake.log,
    });
    expect(results.filter((r) => r.status !== 'passed')).toEqual([]);
  }, 30_000);
});
