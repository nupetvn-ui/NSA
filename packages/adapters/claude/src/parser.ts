import { truncate, type AgentEvent } from '@nsa/adapter-sdk';

/**
 * Chuyển đầu ra `claude -p --output-format stream-json --verbose --include-partial-messages`
 * thành sự kiện chuẩn. Có trạng thái: nhớ khối văn bản nào đã stream từng phần
 * để không lặp lại khi bản đầy đủ của tin nhắn tới.
 */
export function createClaudeParser(): (json: unknown) => AgentEvent[] {
  let currentMessageId = '';
  const streamedBlocks = new Set<string>();
  let sessionAnnounced = false;

  return (json) => {
    if (!isRecord(json)) return [];
    const events: AgentEvent[] = [];

    const sessionId = json['session_id'];
    if (!sessionAnnounced && typeof sessionId === 'string' && sessionId) {
      sessionAnnounced = true;
      events.push({ type: 'session', sessionId });
    }

    // Bỏ qua tin nhắn của agent con (Task) — chỉ hiện luồng chính.
    if (json['parent_tool_use_id'] != null) return events;

    switch (json['type']) {
      case 'stream_event': {
        const ev = json['event'];
        if (!isRecord(ev)) break;
        if (ev['type'] === 'message_start' && isRecord(ev['message'])) {
          currentMessageId = String(ev['message']['id'] ?? '');
        } else if (ev['type'] === 'content_block_delta' && isRecord(ev['delta'])) {
          const delta = ev['delta'];
          if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
            const id = `${currentMessageId}:${String(ev['index'])}`;
            streamedBlocks.add(id);
            events.push({ type: 'text', id, text: delta['text'] });
          }
        }
        break;
      }

      case 'assistant': {
        const message = json['message'];
        if (!isRecord(message) || !Array.isArray(message['content'])) break;
        const messageId = String(message['id'] ?? '');
        message['content'].forEach((block: unknown, index: number) => {
          if (!isRecord(block)) return;
          if (block['type'] === 'text' && typeof block['text'] === 'string') {
            const id = `${messageId}:${index}`;
            if (!streamedBlocks.has(id) && block['text']) {
              events.push({ type: 'text', id, text: block['text'] });
            }
          } else if (block['type'] === 'tool_use') {
            events.push({
              type: 'tool_call',
              id: String(block['id'] ?? `${messageId}:${index}`),
              name: String(block['name'] ?? 'tool'),
              input: summarizeInput(block['input']),
            });
          }
        });
        break;
      }

      case 'user': {
        const message = json['message'];
        if (!isRecord(message) || !Array.isArray(message['content'])) break;
        for (const block of message['content'] as unknown[]) {
          if (!isRecord(block) || block['type'] !== 'tool_result') continue;
          events.push({
            type: 'tool_result',
            id: String(block['tool_use_id'] ?? ''),
            output: truncate(contentToText(block['content'])),
            isError: block['is_error'] === true,
          });
        }
        break;
      }

      case 'result': {
        const usage = json['usage'];
        if (isRecord(usage)) {
          const cost = json['total_cost_usd'];
          events.push({
            type: 'usage',
            inputTokens:
              num(usage['input_tokens']) +
              num(usage['cache_read_input_tokens']) +
              num(usage['cache_creation_input_tokens']),
            outputTokens: num(usage['output_tokens']),
            ...(typeof cost === 'number' && cost > 0 ? { costUsd: cost } : {}),
          });
        }
        if (json['is_error'] === true) {
          events.push({ type: 'error', message: explainError(String(json['result'] ?? '')) });
        }
        break;
      }
    }
    return events;
  };
}

function explainError(raw: string): string {
  if (/not logged in|\/login/i.test(raw)) {
    return 'Claude CLI chưa đăng nhập. Mở terminal, chạy "claude auth login" rồi thử lại.';
  }
  return raw || 'Claude CLI báo lỗi nhưng không kèm nội dung.';
}

function summarizeInput(input: unknown): string {
  if (!isRecord(input)) return '';
  // Các trường hay gặp nhất của công cụ Claude Code, hiện ngắn gọn cho người đọc.
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'description']) {
    const value = input[key];
    if (typeof value === 'string' && value) return truncate(value, 500);
  }
  return truncate(JSON.stringify(input), 500);
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        isRecord(part) && typeof part['text'] === 'string'
          ? part['text']
          : '[nội dung không phải văn bản]',
      )
      .join('\n');
  }
  return '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
