import type { AgentAdapter } from '@nsa/adapter-sdk';

/**
 * Agent giả cho bài mở app tự động (G2, ADR-0014): trả lời cố định, không cần CLI hay key thật.
 * Chỉ được bật khi đặt `NSA_E2E_FAKE_AGENT=1`; khi đó nó THAY toàn bộ danh sách agent thật.
 */
export const E2E_REPLY = 'Xin chào từ agent giả của bài kiểm thử.';

export function createE2eAgent(): AgentAdapter {
  return {
    id: 'e2e',
    displayName: 'Agent giả (E2E)',
    detect: () => Promise.resolve({ installed: true, ready: true, version: 'e2e' }),
    capabilities: () => ({
      streaming: false,
      resume: true,
      tools: true,
      editFiles: true,
      images: false,
      mcp: false,
      subagents: false,
      toolGate: false,
      tier: 'headless' as const,
    }),
    run(_options, onEvent) {
      setTimeout(() => {
        onEvent({ type: 'session', sessionId: 'e2e-session' });
        onEvent({ type: 'text', id: 'm1', text: E2E_REPLY });
        onEvent({ type: 'done', cancelled: false });
      }, 30);
      return { cancel: () => undefined, finished: new Promise((r) => setTimeout(r, 60)) };
    },
  };
}
