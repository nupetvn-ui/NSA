/**
 * Bộ test hợp đồng — chạy được với MỌI adapter (nguyên tắc 6 của PLAN.md).
 *
 * Hai chế độ:
 * - `fake`: adapter gọi một CLI giả (Node đọc stdin, in lại các dòng ghi từ CLI thật, ghi lại
 *   tham số nhận được). Chạy trong mọi lần `pnpm test`, không cần mạng hay đăng nhập.
 * - `live`: gọi CLI thật trên máy (hoặc trên CI hằng đêm). Bước nào cần đăng nhập mà máy
 *   chưa có thì trả về `skipped` kèm lý do — KHÔNG coi là đã qua.
 *
 * Không phụ thuộc framework test: mỗi bước trả về `passed` / `failed` / `skipped`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter, RunOptions } from './adapter.js';
import type { AgentEvent } from './events.js';
import { ToolGateServer, type ToolCallRequest } from './gate.js';

export type ContractStatus = 'passed' | 'failed' | 'skipped';

export interface ContractResult {
  step: 'send' | 'resume' | 'cancel' | 'stdin' | 'gate';
  status: ContractStatus;
  detail: string;
}

export interface ContractOptions {
  mode: 'fake' | 'live';
  cwd: string;
  /** Chế độ fake: file CLI giả ghi tham số + stdin + biến môi trường đã nhận (JSON Lines). */
  fakeLog?: string;
  /** Giới hạn thời gian mỗi lượt (ms). */
  timeoutMs?: number;
}

/** Từ khoá khiến CLI giả chạy mãi (để thử huỷ). */
export const FAKE_SLOW = 'NSA_SLOW';
/** Mã phiên mà CLI giả thay vào chỗ `{{SESSION}}` trong bản ghi. */
export const FAKE_SESSION = 'a1b2c3d4-0000-4000-8000-00000000c0de';

const LIVE_PROMPT = 'Reply with exactly the word NSA-OK and nothing else.';
const LIVE_RESUME =
  'What single word did you reply with in your previous message? Reply with only that word.';
const LIVE_SLOW = 'Count from 1 to 400, one number per line, no other text.';
const LIVE_GATE =
  'Use your shell tool to run exactly this command: echo NSA-GATE-CHECK . Then report what happened.';

interface Collected {
  events: AgentEvent[];
  timedOut: boolean;
}

function collect(
  adapter: AgentAdapter,
  options: RunOptions,
  timeoutMs: number,
  cancelAfterMs?: number,
): Promise<Collected> {
  const events: AgentEvent[] = [];
  const run = adapter.run(options, (e) => events.push(e));
  let timedOut = false;
  const timers: NodeJS.Timeout[] = [];
  if (cancelAfterMs !== undefined) timers.push(setTimeout(() => run.cancel(), cancelAfterMs));
  timers.push(
    setTimeout(() => {
      timedOut = true;
      run.cancel();
    }, timeoutMs),
  );
  return run.finished.then(() => {
    timers.forEach(clearTimeout);
    return { events, timedOut };
  });
}

/** Kiểm các bất biến của luồng sự kiện; trả về mô tả lỗi hoặc null. */
export function checkEventStream(events: AgentEvent[]): string | null {
  const dones = events.filter((e) => e.type === 'done');
  if (dones.length !== 1) return `phải có đúng 1 sự kiện done, có ${dones.length}`;
  if (events.at(-1)?.type !== 'done') return 'done phải là sự kiện cuối cùng';
  return null;
}

const textOf = (events: AgentEvent[]): string =>
  events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');
const errorsOf = (events: AgentEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'error' ? [e.message] : []));
const AUTH = (events: AgentEvent[]): boolean =>
  events.some((e) => e.type === 'error' && (e.code === 'auth' || e.code === 'not_installed'));

interface FakeLogEntry {
  argv: string[];
  stdin: string;
  gateUrl: string | null;
}

function readFakeLog(file: string | undefined): FakeLogEntry[] {
  if (!file) return [];
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as FakeLogEntry);
  } catch {
    return [];
  }
}

export async function runContract(
  adapter: AgentAdapter,
  options: ContractOptions,
): Promise<ContractResult[]> {
  const caps = adapter.capabilities();
  const timeoutMs = options.timeoutMs ?? (options.mode === 'live' ? 240_000 : 15_000);
  const live = options.mode === 'live';
  const base: RunOptions = { prompt: '', cwd: options.cwd, permission: 'read-only' };
  const results: ContractResult[] = [];

  if (live) {
    const detected = await adapter.detect();
    if (!detected.installed || !detected.ready) {
      const why = detected.note ?? (detected.installed ? 'chưa sẵn sàng' : 'chưa cài');
      for (const step of ['send', 'resume', 'cancel', 'gate'] as const) {
        results.push({ step, status: 'skipped', detail: `${adapter.displayName}: ${why}` });
      }
      return results;
    }
  }

  // ---- 1. Gửi prompt, nhận sự kiện
  const special = `NSA-PING "ngoặc" & | > %PATH% $(whoami) ; xuống\ndòng`;
  const first = await collect(
    adapter,
    { ...base, prompt: live ? LIVE_PROMPT : special },
    timeoutMs,
  );
  const sessionEvent = first.events.find((e) => e.type === 'session');
  const sessionId = sessionEvent?.type === 'session' ? sessionEvent.sessionId : undefined;
  {
    const problem = checkEventStream(first.events);
    const errors = errorsOf(first.events);
    if (live && AUTH(first.events)) {
      const detail = `cần đăng nhập: ${errors.join('; ')}`;
      for (const step of ['send', 'resume', 'cancel', 'gate'] as const) {
        results.push({ step, status: 'skipped', detail });
      }
      return results;
    } else if (problem || first.timedOut) {
      results.push({ step: 'send', status: 'failed', detail: problem ?? 'quá thời gian' });
    } else if (errors.length > 0) {
      results.push({ step: 'send', status: 'failed', detail: `lỗi: ${errors.join('; ')}` });
    } else if (!textOf(first.events).trim()) {
      results.push({ step: 'send', status: 'failed', detail: 'không nhận được văn bản trả lời' });
    } else if (live && !textOf(first.events).includes('NSA-OK')) {
      results.push({
        step: 'send',
        status: 'failed',
        detail: `trả lời không chứa NSA-OK: ${textOf(first.events).slice(0, 200)}`,
      });
    } else if (caps.resume && !sessionId) {
      results.push({
        step: 'send',
        status: 'failed',
        detail: 'khai báo resume nhưng không có mã phiên',
      });
    } else {
      results.push({ step: 'send', status: 'passed', detail: `${first.events.length} sự kiện` });
    }
  }

  // ---- 2. Prompt đi qua stdin, không lọt vào tham số dòng lệnh (chỉ kiểm được ở chế độ fake)
  if (!live) {
    const entry = readFakeLog(options.fakeLog)[0];
    if (!entry) {
      results.push({ step: 'stdin', status: 'failed', detail: 'CLI giả không ghi được nhật ký' });
    } else if (entry.argv.some((a) => a.includes('NSA-PING'))) {
      results.push({
        step: 'stdin',
        status: 'failed',
        detail: 'prompt nằm trong tham số dòng lệnh',
      });
    } else if (
      !entry.stdin.includes(special) &&
      !entry.stdin.includes(JSON.stringify(special).slice(1, -1))
    ) {
      results.push({
        step: 'stdin',
        status: 'failed',
        detail: 'stdin không chứa nguyên văn prompt',
      });
    } else {
      results.push({ step: 'stdin', status: 'passed', detail: 'prompt nguyên văn qua stdin' });
    }
  }

  // ---- 3. Tiếp tục phiên
  if (!caps.resume) {
    results.push({
      step: 'resume',
      status: 'skipped',
      detail: 'adapter khai báo không hỗ trợ resume',
    });
  } else if (!sessionId) {
    results.push({ step: 'resume', status: 'skipped', detail: 'bước gửi chưa có mã phiên' });
  } else {
    const second = await collect(
      adapter,
      { ...base, prompt: live ? LIVE_RESUME : 'tiếp tục', sessionId },
      timeoutMs,
    );
    const problem = checkEventStream(second.events) ?? (second.timedOut ? 'quá thời gian' : null);
    const errors = errorsOf(second.events);
    const argv = readFakeLog(options.fakeLog).at(-1)?.argv ?? [];
    if (problem || errors.length) {
      results.push({ step: 'resume', status: 'failed', detail: problem ?? errors.join('; ') });
    } else if (!live && !argv.includes(sessionId)) {
      results.push({
        step: 'resume',
        status: 'failed',
        detail: 'mã phiên không được truyền cho CLI',
      });
    } else if (live && !textOf(second.events).includes('NSA-OK')) {
      results.push({
        step: 'resume',
        status: 'failed',
        detail: `agent không nhớ lượt trước: ${textOf(second.events).slice(0, 200)}`,
      });
    } else {
      results.push({ step: 'resume', status: 'passed', detail: 'giữ được ngữ cảnh' });
    }
  }

  // ---- 4. Huỷ
  {
    const started = Date.now();
    const cancelled = await collect(
      adapter,
      { ...base, prompt: live ? LIVE_SLOW : FAKE_SLOW },
      timeoutMs,
      live ? 4_000 : 500,
    );
    const done = cancelled.events.at(-1);
    const problem = checkEventStream(cancelled.events);
    if (problem) {
      results.push({ step: 'cancel', status: 'failed', detail: problem });
    } else if (done?.type === 'done' && !done.cancelled) {
      // CLI thật trả lời xong trước khi kịp huỷ: không chứng minh được gì.
      results.push({
        step: 'cancel',
        status: live ? 'skipped' : 'failed',
        detail: 'lượt kết thúc trước khi kịp huỷ',
      });
    } else if (cancelled.timedOut) {
      results.push({ step: 'cancel', status: 'failed', detail: 'huỷ không dừng được tiến trình' });
    } else {
      results.push({
        step: 'cancel',
        status: 'passed',
        detail: `dừng sau ${Date.now() - started}ms`,
      });
    }
  }

  // ---- 5. Cổng chính sách từng lệnh
  if (!caps.toolGate) {
    results.push({
      step: 'gate',
      status: 'skipped',
      detail: 'CLI không có móc chặn từng lệnh (xem ADR-0007)',
    });
  } else {
    const gate = await ToolGateServer.start();
    const seen: ToolCallRequest[] = [];
    const { endpoint, dispose } = gate.register((request) => {
      seen.push(request);
      return Promise.resolve({ allow: false, reason: 'NSA contract: chặn thử' });
    });
    try {
      const gated = await collect(
        adapter,
        { ...base, prompt: live ? LIVE_GATE : 'gate', gate: endpoint, permission: 'edit' },
        timeoutMs,
      );
      const problem = checkEventStream(gated.events);
      const entry = readFakeLog(options.fakeLog).at(-1);
      if (problem) {
        results.push({ step: 'gate', status: 'failed', detail: problem });
      } else if (!live && entry?.gateUrl !== endpoint.url) {
        results.push({
          step: 'gate',
          status: 'failed',
          detail: 'adapter không chuyển địa chỉ cổng cho CLI',
        });
      } else if (live && seen.length === 0) {
        results.push({ step: 'gate', status: 'failed', detail: 'CLI chạy lệnh mà không hỏi cổng' });
      } else {
        results.push({
          step: 'gate',
          status: 'passed',
          detail: live ? `cổng chặn ${seen.length} lệnh` : 'địa chỉ cổng được gắn vào CLI',
        });
      }
    } finally {
      dispose();
      await gate.close();
    }
  }

  return results;
}

// ------------------------------------------------------------------ CLI giả

const FAKE_CLI = String.raw`'use strict';
const fs = require('fs');
const [fixture] = process.argv.slice(2);
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const log = process.env.NSA_FAKE_LOG;
  if (log) fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(3), stdin,
    gateUrl: process.env.NSA_GATE_URL || null }) + '\n');
  const lines = fs.readFileSync(fixture, 'utf8').split('\n').filter(Boolean)
    .map((l) => l.split('{{SESSION}}').join(process.env.NSA_FAKE_SESSION || ''));
  if (stdin.includes('NSA_SLOW')) {
    console.log(lines[0] || '');
    setInterval(() => {}, 1000);
    return;
  }
  for (const l of lines) console.log(l);
  process.exit(0);
});
`;

/**
 * Chuẩn bị CLI giả cho một adapter: trả về `command` + `prefixArgs` để truyền vào adapter,
 * cùng biến môi trường cần đặt trước khi chạy.
 * `fixture` là các dòng ghi từ CLI thật; `{{SESSION}}` được thay bằng FAKE_SESSION.
 */
export function prepareFakeCli(name: string, fixture: string[]) {
  const dir = join(tmpdir(), `nsa-contract-${process.pid}`, name);
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'fake-cli.cjs');
  const fixtureFile = join(dir, 'fixture.jsonl');
  const log = join(dir, 'log.jsonl');
  writeFileSync(script, FAKE_CLI, 'utf8');
  writeFileSync(fixtureFile, fixture.join('\n'), 'utf8');
  writeFileSync(log, '', 'utf8');
  return {
    command: process.execPath,
    prefixArgs: [script, fixtureFile],
    log,
    env: { NSA_FAKE_LOG: log, NSA_FAKE_SESSION: FAKE_SESSION },
  };
}
