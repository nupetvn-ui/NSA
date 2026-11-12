import { truncate, type AgentEvent } from '@nsa/adapter-sdk';

/**
 * Chuyển đầu ra `agy --print --output-format stream-json` thành sự kiện chuẩn.
 *
 * CHƯA CHẠY THẬT (máy phát triển chưa cài Antigravity CLI). Định dạng lấy theo tài liệu chính
 * thức antigravity.google/docs/cli/headless: mỗi dòng có `event` = init | step_update | result,
 * phần thân nằm dưới khoá trùng tên sự kiện; mã phiên là `conversation_id`.
 */
export function createAntigravityParser(): (json: unknown) => AgentEvent[] {
  let announced = false;
  const toolsStarted = new Set<string>();

  return (json) => {
    if (!isRecord(json)) return [];
    const kind = json['event'];
    const body = isRecord(json[String(kind)])
      ? (json[String(kind)] as Record<string, unknown>)
      : {};
    const events: AgentEvent[] = [];
    const conversation = str(json['conversation_id']) ?? str(body['conversation_id']);
    if (!announced && conversation) {
      announced = true;
      events.push({ type: 'session', sessionId: conversation });
    }

    if (kind === 'step_update') {
      const index = String(body['step_index'] ?? '0');
      const stepType = body['step_type'];
      if (stepType === 'agent_response') {
        const delta = str(body['text_delta']);
        if (delta) events.push({ type: 'text', id: `step${index}`, text: delta });
      } else if (stepType === 'tool') {
        const info = isRecord(body['tool_info']) ? body['tool_info'] : {};
        const id = `step${index}`;
        if (!toolsStarted.has(id)) {
          toolsStarted.add(id);
          events.push({
            type: 'tool_call',
            id,
            name: str(info['name']) ?? str(body['tool_name']) ?? 'tool',
            input: summarize(info['parameters']),
          });
        }
        if (body['state'] === 'DONE') {
          const error = isRecord(info['error']) ? str(info['error']['message']) : undefined;
          events.push({
            type: 'tool_result',
            id,
            output: truncate(error ?? stringify(info['output'])),
            isError: error !== undefined,
          });
        }
      }
    } else if (kind === 'result') {
      const usage = isRecord(body['usage']) ? body['usage'] : {};
      events.push({
        type: 'usage',
        inputTokens: num(usage['input_tokens']) + num(usage['cache_read_tokens']),
        outputTokens: num(usage['output_tokens']) + num(usage['thinking_tokens']),
      });
      const status = body['status'];
      if (status !== undefined && status !== 'SUCCESS' && status !== 'CANCELED') {
        const err = body['error'];
        const message = isRecord(err) ? str(err['message']) : str(err);
        events.push({
          type: 'error',
          code: /auth/i.test(message ?? '') ? 'auth' : 'cli',
          message: message ?? `Antigravity kết thúc với trạng thái ${String(status)}`,
        });
      }
    }
    return events;
  };
}

function summarize(input: unknown): string {
  if (!isRecord(input)) return typeof input === 'string' ? input : '';
  for (const key of ['command', 'CommandLine', 'file_path', 'AbsolutePath', 'path', 'url']) {
    const value = input[key];
    if (typeof value === 'string' && value) return truncate(value, 500);
  }
  return truncate(JSON.stringify(input), 500);
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
