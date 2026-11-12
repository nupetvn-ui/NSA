import { truncate, type AgentEvent } from '@nsa/adapter-sdk';

/** Chuyển đầu ra `codex exec --json` thành sự kiện chuẩn. */
export function createCodexParser(): (json: unknown) => AgentEvent[] {
  return (json) => {
    if (!isRecord(json)) return [];

    switch (json['type']) {
      case 'thread.started':
        return typeof json['thread_id'] === 'string'
          ? [{ type: 'session', sessionId: json['thread_id'] }]
          : [];

      case 'item.started':
      case 'item.completed': {
        const item = json['item'];
        return isRecord(item) ? itemEvents(item, json['type'] === 'item.completed') : [];
      }

      case 'turn.completed': {
        const usage = json['usage'];
        if (!isRecord(usage)) return [];
        return [
          {
            type: 'usage',
            inputTokens: num(usage['input_tokens']),
            outputTokens: num(usage['output_tokens']) + num(usage['reasoning_output_tokens']),
          },
        ];
      }

      case 'turn.failed': {
        const error = json['error'];
        const message = isRecord(error) ? String(error['message'] ?? '') : '';
        return [{ type: 'error', message: explainError(message) }];
      }

      case 'error':
        return [{ type: 'error', message: explainError(String(json['message'] ?? '')) }];

      default:
        return [];
    }
  };
}

function itemEvents(item: Record<string, unknown>, completed: boolean): AgentEvent[] {
  const id = String(item['id'] ?? '');
  switch (item['type']) {
    case 'agent_message':
      return completed && typeof item['text'] === 'string' && item['text']
        ? [{ type: 'text', id, text: item['text'] }]
        : [];

    case 'command_execution': {
      if (!completed) {
        return [{ type: 'tool_call', id, name: 'shell', input: String(item['command'] ?? '') }];
      }
      const exitCode = item['exit_code'];
      return [
        {
          type: 'tool_result',
          id,
          output: truncate(String(item['aggregated_output'] ?? '')),
          isError: typeof exitCode === 'number' ? exitCode !== 0 : item['status'] === 'failed',
        },
      ];
    }

    case 'file_change': {
      if (!completed) return [];
      const changes = Array.isArray(item['changes']) ? (item['changes'] as unknown[]) : [];
      const summary = changes
        .map((c) => (isRecord(c) ? `${String(c['kind'] ?? 'sửa')} ${String(c['path'] ?? '')}` : ''))
        .filter(Boolean)
        .join('\n');
      return [
        { type: 'tool_call', id, name: 'edit', input: summary || 'sửa file' },
        { type: 'tool_result', id, output: '', isError: item['status'] === 'failed' },
      ];
    }

    case 'mcp_tool_call': {
      const name = `${String(item['server'] ?? 'mcp')}.${String(item['tool'] ?? '')}`;
      if (!completed) return [{ type: 'tool_call', id, name, input: '' }];
      return [{ type: 'tool_result', id, output: '', isError: item['status'] === 'failed' }];
    }

    case 'web_search':
      return completed
        ? [{ type: 'tool_call', id, name: 'web_search', input: String(item['query'] ?? '') }]
        : [];

    case 'error':
      return [{ type: 'error', message: String(item['message'] ?? 'Codex báo lỗi') }];

    default:
      // reasoning, todo_list… chưa hiển thị.
      return [];
  }
}

function explainError(raw: string): string {
  if (/login|unauthori[sz]ed|401/i.test(raw)) {
    return `Codex CLI chưa đăng nhập hoặc hết hạn đăng nhập. Mở terminal, chạy "codex login" rồi thử lại. (${raw})`;
  }
  return raw || 'Codex CLI báo lỗi nhưng không kèm nội dung.';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
