import { describe, expect, it } from 'vitest';
import { prepareFakeCli, runContract, type AgentEvent } from '@nsa/adapter-sdk';
import {
  buildGeminiArgs,
  createGeminiAdapter,
  createGeminiParser,
  geminiExitEvents,
} from './index.js';

// Dựng theo tài liệu headless của Gemini CLI — CHƯA ghi được từ CLI thật (chưa đăng nhập).
const SID = 'c3a4c1f0-1234-4abc-9def-0123456789ab';
const DOC_SHAPED = [
  `{"type":"init","timestamp":"2026-11-12T03:00:00Z","session_id":"${SID}","model":"gemini-3-pro"}`,
  `{"type":"message","role":"user","content":"đọc README","timestamp":"t"}`,
  `{"type":"tool_use","tool_name":"read_file","tool_id":"t1","parameters":{"absolute_path":"D:/p/README.md"},"timestamp":"t"}`,
  `{"type":"tool_result","tool_id":"t1","status":"success","output":"# Dự án","timestamp":"t"}`,
  `{"type":"message","role":"assistant","content":"README nói ","delta":true,"timestamp":"t"}`,
  `{"type":"message","role":"assistant","content":"về dự án.","delta":true,"timestamp":"t"}`,
  `{"type":"result","status":"success","stats":{"total_tokens":120,"input_tokens":100,"output_tokens":20},"timestamp":"t"}`,
];

describe('createGeminiParser (theo tài liệu)', () => {
  it('chuyển các loại sự kiện stream-json thành sự kiện chuẩn', () => {
    const parse = createGeminiParser();
    const events: AgentEvent[] = DOC_SHAPED.flatMap((l) => parse(JSON.parse(l)));
    expect(events).toEqual([
      { type: 'session', sessionId: SID },
      { type: 'tool_call', id: 't1', name: 'read_file', input: 'D:/p/README.md' },
      { type: 'tool_result', id: 't1', output: '# Dự án', isError: false },
      { type: 'text', id: 'm1', text: 'README nói ' },
      { type: 'text', id: 'm1', text: 'về dự án.' },
      { type: 'usage', inputTokens: 100, outputTokens: 20 },
    ]);
  });
});

describe('Gemini — lỗi thật khi chưa đăng nhập', () => {
  it('mã thoát 41 + thông báo "set an Auth method" (ghi từ gemini-cli 0.68.0) → lỗi auth', () => {
    const stderr =
      'Approval mode overridden to "default" because the current folder is not trusted.\n' +
      'Please set an Auth method in your C:\\Users\\x\\.gemini\\settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA';
    expect(geminiExitEvents(41, stderr)).toEqual([
      expect.objectContaining({ type: 'error', code: 'auth' }),
    ]);
  });

  it('tham số: headless, prompt qua stdin, chỉ đọc = plan, resume', () => {
    expect(buildGeminiArgs({ permission: 'read-only' })).toEqual([
      '-p',
      '',
      '--output-format',
      'stream-json',
      '--skip-trust',
      '--approval-mode',
      'plan',
    ]);
    expect(buildGeminiArgs({ permission: 'edit', sessionId: SID }).slice(-3)).toEqual([
      'auto_edit',
      '--resume',
      SID,
    ]);
  });
});

describe('hợp đồng adapter (CLI giả)', () => {
  it('gửi, stdin, resume, huỷ', async () => {
    const fake = prepareFakeCli(
      'gemini',
      DOC_SHAPED.map((l) => l.split(SID).join('{{SESSION}}')),
    );
    Object.assign(process.env, fake.env);
    const adapter = createGeminiAdapter({ command: fake.command, prefixArgs: fake.prefixArgs });
    const results = await runContract(adapter, {
      mode: 'fake',
      cwd: process.cwd(),
      fakeLog: fake.log,
    });
    expect(results.filter((r) => r.status === 'failed')).toEqual([]);
    expect(results.find((r) => r.step === 'gate')?.status).toBe('skipped');
  }, 30_000);
});
