import { truncate, type AgentEvent, type AgentErrorCode } from '@nsa/adapter-sdk';

/**
 * Chuyển đầu ra `opencode run --format json` thành sự kiện chuẩn.
 * Định dạng ghi từ opencode 1.19.5 chạy thật: mỗi dòng có `type` (step_start, text, tool_use,
 * step_finish, error), `sessionID` và `part`. Văn bản tới một lần đủ cả khối (không stream).
 * Một lượt có thể có nhiều bước (step); token được cộng dồn qua các bước.
 */
export function createOpenCodeParser(): (json: unknown) => AgentEvent[] {
  let sessionAnnounced = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;

  return (json) => {
    if (!isRecord(json)) return [];
    const events: AgentEvent[] = [];
    const sessionId = json['sessionID'];
    if (!sessionAnnounced && typeof sessionId === 'string' && sessionId) {
      sessionAnnounced = true;
      events.push({ type: 'session', sessionId });
    }
    const part = isRecord(json['part']) ? json['part'] : {};

    switch (json['type']) {
      case 'text': {
        const text = part['text'];
        if (typeof text === 'string' && text) {
          events.push({ type: 'text', id: String(part['id'] ?? 'text'), text });
        }
        break;
      }

      case 'tool_use': {
        const state = isRecord(part['state']) ? part['state'] : {};
        const id = String(part['callID'] ?? part['id'] ?? 'tool');
        events.push({
          type: 'tool_call',
          id,
          name: String(part['tool'] ?? 'tool'),
          input: summarizeInput(state['input']),
        });
        const status = state['status'];
        if (status === 'completed' || status === 'error') {
          const output = status === 'error' ? state['error'] : state['output'];
          events.push({
            type: 'tool_result',
            id,
            output: truncate(typeof output === 'string' ? output : JSON.stringify(output ?? '')),
            isError: status === 'error',
          });
        }
        break;
      }

      case 'step_finish': {
        const tokens = isRecord(part['tokens']) ? part['tokens'] : {};
        const cache = isRecord(tokens['cache']) ? tokens['cache'] : {};
        inputTokens += num(tokens['input']) + num(cache['read']) + num(cache['write']);
        outputTokens += num(tokens['output']) + num(tokens['reasoning']);
        cost += num(part['cost']);
        events.push({
          type: 'usage',
          inputTokens,
          outputTokens,
          ...(cost > 0 ? { costUsd: cost } : {}),
        });
        break;
      }

      case 'error': {
        const error = isRecord(json['error']) ? json['error'] : {};
        const data = isRecord(error['data']) ? error['data'] : {};
        const name = String(error['name'] ?? '');
        const message = String(data['message'] ?? error['message'] ?? name ?? '');
        events.push({ type: 'error', ...explainError(name, message) });
        break;
      }
    }
    return events;
  };
}

function explainError(name: string, raw: string): { message: string; code: AgentErrorCode } {
  if (/ProviderAuth|api key|unauthori[sz]ed|401|credential/i.test(`${name} ${raw}`)) {
    return {
      code: 'auth',
      message: `OpenCode chưa có khoá cho nhà cung cấp model. Mở terminal, chạy "opencode auth login" rồi thử lại. (${raw})`,
    };
  }
  if (/required to use the free tier|UpgradeRequired|426/i.test(raw)) {
    return {
      code: 'auth',
      message: `Bản OpenCode quá cũ để dùng model miễn phí. Chạy "opencode upgrade" rồi thử lại. (${raw})`,
    };
  }
  return { code: 'cli', message: raw || 'OpenCode báo lỗi nhưng không kèm nội dung.' };
}

function summarizeInput(input: unknown): string {
  if (!isRecord(input)) return typeof input === 'string' ? input : '';
  for (const key of ['command', 'filePath', 'path', 'pattern', 'url', 'description']) {
    const value = input[key];
    if (typeof value === 'string' && value) return truncate(value, 500);
  }
  return truncate(JSON.stringify(input), 500);
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
