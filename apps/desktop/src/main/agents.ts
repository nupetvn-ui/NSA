import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter, AgentEvent } from '@nsa/adapter-sdk';
import type { CliAdapterFactories } from '@nsa/providers';
import { createAntigravityAdapter } from '@nsa/adapter-antigravity';
import { createClaudeAdapter } from '@nsa/adapter-claude';
import { createCodexAdapter } from '@nsa/adapter-codex';
import { createGeminiAdapter } from '@nsa/adapter-gemini';
import { createOpenCodeAdapter } from '@nsa/adapter-opencode';
import { createCustomCliAdapter, type CustomCliConfig } from '@nsa/adapter-pty';
import { createE2eAgent } from './e2e-agent';

/**
 * Cách tạo adapter của ba CLI có thể ghép với key của hãng (ProviderHub không import adapter,
 * ADR-0015): lắp ghép ở đây.
 */
export const cliAdapterFactories: CliAdapterFactories = {
  claude: (params) =>
    createClaudeAdapter({
      ...(params.command ? { command: params.command } : {}),
      ...(params.prefixArgs ? { prefixArgs: params.prefixArgs } : {}),
    }),
  codex: (params) => createCodexAdapter(params),
  opencode: (params) => createOpenCodeAdapter(params),
};

/**
 * Danh sách agent của bản Cá nhân. Thêm CLI mới: một gói adapter + một dòng ở đây.
 * CLI chưa có adapter riêng thì người dùng khai báo trong `custom-clis.json` (thư mục dữ liệu
 * của app) và NSA chạy nó qua adapter PTY chung.
 */
export function createAgents(userData: string): AgentAdapter[] {
  // Bài mở app tự động (ADR-0014): chỉ có agent giả, không đụng CLI thật trên máy.
  if (process.env['NSA_E2E_FAKE_AGENT'] === '1') return [createE2eAgent()];
  const adapters: AgentAdapter[] = [
    createClaudeAdapter(),
    createCodexAdapter(),
    createOpenCodeAdapter(),
    createGeminiAdapter(),
    createAntigravityAdapter(),
    ...loadCustomClis(join(userData, 'custom-clis.json')),
  ];
  return applySimulation(adapters, process.env['NSA_SIMULATE_BROKEN']);
}

function loadCustomClis(file: string): AgentAdapter[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (c): c is CustomCliConfig =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as CustomCliConfig).id === 'string' &&
        typeof (c as CustomCliConfig).command === 'string',
    )
    .map((c) => createCustomCliAdapter({ ...c, displayName: c.displayName || c.id }));
}

/**
 * Giả lập adapter hỏng để thử đường lùi tầng / đổi agent mà không phải phá CLI thật.
 * `NSA_SIMULATE_BROKEN=claude` → tầng chính của Claude lỗi giao thức (như khi CLI đổi định dạng);
 * `NSA_SIMULATE_BROKEN=claude:missing` → như chưa cài. Nhiều agent cách nhau bằng dấu phẩy.
 */
export function applySimulation(
  adapters: AgentAdapter[],
  spec: string | undefined,
): AgentAdapter[] {
  if (!spec) return adapters;
  const rules = new Map(
    spec.split(',').map((s) => {
      const [id = '', mode = 'protocol'] = s.trim().split(':');
      return [id, mode === 'missing' ? 'not_installed' : 'protocol'] as const;
    }),
  );
  return adapters.map((adapter) => {
    const code = rules.get(adapter.id);
    if (!code) return adapter;
    console.warn(`[nsa] Giả lập ${adapter.id} hỏng (${code})`);
    const broken: AgentAdapter = {
      id: adapter.id,
      displayName: adapter.displayName,
      detect: () => adapter.detect(),
      capabilities: () => adapter.capabilities(),
      ...(code === 'protocol' && adapter.fallback ? { fallback: adapter.fallback } : {}),
      ...(adapter.fingerprint ? { fingerprint: adapter.fingerprint.bind(adapter) } : {}),
      run(_options, onEvent) {
        const events: AgentEvent[] = [
          {
            type: 'error',
            code,
            message:
              code === 'protocol'
                ? `[giả lập] Không đọc được đầu ra của ${adapter.displayName}. CLI có thể vừa đổi định dạng.`
                : `[giả lập] Không tìm thấy lệnh của ${adapter.displayName}.`,
          },
          { type: 'done', cancelled: false },
        ];
        setTimeout(() => events.forEach(onEvent), 50);
        return { cancel: () => undefined, finished: new Promise((r) => setTimeout(r, 60)) };
      },
    };
    return broken;
  });
}
