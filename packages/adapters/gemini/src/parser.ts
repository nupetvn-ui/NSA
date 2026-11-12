import { truncate, type AgentEvent } from '@nsa/adapter-sdk';

/**
 * Chuyển đầu ra `gemini -p … --output-format stream-json` thành sự kiện chuẩn.
 *
 * CHƯA CHẠY THẬT với tài khoản đã đăng nhập (máy phát triển chưa có xác thực Gemini).
 * Loại sự kiện lấy theo tài liệu chính thức (geminicli.com/docs/cli/headless): init, message,
 * tool_use, tool_result, error, result. Tên trường lấy theo mã nguồn gemini-cli và được đọc
 * phòng thủ (thử nhiều tên) — bộ test hợp đồng hằng đêm sẽ báo nếu sai.
 */
export function createGeminiParser(): (json: unknown) => AgentEvent[] {
  let message = 0;
  let lastRole = '';
  return (json) => {
    if (!isRecord(json)) return [];
    switch (json['type']) {
      case 'init': {
        const id = str(json['session_id']) ?? str(json['sessionId']);
        return id ? [{ type: 'session', sessionId: id }] : [];
      }
      case 'message': {
        const role = str(json['role']) ?? 'assistant';
        if (role !== 'assistant') {
          lastRole = role;
          return [];
        }
        if (lastRole !== 'assistant') message++;
        lastRole = role;
        const text = str(json['content']) ?? str(json['text']);
        return text ? [{ type: 'text', id: `m${message}`, text }] : [];
      }
      case 'tool_use': {
        lastRole = 'tool';
        const id = str(json['tool_id']) ?? str(json['id']) ?? 'tool';
        return [
          {
            type: 'tool_call',
            id,
            name: str(json['tool_name']) ?? str(json['name']) ?? 'tool',
            input: summarize(json['parameters'] ?? json['args']),
          },
        ];
      }
      case 'tool_result': {
        const id = str(json['tool_id']) ?? str(json['id']) ?? 'tool';
        const error = isRecord(json['error']) ? str(json['error']['message']) : undefined;
        const failed = json['status'] === 'error' || error !== undefined;
        return [
          {
            type: 'tool_result',
            id,
            output: truncate(error ?? str(json['output']) ?? ''),
            isError: failed,
          },
        ];
      }
      case 'error': {
        if (json['severity'] === 'warning') return [];
        return [
          { type: 'error', code: 'cli', message: str(json['message']) ?? 'Gemini CLI báo lỗi' },
        ];
      }
      case 'result': {
        const events: AgentEvent[] = [];
        const stats = isRecord(json['stats']) ? json['stats'] : {};
        const input = num(stats['input_tokens']);
        const output = num(stats['output_tokens']);
        if (input || output)
          events.push({ type: 'usage', inputTokens: input, outputTokens: output });
        if (json['status'] === 'error') {
          const err = isRecord(json['error']) ? str(json['error']['message']) : undefined;
          events.push({ type: 'error', code: 'cli', message: err ?? 'Gemini CLI báo lỗi' });
        }
        return events;
      }
      default:
        return [];
    }
  };
}

function summarize(input: unknown): string {
  if (!isRecord(input)) return typeof input === 'string' ? input : '';
  for (const key of ['command', 'file_path', 'absolute_path', 'path', 'pattern', 'url']) {
    const value = input[key];
    if (typeof value === 'string' && value) return truncate(value, 500);
  }
  return truncate(JSON.stringify(input), 500);
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
