import { describe, expect, it } from 'vitest';
import {
  ToolGateServer,
  type AgentAdapter,
  type AgentEvent,
  type Capabilities,
  type RunOptions,
} from '@nsa/adapter-sdk';
import {
  AUTO_AGENT,
  ChatService,
  describeChange,
  detectCliChanges,
  localIdentity,
  memoryAuditLog,
  personalPolicy,
  planRoute,
  type ChatServiceOptions,
  type Conversation,
  type Policy,
  type SendResult,
  type StoredFingerprint,
} from './index.js';

const CAPS: Capabilities = {
  streaming: false,
  resume: true,
  tools: true,
  editFiles: true,
  images: false,
  mcp: false,
  subagents: false,
  toolGate: false,
  tier: 'headless',
};

type Script = (options: RunOptions, emit: (e: AgentEvent) => void) => void;

/** Adapter giả chạy theo kịch bản; ghi lại các lần được gọi. */
function scripted(
  id: string,
  script: Script,
  extra: Partial<AgentAdapter> & { caps?: Partial<Capabilities> } = {},
) {
  const calls: RunOptions[] = [];
  const adapter: AgentAdapter = {
    id,
    displayName: id.toUpperCase(),
    detect: () => Promise.resolve({ installed: true, ready: true, version: '1' }),
    capabilities: () => ({ ...CAPS, ...extra.caps }),
    run(options, onEvent) {
      calls.push(options);
      script(options, onEvent);
      return { cancel: () => undefined, finished: Promise.resolve() };
    },
    ...(extra.fallback ? { fallback: extra.fallback } : {}),
  };
  return { adapter, calls };
}

const reply =
  (text: string, session?: string): Script =>
  (_o, emit) => {
    if (session) emit({ type: 'session', sessionId: session });
    emit({ type: 'text', id: 'm', text });
    emit({ type: 'done', cancelled: false });
  };

const fail =
  (code: 'protocol' | 'not_installed' | 'auth' | 'cli', message = 'hỏng'): Script =>
  (_o, emit) => {
    emit({ type: 'error', code, message });
    emit({ type: 'done', cancelled: false });
  };

const allowAll: Policy = { check: () => ({ decision: 'allow' }) };
const identity = localIdentity('tester');

function service(options: Partial<ChatServiceOptions> & Pick<ChatServiceOptions, 'adapters'>) {
  return new ChatService({ identity, policy: allowAll, ...options });
}

function started(result: SendResult) {
  if (result.status !== 'started') throw new Error(`mong đợi started, nhận ${result.status}`);
  return result;
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('planRoute — bộ định tuyến theo năng lực', () => {
  const agents = [
    { id: 'claude', capabilities: { ...CAPS, toolGate: true } },
    { id: 'codex', capabilities: CAPS },
    { id: 'ro', capabilities: { ...CAPS, editFiles: false } },
    {
      id: 'gone',
      capabilities: CAPS,
      status: { installed: false, ready: false, note: 'chưa cài' },
    },
  ];

  it('ưu tiên agent người dùng chọn, loại agent thiếu năng lực hoặc chưa cài', () => {
    const plan = planRoute(agents, { preferred: 'codex', needs: ['editFiles'] });
    expect(plan.candidates).toEqual(['codex', 'claude']);
    expect(plan.rejected.map((r) => r.id).sort()).toEqual(['gone', 'ro']);
  });

  it('tự chọn: ưu tiên agent chặn được từng lệnh; bỏ agent đã hỏng', () => {
    expect(planRoute(agents, {}).candidates[0]).toBe('claude');
    expect(planRoute(agents, { exclude: ['claude'] }).candidates[0]).toBe('codex');
  });
});

describe('ba tầng tự lùi + đổi agent', () => {
  it('tầng chính hỏng giao thức → lùi xuống tầng PTY, báo người dùng, ghi nhật ký', async () => {
    const pty = scripted('claude', reply('trả lời từ tầng PTY'), {
      caps: { tier: 'pty', resume: false },
    });
    const main = scripted('claude', fail('protocol', 'Không đọc được đầu ra'), {
      fallback: pty.adapter,
    });
    const audit = memoryAuditLog();
    const chat = service({ adapters: [main.adapter], audit });
    started(await chat.send({ agentId: 'claude', prompt: 'xin chào', cwd: 'D:/p' }));
    await settle();

    const turn = chat.listConversations()[0]?.turns[0];
    expect(turn?.status).toBe('done');
    expect(turn?.errors).toEqual([]);
    expect(turn?.parts.map((p) => p.kind)).toEqual(['notice', 'text']);
    expect(pty.calls[0]?.prompt).toContain('xin chào');
    expect(audit.entries.find((e) => e.type === 'fallback')).toMatchObject({
      kind: 'tier',
      from: 'claude:headless',
      to: 'claude:pty',
    });
  });

  it('agent chưa cài → đổi sang agent khác, mỗi lần đổi đều qua chính sách', async () => {
    const gone = scripted('claude', fail('not_installed', 'Không tìm thấy lệnh claude'));
    const ok = scripted('codex', reply('Codex làm giúp'));
    const checked: string[] = [];
    const policy: Policy = {
      check: ({ action }) => {
        checked.push(action.agentId);
        return { decision: 'allow' };
      },
    };
    const audit = memoryAuditLog();
    const chat = service({ adapters: [gone.adapter, ok.adapter], policy, audit });
    const result = started(await chat.send({ agentId: 'claude', prompt: 'việc', cwd: 'D:/p' }));
    await settle();

    const turn = chat.listConversations()[0]?.turns[0];
    expect(result.agentId).toBe('claude');
    expect(turn?.agentId).toBe('codex');
    expect(turn?.status).toBe('done');
    expect(checked).toEqual(['claude', 'codex']);
    expect(audit.entries.find((e) => e.type === 'fallback')).toMatchObject({
      kind: 'agent',
      from: 'claude',
      to: 'codex',
    });
  });

  it('chính sách chặn agent dự phòng thì KHÔNG chạy nó, lượt báo lỗi chứ không treo', async () => {
    const gone = scripted('claude', fail('not_installed'));
    const other = scripted('codex', reply('x'));
    const policy: Policy = {
      check: ({ action }) =>
        action.agentId === 'codex'
          ? { decision: 'deny', reason: 'cấm codex' }
          : { decision: 'allow' },
    };
    const chat = service({ adapters: [gone.adapter, other.adapter], policy });
    started(await chat.send({ agentId: 'claude', prompt: 'việc', cwd: 'D:/p' }));
    await settle();
    expect(other.calls).toHaveLength(0);
    const turn = chat.listConversations()[0]?.turns[0];
    expect(turn?.status).toBe('error');
    expect(turn?.parts.some((p) => p.kind === 'notice' && p.text.includes('cấm codex'))).toBe(true);
  });

  it('agent đã trả lời được một phần rồi mới lỗi thì không chạy lại ở agent khác', async () => {
    const partial = scripted('claude', (_o, emit) => {
      emit({ type: 'text', id: 'm', text: 'đang làm…' });
      emit({ type: 'error', code: 'cli', message: 'mất mạng' });
      emit({ type: 'done', cancelled: false });
    });
    const other = scripted('codex', reply('x'));
    const chat = service({ adapters: [partial.adapter, other.adapter] });
    started(await chat.send({ agentId: 'claude', prompt: 'việc', cwd: 'D:/p' }));
    await settle();
    expect(other.calls).toHaveLength(0);
    expect(chat.listConversations()[0]?.turns[0]?.status).toBe('error');
  });

  it('tắt tự đổi agent thì chỉ báo lỗi', async () => {
    const gone = scripted('claude', fail('not_installed'));
    const other = scripted('codex', reply('x'));
    const chat = service({ adapters: [gone.adapter, other.adapter] });
    started(await chat.send({ agentId: 'claude', prompt: 'v', cwd: '.', autoSwitch: false }));
    await settle();
    expect(other.calls).toHaveLength(0);
  });

  it('"Tự chọn" chọn agent đủ năng lực cho quyền sửa file', async () => {
    const ro = scripted('ro', reply('x'), { caps: { editFiles: false } });
    const rw = scripted('rw', reply('y'));
    const chat = service({ adapters: [ro.adapter, rw.adapter] });
    const result = started(
      await chat.send({ agentId: AUTO_AGENT, prompt: 'sửa', cwd: '.', permission: 'edit' }),
    );
    expect(result.agentId).toBe('rw');
    expect(ro.calls).toHaveLength(0);
  });

  it('đổi agent giữa chừng vẫn giữ ngữ cảnh: agent dự phòng nhận các lượt trước', async () => {
    let claudeOk = true;
    const claude = scripted('claude', (o, emit) =>
      claudeOk
        ? reply('Kế hoạch: bước A', 'c-1')(o, emit)
        : fail('auth', 'hết hạn đăng nhập')(o, emit),
    );
    const codex = scripted('codex', reply('Đã làm bước A'));
    const chat = service({ adapters: [claude.adapter, codex.adapter] });
    const first = started(await chat.send({ agentId: 'claude', prompt: 'Lập kế hoạch', cwd: '.' }));
    claudeOk = false;
    await chat.send({
      conversationId: first.conversationId,
      agentId: 'claude',
      prompt: 'Làm bước A',
    });
    await settle();
    expect(codex.calls[0]?.prompt).toContain('Kế hoạch: bước A');
    expect(codex.calls[0]?.prompt).toContain('Làm bước A');
  });
});

describe('cổng chính sách từng lệnh', () => {
  /** Adapter giả có cổng: trước "lệnh" thì hỏi cổng như móc thật của CLI. */
  function gated(commands: string[]) {
    const results: { command: string; allowed: boolean; reason?: string }[] = [];
    const adapter: AgentAdapter = {
      ...scripted('claude', () => undefined).adapter,
      capabilities: () => ({ ...CAPS, toolGate: true }),
      run(options, onEvent) {
        const finished = (async () => {
          for (const command of commands) {
            const res = await fetch(options.gate?.url ?? 'http://127.0.0.1:1/', {
              method: 'POST',
              headers: { 'x-nsa-token': options.gate?.token ?? '' },
              body: JSON.stringify({ tool: 'Bash', input: { command } }),
            });
            const v = (await res.json()) as { allow: boolean; reason?: string };
            results.push({ command, allowed: v.allow, ...(v.reason ? { reason: v.reason } : {}) });
            onEvent({ type: 'tool_call', id: command, name: 'Bash', input: command });
          }
          onEvent({ type: 'done', cancelled: false });
        })();
        return { cancel: () => undefined, finished };
      },
    };
    return { adapter, results };
  }

  it('chặn lệnh phá huỷ, cho lệnh thường, ghi nhật ký từng lệnh', async () => {
    const gate = await ToolGateServer.start();
    const audit = memoryAuditLog();
    const fake = gated(['ls', 'rm -rf /']);
    const chat = service({ adapters: [fake.adapter], gate, audit, policy: personalPolicy() });
    started(await chat.send({ agentId: 'claude', prompt: 'dọn', cwd: '.' }));
    await new Promise((r) => setTimeout(r, 300));
    await gate.close();

    expect(fake.results.map((r) => [r.command, r.allowed])).toEqual([
      ['ls', true],
      ['rm -rf /', false],
    ]);
    const toolDecisions = audit.entries.flatMap((e) =>
      e.type === 'policy' && e.tool ? [[e.tool.input, e.decision]] : [],
    );
    expect(toolDecisions).toEqual([
      ['ls', 'allow'],
      ['rm -rf /', 'deny'],
    ]);
  });

  it('lệnh rủi ro thì hỏi người dùng giữa lượt; từ chối thì CLI nhận "chặn"', async () => {
    const gate = await ToolGateServer.start();
    const fake = gated(['git push origin main']);
    let chat: ChatService | undefined = undefined;
    chat = service({
      adapters: [fake.adapter],
      gate,
      policy: personalPolicy(),
      onEvent: ({ event }) => {
        if (event.type === 'ask_permission') chat?.answerPermission(event.id, false);
      },
    });
    started(await chat.send({ agentId: 'claude', prompt: 'đẩy mã', cwd: '.' }));
    await new Promise((r) => setTimeout(r, 300));
    await gate.close();
    expect(fake.results[0]).toMatchObject({ allowed: false });
    const parts = chat.listConversations()[0]?.turns[0]?.parts ?? [];
    expect(parts.find((p) => p.kind === 'permission')).toMatchObject({ state: 'denied' });
  });

  it('mã lượt đã hết hạn thì cổng luôn chặn', async () => {
    const gate = await ToolGateServer.start();
    const { endpoint, dispose } = gate.register(() => Promise.resolve({ allow: true }));
    dispose();
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: { 'x-nsa-token': endpoint.token },
      body: '{"tool":"Bash","input":{}}',
    });
    expect(((await res.json()) as { allow: boolean }).allow).toBe(false);
    await gate.close();
  });
});

describe('phát hiện CLI thay đổi', () => {
  it('lần đầu chỉ ghi nhận; lần sau báo đổi phiên bản kèm dòng --help mới', async () => {
    let saved: Record<string, StoredFingerprint> = {};
    const store = {
      load: () => saved,
      save: (d: Record<string, StoredFingerprint>) => (saved = d),
    };
    let fp = { version: '1.0.0', help: 'Usage: x\n  --print' };
    const adapter: AgentAdapter = {
      ...scripted('claude', () => undefined).adapter,
      fingerprint: () => Promise.resolve(fp),
    };
    expect(await detectCliChanges([adapter], store)).toEqual([]);
    expect(await detectCliChanges([adapter], store)).toEqual([]);
    fp = { version: '1.1.0', help: 'Usage: x\n  --print\n  --new-flag' };
    const changes = await detectCliChanges([adapter], store);
    expect(changes).toEqual([
      expect.objectContaining({
        kind: 'version',
        before: '1.0.0',
        after: '1.1.0',
        helpDiff: ['+ --new-flag'],
      }),
    ]);
    expect(describeChange(changes[0] as (typeof changes)[number])).toContain('1.0.0 → 1.1.0');
  });
});

describe('khôi phục', () => {
  it('cuộc trò chuyện cũ (chưa có trường mới) vẫn nạp được', () => {
    const old: Conversation = {
      id: 'c',
      title: 't',
      cwd: '.',
      permission: 'read-only',
      createdAt: '',
      updatedAt: '',
      sessions: {},
      turns: [],
    };
    const chat = service({ adapters: [], store: { load: () => [old], save: () => undefined } });
    expect(chat.listConversations()).toHaveLength(1);
  });
});
